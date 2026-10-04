import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { SmartError } from './errors.js';
import { TrustStore, trustStorePath, type TrustCheck } from './store/trust.js';
import { EFFORTS } from './types.js';

const tier = z.enum(['haiku', 'sonnet', 'opus']);
const effort = z.enum(EFFORTS);

const validRegex = (s: string): boolean => {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
};

/**
 * A model name is passed to `claude --model <name>` as its own argument. Aliases (`sonnet`), full ids (`claude-opus-4-1`),
 * context suffixes (`claude-sonnet-4-5[1m]`) and provider ids (`us.anthropic.…`, Bedrock ARNs) fit; a value starting with `-`
 * (which a CLI parser could read as another flag) or holding spaces or control characters does not.
 */
const modelName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/, 'not a model name (letters, digits and . _ : @ / [ ] -, not starting with -)');

/** Permission modes, least permissive first. A project file may tighten the mode, never loosen it (see gateProjectConfig). */
export const PERMISSION_MODES = ['plan', 'dontAsk', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
const PERMISSION_RANK: Record<PermissionMode, number> = { plan: 0, dontAsk: 1, manual: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
export const permissionRank = (mode: string): number => PERMISSION_RANK[mode as PermissionMode] ?? PERMISSION_RANK.bypassPermissions;

const ConfigSchema = z.object({
  // Each field has its own default, so overriding one model (`{"models":{"opus":"claude-opus-4-1"}}`) is valid.
  models: z
    .object({ haiku: modelName.default('haiku'), sonnet: modelName.default('sonnet'), opus: modelName.default('opus') })
    .prefault({}),
  routing: z
    .object({
      /**
       * How the rater trades cost against quality: `cost` needs stronger evidence before it uses a bigger model or higher effort,
       * `quality` needs less. The per-complexity tiers below are floors the rater never goes under.
       */
      optimize: z.enum(['cost', 'balanced', 'quality']).default('balanced'),
      /** Skip the classifier call for clearly routine edits ("fix the typo", "rename x"): saves a whole call, about 5 s. */
      fastLane: z.boolean().default(true),
      trivial: tier.default('haiku'),
      small_edit: tier.default('sonnet'),
      multi_file: tier.default('sonnet'),
      large_build: tier.default('sonnet'),
      /** Plans big builds and hard tasks. */
      planner: tier.default('opus'),
      /** Plans everything else that needs a plan (mid-size, multi-part changes): Sonnet is plenty and about 2x cheaper. */
      plannerLight: tier.default('sonnet'),
      classifier: tier.default('haiku'),
      reviewer: tier.default('haiku'),
      keywordRules: z.array(z.object({ match: z.string().min(1).refine(validRegex, 'invalid regular expression'), tier })).default([
        { match: 'architecture|race condition|deadlock', tier: 'opus' },
      ]),
    })
    .prefault({}),
  escalation: z
    .object({
      retriesPerModel: z.number().int().min(0).max(5).default(1),
      ladder: z.array(tier).min(1).default(['haiku', 'sonnet', 'opus']),
    })
    .prefault({}),
  limits: z
    .object({
      maxPlanSteps: z.number().int().min(1).max(30).default(6),
      maxContextBytes: z.number().int().min(0).default(40_000),
      maxBudgetUsdPerStep: z.number().positive().nullable().default(null),
      /** Stop the task once its total cost reaches this many dollars. */
      maxBudgetUsdPerTask: z.number().positive().nullable().default(null),
    })
    .prefault({}),
  session: z
    .object({
      /** Keep one Claude Code session per conversation (--resume) so follow-ups have real history. */
      resume: z.boolean().default(true),
      /** How long Anthropic's prompt cache stays warm after a call; used to decide whether switching models is worth it. */
      cacheTtlSec: z.number().int().min(0).default(300),
      /** While the cache is warm, never downgrade to a cheaper model (it would re-read the history at full price). */
      keepWarmTier: z.boolean().default(true),
      /**
       * Once the Claude Code session has grown past this many tokens, the next task starts a fresh one with a summary of the
       * conversation: every turn of every step re-reads the whole session, so a long chat makes each step cost more. 0 = never.
       */
      maxContextTokens: z.number().int().min(0).default(80_000),
    })
    .prefault({}),
  runner: z
    .object({
      /**
       * How much Claude Code may do without asking. `acceptEdits` (default): edit files; other tools (shell commands) only
       * where your Claude Code permission rules allow them. `bypassPermissions`: anything, unasked; choose it on purpose.
       */
      permissionMode: z.enum(PERMISSION_MODES).default('acceptEdits'),
      bare: z.boolean().default(false),
      /** Classify, plan and review calls have no tools, so they skip hooks, plugins and MCP servers (faster start-up). */
      leanCalls: z.boolean().default(true),
      /** Keep one `claude` process running per conversation for coding steps, so a step does not wait for Claude Code to start. */
      keepAlive: z.boolean().default(true),
      /** Pick the thinking effort per step from the task (cheap for easy work, more for hard). An explicit `effort` below wins. */
      autoEffort: z.boolean().default(true),
      extraArgs: z.array(z.string()).default([]),
      /** Optional `--effort` level per model tier, e.g. { "haiku": "low", "opus": "high" }. Unset = Claude Code default. */
      effort: z.object({ haiku: effort.optional(), sonnet: effort.optional(), opus: effort.optional() }).default({}),
    })
    .prefault({}),
  verify: z
    .object({
      auto: z.boolean().default(true),
      commands: z.array(z.string()).default([]),
      timeoutSec: z.number().int().min(5).default(300),
      /** Run the detected `test` script after every plan step. Off: earlier steps get the quick checks, the last step the tests too. */
      testEveryStep: z.boolean().default(false),
    })
    .prefault({}),
  review: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  usage: z
    .object({
      /** Stop automatically choosing Opus once any account usage window reaches this share (0..1). 0 disables. */
      downshiftAt: z.number().min(0).max(1).default(0.9),
      /** Warn once when a window first reaches this share (0..1). 0 disables. */
      warnAt: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),
  trackerPath: z.string().default('~/.smart/history.json'),
  conversationsPath: z.string().default('~/.smart/conversations.json'),
  limitsPath: z.string().default('~/.smart/limits.json'),
  historyPath: z.string().default('~/.smart/input-history.json'),
});

export type SmartConfig = z.infer<typeof ConfigSchema>;

export const defaultConfig = (): SmartConfig => ConfigSchema.parse({});

/** `~`, `~/x` and `~\\x` mean the home directory; `~foo` is an ordinary relative name. */
export const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : resolve(p));

/** Your own config for every project. */
export const globalConfigPath = (home: string = homedir()): string => join(home, '.smart', 'smart.config.json');

export interface LoadedConfig {
  config: SmartConfig;
  /** The highest-priority file that was read (the project's, else your global one), or null when defaults are used. */
  source: string | null;
  /** Every file that was read, lowest priority first: your global config, then the project's (or `--config`). */
  sources: string[];
  /** Things worth telling the user: unknown (probably misspelled) keys, and settings ignored from an untrusted project file. */
  warnings: string[];
  /** Informational: settings from a trusted project file that loosen your own config. */
  notices: string[];
}

/** Settings that used to exist: still accepted silently so old config files do not warn. */
const REMOVED_KEYS = new Set(['pricing']);
/** JSON has no comments, so `"//": "..."` (and `$schema`) are allowed anywhere as notes. */
const isNote = (k: string): boolean => k.startsWith('//') || k.startsWith('$');

function unknownKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const known = defaultConfig() as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (REMOVED_KEYS.has(k) || isNote(k)) continue;
    if (!(k in known)) {
      out.push(k);
      continue;
    }
    const section = known[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof section === 'object' && section !== null && !Array.isArray(section)) {
      for (const sub of Object.keys(v)) if (!isNote(sub) && !(sub in (section as Record<string, unknown>))) out.push(`${k}.${sub}`);
    }
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `over` on top of `base`: objects merge key by key, anything else (values, arrays, null) replaces. */
export function mergeConfig(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeConfig(base[k], v);
  return out;
}

function readConfigFile(path: string): { raw: unknown; text: string } {
  let raw: unknown;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
    raw = JSON.parse(text);
  } catch (e) {
    throw new SmartError('config', `Could not parse ${path}: ${(e as Error).message}`);
  }
  // Each file must be valid on its own, so an error names the file it is in.
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SmartError('config', `Invalid config in ${path}: ${issues}`);
  }
  return { raw, text };
}

/**
 * Settings that cross a trust boundary: they run commands, pass flags to Claude Code, widen what it may do unasked, move where
 * smart writes your data, or lift a spending cap. `loosens(project, base)` says whether the project's value is less safe than
 * the one from your own config (or the default).
 */
interface Sensitive {
  path: [string, string] | [string];
  /** What the setting would do, for the warning. */
  risk: (value: unknown) => string;
  loosens: (project: unknown, base: unknown) => boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const differs = (project: unknown, base: unknown): boolean => !same(project, base);
const list = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(' ') : String(v));
/** A cap is lifted when the project removes it or raises it. */
const liftsCap = (project: unknown, base: unknown): boolean => typeof base === 'number' && (project === null || (typeof project === 'number' && project > base));

const SENSITIVE: Sensitive[] = [
  { path: ['verify', 'commands'], risk: (v) => `runs shell commands: ${(v as string[]).join('; ')}`, loosens: (p, b) => Array.isArray(p) && p.length > 0 && differs(p, b) },
  { path: ['verify', 'auto'], risk: () => 'runs the project\'s package.json scripts after each step', loosens: (p, b) => p === true && b === false },
  { path: ['runner', 'permissionMode'], risk: (v) => `lets Claude Code act with ${String(v)}`, loosens: (p, b) => typeof p === 'string' && permissionRank(p) > permissionRank(String(b)) },
  { path: ['runner', 'extraArgs'], risk: (v) => `passes extra flags to Claude Code: ${list(v)}`, loosens: (p, b) => Array.isArray(p) && p.length > 0 && differs(p, b) },
  { path: ['runner', 'bare'], risk: () => 'starts Claude Code with --bare (skips your hooks and settings)', loosens: (p, b) => p === true && b !== true },
  { path: ['limits', 'maxBudgetUsdPerTask'], risk: (v) => `lifts your task budget (to ${v === null ? 'none' : `$${String(v)}`})`, loosens: liftsCap },
  { path: ['limits', 'maxBudgetUsdPerStep'], risk: (v) => `lifts your step budget (to ${v === null ? 'none' : `$${String(v)}`})`, loosens: liftsCap },
  ...(['trackerPath', 'conversationsPath', 'limitsPath', 'historyPath'] as const).map((k): Sensitive => ({
    path: [k], risk: (v) => `writes your prompts and history to ${String(v)}`, loosens: (p, b) => typeof p === 'string' && expandHome(p) !== expandHome(String(b)),
  })),
];

const getAt = (obj: unknown, path: readonly string[]): unknown => path.reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
const hasAt = (obj: unknown, path: readonly string[]): boolean => {
  const parent = getAt(obj, path.slice(0, -1));
  return isPlainObject(parent) && Object.hasOwn(parent, path.at(-1)!);
};

/** A deep copy of `raw` without the setting at `path`. */
function withoutAt(raw: unknown, path: readonly string[]): unknown {
  if (!isPlainObject(raw)) return raw;
  const [head, ...rest] = path;
  const out = { ...raw };
  if (rest.length === 0) delete out[head!];
  else out[head!] = withoutAt(out[head!], rest);
  return out;
}

/**
 * The trust boundary for a project's own `smart.config.json`. It came with the repository, so a stranger may have written it:
 * settings in it that would loosen what your own config (or the default) allows are applied only when you trusted the file
 * (`smart trust`). Everything else in it (routing, models, limits that are stricter, ...) always applies.
 * Returns the project config with the loosening settings removed (unless trusted) and a description of each one.
 */
export function gateProjectConfig(raw: unknown, base: SmartConfig, trusted: boolean): { raw: unknown; loosened: string[] } {
  let out = raw;
  const loosened: string[] = [];
  for (const s of SENSITIVE) {
    if (!hasAt(raw, s.path)) continue;
    const value = getAt(raw, s.path);
    if (!s.loosens(value, getAt(base, s.path))) continue;
    loosened.push(`${s.path.join('.')} (${s.risk(value)})`);
    if (!trusted) out = withoutAt(out, s.path);
  }
  return { raw: out, loosened };
}

export interface LoadConfigOptions {
  /** Where the global config and the trust store live (tests use a temporary home). */
  home?: string;
  /** Which project configs you have trusted; defaults to `~/.smart/trusted-projects.json`. */
  trust?: TrustCheck;
}

/**
 * Your global `~/.smart/smart.config.json`, then the project's `./smart.config.json` (or `--config <path>`) on top: a
 * project file changes only the keys it sets, the rest of your own settings still apply.
 *
 * Trust: your global file and a file you name with `--config` are yours. A `smart.config.json` found in the directory is the
 * repository's, so its settings that run commands, loosen permissions, pass flags, move your data or lift budgets are ignored
 * (with a warning) until you trust it with `smart trust` (see gateProjectConfig).
 */
export function loadConfig(cwd: string, explicitPath?: string, homeOrOptions: string | LoadConfigOptions = homedir()): LoadedConfig {
  const o: LoadConfigOptions = typeof homeOrOptions === 'string' ? { home: homeOrOptions } : homeOrOptions;
  const home = o.home ?? homedir();
  const global = globalConfigPath(home);
  const project = explicitPath ? resolve(cwd, explicitPath) : join(cwd, 'smart.config.json');
  if (explicitPath && !existsSync(project)) throw new SmartError('config', `Config file not found: ${explicitPath}`);
  const sources = [...new Set([global, project])].filter((p) => existsSync(p));
  if (sources.length === 0) return { config: defaultConfig(), source: null, sources: [], warnings: [], notices: [] };

  const warnings: string[] = [];
  const notices: string[] = [];
  let merged: unknown = {};
  for (const path of sources) {
    const { raw, text } = readConfigFile(path);
    const unknown = unknownKeys(raw);
    if (unknown.length) warnings.push(`${path}: ignoring unknown setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (a typo?)`);
    let layer = raw;
    // The repository's own file (found in the directory, not named by you): gate what crosses the trust boundary.
    if (path === project && !explicitPath && path !== global) {
      const trust = o.trust ?? new TrustStore(trustStorePath(home));
      const trusted = trust.isTrusted(cwd, text);
      const gated = gateProjectConfig(raw, ConfigSchema.parse(merged), trusted);
      layer = gated.raw;
      if (gated.loosened.length && trusted) {
        notices.push(`Using settings from this project's smart.config.json that you trusted: ${gated.loosened.join('; ')}.`);
      } else if (gated.loosened.length) {
        const changed = trust.changedSince(cwd, text) ? ' It changed since you last trusted it.' : '';
        warnings.push(
          `Ignored settings in ${path} because this project is not trusted:${changed} ${gated.loosened.join('; ')}. ` +
            'Read the file; if you agree, run `smart trust` here to allow them (or pass it with --config).',
        );
      }
    }
    merged = mergeConfig(merged, layer);
  }
  return { config: ConfigSchema.parse(merged), source: sources.at(-1) ?? null, sources, warnings, notices };
}

/** The project's `smart.config.json`, validated, with the settings that `smart trust` would allow. */
export function describeProjectTrust(cwd: string, home: string = homedir()): { path: string; text: string; loosened: string[] } {
  const path = join(cwd, 'smart.config.json');
  if (!existsSync(path)) throw new SmartError('config', `There is no smart.config.json in ${cwd} to trust.`);
  const { raw, text } = readConfigFile(path);
  const globalPath = globalConfigPath(home);
  const base = existsSync(globalPath) && globalPath !== path ? ConfigSchema.parse(readConfigFile(globalPath).raw) : defaultConfig();
  return { path, text, loosened: gateProjectConfig(raw, base, true).loosened };
}

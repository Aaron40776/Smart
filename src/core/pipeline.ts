import { randomUUID } from 'node:crypto';
import type { RunClaudeFn } from './claude.js';
import { resolvePermissionMode } from './claude.js';
import { NoCheckpoints, type Checkpointer } from './checkpoint.js';
import { classify, fastClassify } from './classifier.js';
import type { SmartConfig } from './config.js';
import { newConversation, recordTask, renderMemory, type Conversation, type ConversationStore, type PendingTask } from './store/conversation.js';
import { EventBus, type Stage } from './events.js';
import { SmartError, cancelled, isCancelled } from './errors.js';
import { projectContext, projectFiles } from './files.js';
import { resolveMentions } from './mentions.js';
import { describeConfig } from './describe.js';
import { answerEffort, effortFor, planEffort } from './effort.js';
import { buildCostTable, estimateStep, type CostTable, type StepEstimate } from './rating/estimate.js';
import { buildHistory, type History } from './rating/learn.js';
import { effortAt, rateTask } from './rating/rate.js';
import { ANSWER_SYSTEM, CHAT_SYSTEM, isSmallTalk } from './smalltalk.js';
import { makePlan, singleStepPlan } from './planner.js';
import { ANSWER_UPGRADE_SCORE, route, routeRole, reviewerTier } from './router.js';
import { reviewStep } from './review.js';
import { gatherFiles, runStep } from './runner.js';
import type { StepRecord, TaskRecord, Tracker } from './store/tracker.js';
import { addUsage, emptyUsage, type Classification, type Limits, type ModelTier, type Plan, type PlanStep, type RouteDecision, type Usage } from './types.js';
import { LimitsStore } from './store/limits.js';
import { detectChecks, isDocsOnly, nextAttempt, runChecks, type Check, type ExecFn } from './verifier.js';
import { makeRun } from './pipeline/calls.js';
import { ChangeTracker } from './pipeline/changes.js';
import { AccountLimits } from './pipeline/limits.js';
import { plannerDownshift, routeWithSession, sessionTooBig } from './pipeline/session.js';
import { forcedClassification, selectChecks, shouldReview, skippedRecord, stepBudget } from './pipeline/steps.js';

export interface PipelineDeps {
  run: RunClaudeFn;
  exec?: ExecFn;
  tracker?: Tracker;
  listFiles?: (cwd: string) => string[];
  now?: () => Date;
  /** Effective uid, injectable so the root fallback is testable. */
  uid?: number;
  /** Conversation to continue (`smart -c`); a new one is started when omitted. */
  conversation?: Conversation;
  conversationStore?: ConversationStore;
  /** Working-tree snapshots for change summaries, /diff and /undo. Defaults to none. */
  checkpoints?: Checkpointer;
  /** Last account usage seen (persisted between runs) and where to save updates. */
  limits?: Limits | null;
  limitsStore?: LimitsStore;
  /** Override how project instructions are read for the planner (tests). */
  projectContext?: (cwd: string) => string;
  /** How to wait before retrying an overloaded API (tests make it instant). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface TaskOptions {
  dryRun?: boolean;
  noPlan?: boolean;
  /** Skip the approval pause (non-interactive use and tests). */
  autoApprove?: boolean;
  /** Continue the unfinished task from its first unfinished step (skips classify, plan and approve). */
  resume?: boolean;
}

export interface TaskSummary {
  taskId: string;
  ok: boolean;
  cancelled: boolean;
  dryRun: boolean;
  totals: Usage;
  steps: StepRecord[];
  classification?: Classification;
  plan?: Plan;
}

/**
 * Orchestrates classify → plan → approve → execute → verify. It only talks to the outside
 * world through `deps` and the event bus, so any frontend can drive it.
 */
export class Pipeline {
  private forced: ModelTier | null = null;
  private dryRun = false;
  private running = false;
  private sessionDone: Usage = emptyUsage();
  private taskUsage: Usage = emptyUsage();
  private ctl: AbortController | null = null;
  private approval: { resolve: (p: Plan) => void; reject: (e: Error) => void } | null = null;
  private announced = false;
  private conv: Conversation;
  private lastReply = '';
  private overhead: Usage = emptyUsage();
  private notes: string[] = [];
  private permOverride: string | null = null;
  private warnedNoGit = false;
  /** Said once per session that tests wait for the last plan step. */
  private deferredTestsNoted = false;
  private readonly cp: Checkpointer;
  private readonly limitsWatch: AccountLimits;
  private readonly changes: ChangeTracker;
  /** How each rung has fared on your recent steps; the rater nudges towards what worked. Refreshed at the start of every task. */
  private history: History | undefined;
  /** The last task written to your history, for /good and /bad. */
  private lastTaskId: { id: string; steps: StepRecord[] } | null = null;
  /** Typical cost per model and effort from your history (see previewStep). */
  private costTable: CostTable | undefined;
  /** The classification of the task whose plan is on screen. */
  private planClassification: Classification | null = null;
  /** Files the current request refers to with @path: they count towards how big the work is. */
  private taskFiles: string[] = [];
  /** The task currently running, so a shutdown can wait for its state to be saved (see `settle`). */
  private current: Promise<unknown> | null = null;
  private bgSnapshot: Promise<string | null> | null = null;
  /** Every Claude call goes through here so account usage reported in any stream is captured. */
  private readonly run: RunClaudeFn;

  constructor(
    private readonly config: SmartConfig,
    readonly bus: EventBus,
    private readonly cwd: string,
    private readonly deps: PipelineDeps,
  ) {
    this.conv = deps.conversation ?? newConversation();
    this.cp = deps.checkpoints ?? new NoCheckpoints();
    this.limitsWatch = new AccountLimits(config, bus, () => this.now(), deps.limits ?? null, deps.limitsStore);
    this.changes = new ChangeTracker({
      bus, cp: this.cp, now: () => this.now(), conversation: () => this.conv, saveConversation: () => this.saveConversation(),
      isRunning: () => this.running, note: (text) => this.notes.push(text),
    });
    this.run = makeRun(deps.run, config, {
      onLimits: (windows, status) => this.limitsWatch.observe(windows, status),
      onErrorUsage: (usage) => {
        this.taskUsage = addUsage(this.taskUsage, usage);
        this.bus.emit({ type: 'tokens', usage, sessionTotal: this.sessionTotal });
      },
      notice: (message) => this.bus.emit({ type: 'notice', level: 'warn', message }),
    }, deps.sleep);
  }

  // ---- commands from the frontend -------------------------------------------------------

  forceModel(tier: ModelTier | null): void {
    this.forced = tier;
  }
  setDryRun(on: boolean): void {
    this.dryRun = on;
  }
  get isRunning(): boolean {
    return this.running;
  }
  get sessionTotal(): Usage {
    return addUsage(this.sessionDone, this.taskUsage);
  }
  /** Change the permission mode for the rest of this session (`null` returns to the configured one). */
  setPermissionMode(mode: string | null): void {
    this.permOverride = mode;
    if (this.permissionMode === 'bypassPermissions') {
      this.bus.emit({ type: 'notice', level: 'warn', message: `Permissions are bypassed from now on: Claude Code can run any command in ${this.cwd} without asking.` });
    }
  }
  get permissionMode(): string {
    return this.permOverride ?? this.config.runner.permissionMode;
  }
  /** The final message of the last coding step (what `smart -p` prints). */
  get lastReplyText(): string {
    return this.lastReply;
  }
  /** Latest account usage windows Claude reported (may be from a previous run). */
  get accountLimits(): Limits | null {
    return this.limitsWatch.current;
  }
  /** Number of tasks remembered in the current conversation. */
  get chatTasks(): number {
    return this.conv.tasks.length;
  }

  /** The unfinished task `/resume` would continue, if any. */
  get pendingTask(): PendingTask | null {
    return this.conv.pending ?? null;
  }

  /** Continue the last failed or cancelled task from its first unfinished step. */
  resumeTask(opts: Omit<TaskOptions, 'resume'> = {}): Promise<TaskSummary> {
    const pending = this.conv.pending;
    if (!pending) throw new SmartError('internal', 'Nothing to resume: the last task finished or never got past planning.');
    return this.runTask(pending.prompt, { ...opts, resume: true, autoApprove: true });
  }

  /** Forget the conversation: the next task starts a fresh Claude Code session with no memory. */
  newConversation(): void {
    if (this.running) throw new SmartError('internal', 'Cancel the running task before starting a new conversation.');
    // Undo is about your files, not the chat: it survives a new conversation.
    this.conv = { ...newConversation(), ...(this.conv.undo ? { undo: this.conv.undo } : {}) };
    this.saveConversation();
    this.emitConversation();
  }

  /** Resolve the pending plan-approval pause with the (possibly edited) plan. */
  approvePlan(plan: Plan): void {
    this.approval?.resolve(plan);
  }

  /** Cancel whatever is running: the current Claude call, verification, or the approval pause. */
  cancel(): void {
    this.ctl?.abort();
    this.approval?.reject(cancelled());
  }

  // ---- the task ---------------------------------------------------------------------------

  runTask(prompt: string, opts: TaskOptions = {}): Promise<TaskSummary> {
    if (this.running) return Promise.reject(new SmartError('internal', 'A task is already running.'));
    const p = this.execute(prompt, opts);
    this.current = p;
    return p;
  }

  /** Resolves once the running task (if any) has finished saving its state, or after `ms`. Call after `cancel()` and before exiting. */
  async settle(ms = 3000): Promise<void> {
    const p = this.current;
    if (!p) return;
    await Promise.race([p.catch(() => undefined), new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
  }

  private async execute(prompt: string, opts: TaskOptions): Promise<TaskSummary> {
    const myId = ++this.runId;
    this.history = this.loadHistory();
    this.releaseRun = () => {
      if (this.runId !== myId) return;
      this.running = false;
      this.ctl = null;
      this.approval = null;
    };
    const release = this.releaseRun;
    this.running = true;
    this.ctl = new AbortController();
    this.taskUsage = emptyUsage();
    const dryRun = opts.dryRun ?? this.dryRun;
    const taskId = `t_${(this.deps.now?.() ?? new Date()).getTime().toString(36)}`;
    const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const summary: TaskSummary = { taskId, ok: false, cancelled: false, dryRun, totals: emptyUsage(), steps: [] };
    this.overhead = emptyUsage();
    this.changes.fresh = null;
    const touched: string[] = [];
    let startTree: string | null = null;
    const doneRef: { ids: Set<string>; executing: boolean } = { ids: new Set(), executing: false };
    this.lastReply = '';

    const emit = this.bus.emit.bind(this.bus);
    const stage = (s: Stage, status: 'active' | 'done' | 'skipped' | 'failed') => emit({ type: 'stage', stage: s, status });
    let current: Stage = 'classify';
    const at = (s: Stage) => {
      current = s;
      stage(s, 'active');
    };

    try {
      emit({ type: 'task:start', taskId, prompt, dryRun, at: this.now() });
      this.emitConversation();
      this.announce();
      const memory = renderMemory(this.conv);
      const referenced = resolveMentions(this.cwd, prompt, this.config.limits.maxContextBytes);
      this.taskFiles = referenced.map((f) => f.path);
      if (referenced.length) emit({ type: 'notice', level: 'info', message: `Using ${referenced.length} referenced file${referenced.length === 1 ? '' : 's'}: ${referenced.map((f) => f.path).join(', ')}` });
      // Greetings skip the git snapshot, classifier and Claude Code session entirely.
      if (!dryRun && !opts.resume && !this.forced && !referenced.length && isSmallTalk(prompt)) return await this.respond(prompt, summary, { startedAt, memory, at, stage, touched });
      if (!dryRun && !this.cp.available && !this.warnedNoGit) {
        this.warnedNoGit = true;
        emit({ type: 'notice', level: 'info', message: 'Not a git repository, so /undo and /diff are unavailable here. Run `git init` to enable them.' });
      }
      // The git snapshot runs while the classifier and planner think; it is only needed before the first file is touched.
      const snapshotting = dryRun ? Promise.resolve(null) : this.changes.snap().catch(() => null);
      this.bgSnapshot = snapshotting;
      const signal = this.ctl.signal;

      if (!dryRun) this.rotateLargeSession();
      const resumed = opts.resume ? this.conv.pending : undefined;
      let classification: Classification;
      let plan: Plan;
      const doneIds = doneRef.ids;
      if (resumed) {
        classification = resumed.classification;
        plan = resumed.plan;
        for (const id of resumed.doneStepIds) doneIds.add(id);
        summary.classification = classification;
        summary.plan = plan;
        for (const st of ['classify', 'plan', 'approve'] as const) stage(st, 'skipped');
        const left = plan.steps.filter((x) => !x.skipped && !doneIds.has(x.id)).length;
        emit({ type: 'notice', level: 'info', message: `Resuming: ${doneIds.size} step${doneIds.size === 1 ? '' : 's'} already done, ${left} to go.` });
        this.planClassification = classification;
        emit({ type: 'plan:ready', plan, routes: this.routePlan(plan, classification), done: [...doneIds] });
        emit({ type: 'plan:approved', plan });
      } else {
        // 1. classify
        at('classify');
        // Clearly routine edits skip the classifier round trip altogether, and so does a task whose model is forced with planning
        // off: nothing the classifier says would change what runs (the text alone still sets the effort).
        const fast = fastClassify(prompt, this.config) ?? (this.forced && opts.noPlan ? forcedClassification(this.forced) : null);
        const c = fast ? { classification: fast, usage: emptyUsage() } : await classify(prompt, { config: this.config, cwd: this.cwd, run: this.run, signal, memory });
        this.addCallUsage(c.usage);
        classification = c.classification;
        summary.classification = classification;
        emit({ type: 'classified', classification, route: this.routeTask(classification, prompt) });
        if (classification.fallback && !fast) emit({ type: 'notice', level: 'warn', message: classification.reason });
        stage('classify', 'done');

        // A pure question the classifier could answer on the spot needs no coding session: one call in total.
        if (classification.answer && !this.forced && !dryRun && !referenced.length) {
          // The classifier's own answer is right for an easy question. A question the rater finds hard is answered by the model
          // it picks, at its effort (one more tool-free call; still no coding session).
          // Keyword rules ("deadlock" → Opus) are about doing the work, not explaining it, and a question the classifier itself
          // rated easy is answered well enough already ("what is a deadlock?").
          const rated = this.routeTask(classification, prompt, this.taskFiles, false);
          const worthUpgrading = classification.difficulty !== 'easy' && rated.tier !== 'haiku' && (rated.score ?? 0) >= ANSWER_UPGRADE_SCORE;
          return await this.respond(prompt, summary, { startedAt, memory, at, stage, touched }, { classification, text: classification.answer, upgrade: worthUpgrading ? rated : undefined });
        }

        // 2. plan
        const wantPlan = !opts.noPlan && (classification.needsPlan || classification.complexity === 'large_build');
        if (wantPlan) {
          at('plan');
          const taskScore = rateTask({ text: prompt, classification, files: this.taskFiles, config: this.config, history: this.history }).score;
          const planRole = routeRole('planner', this.config, this.forced ?? this.plannerDownshift(classification, taskScore), classification, taskScore);
          const planEffortNow = planEffort(classification.complexity, this.config, taskScore);
          emit({ type: 'notice', level: 'info', message: `Planning with ${planRole.tier}${planEffortNow ? ` · ${planEffortNow}` : ''}` });
          const p = await makePlan(prompt, classification, {
            config: this.config, cwd: this.cwd, run: this.run, signal, override: this.forced ?? this.plannerDownshift(classification, taskScore), memory, effort: planEffort(classification.complexity, this.config, taskScore), score: taskScore,
            projectFiles: (this.deps.listFiles ?? projectFiles)(this.cwd), context: (this.deps.projectContext ?? projectContext)(this.cwd), referenced,
          });
          this.addCallUsage(p.usage);
          plan = p.plan;
          if (p.warning) emit({ type: 'notice', level: 'warn', message: p.warning });
          stage('plan', 'done');
        } else {
          plan = singleStepPlan(prompt);
          stage('plan', 'skipped');
        }
        summary.plan = plan;
        this.planClassification = classification;
        emit({ type: 'plan:ready', plan, routes: this.routePlan(plan, classification) });

        if (dryRun) {
          stage('approve', 'skipped');
          stage('execute', 'skipped');
          stage('verify', 'skipped');
          summary.ok = true;
          return await this.finish(summary, { startedAt, prompt, touched, startTree });
        }

        // 3. approve (only for multi-step plans the planner produced)
        if (wantPlan && plan.steps.length > 1 && !opts.autoApprove) {
          at('approve');
          plan = await this.awaitApproval();
          summary.plan = plan;
          emit({ type: 'plan:approved', plan });
          stage('approve', 'done');
        } else {
          stage('approve', 'skipped');
        }
      }

      startTree = await snapshotting;

      // 4. execute (+ verify per step)
      at('execute');
      const cursor = { tree: startTree };
      doneRef.executing = true;
      const active = plan.steps.filter((s) => !s.skipped);
      let failed = false;
      for (const [index, step] of active.entries()) {
        if (doneIds.has(step.id)) continue;
        const rec = await this.runOneStep({ plan, step, index, total: active.length, classification, touched, current: (s) => at(s), prompt, cursor, referenced });
        summary.steps.push(rec);
        if (rec.outcome === 'done') doneIds.add(step.id);
        if (rec.outcome !== 'done') {
          failed = true;
          if (rec.outcome === 'cancelled') throw cancelled();
          break;
        }
      }
      for (const s of plan.steps.filter((s) => s.skipped)) summary.steps.push(skippedRecord(s));
      summary.ok = !failed;
      stage('execute', failed ? 'failed' : 'done');
      return await this.finish(summary, { startedAt, prompt, touched, startTree, doneIds });
    } catch (e) {
      summary.ok = false;
      if (isCancelled(e)) summary.cancelled = true;
      // Save the state (checkpoint, /resume, cost record) BEFORE telling the frontend the task is over: a one-shot run exits
      // as soon as it sees the terminal event, and would otherwise lose all of it.
      const out = await this.finish(summary, { startedAt, prompt, touched, startTree, aborted: true, doneIds: doneRef.ids, executing: doneRef.executing });
      stage(current, 'failed');
      if (summary.cancelled) emit({ type: 'task:cancelled', taskId });
      else {
        const err = e instanceof SmartError ? e : new SmartError('internal', (e as Error).message ?? String(e));
        const limited = err.kind === 'limit';
        // Nothing to /resume when it stopped before a step ran (while classifying or planning): the task is simply sent again.
        const resumable = this.conv.pending?.prompt === prompt;
        const hint = limited && !resumable ? 'Send the task again once it resets.' : err.kind === 'overloaded' && !resumable ? 'Send the task again in a few minutes.' : err.hint;
        emit({ type: 'error', kind: err.kind, message: limited ? this.limitsWatch.message(err) : err.message, hint });
      }
      return out;
    } finally {
      release();
    }
  }

  // ---- internals --------------------------------------------------------------------------

  private runId = 0;
  private releaseRun: () => void = () => undefined;

  /**
   * Ends the running task for callers. Safe to call twice, and a late call from an old run never touches a newer one
   * (a frontend may start the next task the moment it sees the terminal event).
   */
  private release(): void {
    this.releaseRun();
  }

  /** Answers without a coding session: small talk (one short Haiku call) or a question the classifier already answered (no extra call). */
  private async respond(
    prompt: string,
    summary: TaskSummary,
    x: { startedAt: string; memory: string; at: (s: Stage) => void; stage: (s: Stage, st: 'active' | 'done' | 'skipped' | 'failed') => void; touched: string[] },
    /** The classifier already answered (one call in total): show that answer instead of asking again. */
    ready?: { classification: Classification; text: string; upgrade?: RouteDecision },
  ): Promise<TaskSummary> {
    const emit = this.bus.emit.bind(this.bus);
    const upgrade = ready?.upgrade;
    const tier: ModelTier = upgrade?.tier ?? (ready ? this.config.routing.classifier : 'haiku');
    const decision: RouteDecision = upgrade ?? (ready
      ? { tier, model: this.config.models[tier], reason: 'answered by the classifier: no second call' }
      : { tier, model: this.config.models[tier], reason: 'small talk: no classification, no tools' });
    const classification: Classification = ready?.classification ?? { complexity: 'trivial', needsPlan: false, reason: 'Small talk.' };
    const plan = singleStepPlan(prompt);
    const step = plan.steps[0]!;
    summary.classification = classification;
    summary.plan = plan;
    if (!ready) {
      emit({ type: 'classified', classification, route: decision });
      x.stage('classify', 'skipped');
    }
    x.stage('plan', 'skipped');
    x.stage('approve', 'skipped');
    emit({ type: 'plan:ready', plan, routes: { [step.id]: decision } });
    x.at('execute');
    emit({ type: 'step:start', stepId: step.id, title: 'Reply', route: decision, attempt: 1, at: this.now() });
    const rec: StepRecord = { stepId: step.id, title: 'Reply', model: decision.model, tier, attempts: 1, escalated: false, usage: emptyUsage(), outcome: 'failed' };
    try {
      const res = ready && !upgrade
        ? null
        : await this.run({
            prompt: x.memory ? `<conversation>\n${x.memory}\n</conversation>\n\n${prompt}` : prompt,
            model: decision.model, systemPrompt: upgrade ? ANSWER_SYSTEM : CHAT_SYSTEM, tools: [], cwd: this.cwd, signal: this.ctl!.signal,
            effort: upgrade ? answerEffort({ decision: upgrade, tier, config: this.config }) : undefined,
            // A longer answer appears as it is written.
            partial: Boolean(upgrade),
            onEvent: (e) => {
              if (e.kind === 'text-delta') emit({ type: 'step:stream', stepId: step.id, text: e.text });
            },
          });
      this.lastReply = (res?.text ?? ready?.text ?? '').trim();
      if (res) {
        rec.usage = res.usage;
        this.taskUsage = addUsage(this.taskUsage, res.usage);
      }
      emit({ type: 'step:output', stepId: step.id, kind: 'text', text: this.lastReply });
      if (res) emit({ type: 'tokens', stepId: step.id, usage: res.usage, sessionTotal: this.sessionTotal });
      rec.outcome = 'done';
      emit({ type: 'step:done', stepId: step.id, at: this.now() });
    } catch (e) {
      if (isCancelled(e)) throw e;
      if (e instanceof SmartError && e.kind !== 'claude') throw e;
      emit({ type: 'step:failed', stepId: step.id, error: (e as Error).message, at: this.now() });
    }
    summary.steps.push(rec);
    summary.ok = rec.outcome === 'done';
    x.stage('verify', 'skipped');
    x.stage('execute', summary.ok ? 'done' : 'failed');
    // A greeting between a failed task and /resume must not throw the unfinished task away.
    return this.finish(summary, { startedAt: x.startedAt, prompt, touched: x.touched, startTree: null, keepPending: true });
  }

  private announce(): void {
    if (this.announced) return;
    this.announced = true;
    const perm = resolvePermissionMode(this.config.runner.permissionMode, this.deps.uid ?? process.getuid?.());
    if (perm.warning) this.bus.emit({ type: 'notice', level: 'warn', message: perm.warning });
    else if (perm.mode === 'bypassPermissions') {
      this.bus.emit({ type: 'notice', level: 'warn', message: `Permissions are bypassed (runner.permissionMode): Claude Code can run any command in ${this.cwd} without asking.` });
    }
  }

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** See routeWithSession: limit pressure, then the warm-cache rule for follow-ups. */
  private warm(decision: RouteDecision): RouteDecision {
    return routeWithSession(decision, { conv: this.conv, limits: this.limitsWatch.current, config: this.config, nowMs: this.now() });
  }

  /** See plannerDownshift. */
  private plannerDownshift(classification: Classification, score: number): ModelTier | null {
    return plannerDownshift(classification, score, this.limitsWatch.current, this.config);
  }



  /** Starts a fresh Claude Code session when the current one has grown too big (see sessionTooBig). */
  private rotateLargeSession(): void {
    const size = sessionTooBig(this.conv, this.config);
    if (size === null) return;
    this.conv.sessionId = null;
    this.conv.contextTokens = 0;
    this.bus.emit({
      type: 'notice', level: 'info',
      message: `Starting a fresh Claude Code session: the last one had grown to about ${Math.round(size / 1000)}k tokens, which every step re-reads. A summary of this conversation carries over (session.maxContextTokens).`,
    });
  }



  /** Human-readable effective configuration, for /config. */
  describe(): string[] {
    return describeConfig(this.config, { permissionMode: this.permissionMode, modeOverridden: this.permOverride !== null, limits: this.limitsWatch.current });
  }

  private emitConversation(): void {
    this.bus.emit({ type: 'conversation', tasks: this.conv.tasks.length, resumed: this.conv.sessionId !== null });
  }

  private saveConversation(): void {
    const err = this.deps.conversationStore?.save(this.cwd, this.conv);
    if (err) this.bus.emit({ type: 'notice', level: 'warn', message: err });
  }

  /** What learning and the cost estimate need from your history, read once per task. */
  private loadHistory(): History | undefined {
    try {
      const tasks = this.deps.tracker?.load() ?? [];
      this.costTable = buildCostTable(tasks);
      return this.deps.tracker ? buildHistory(tasks) : undefined;
    } catch {
      return undefined; // learning is a bonus: never let it stop a task
    }
  }

  /**
   * The model, effort and likely cost of a plan step as it stands now: the approval screen asks again after every edit, so
   * the badges and the estimate follow your changes (a model you pick, instructions you rewrite).
   */
  previewStep(plan: Plan, step: PlanStep): { route: RouteDecision; estimate: StepEstimate } {
    const classification = this.planClassification ?? { complexity: 'multi_file', needsPlan: true, reason: '' };
    const route = this.routeStep(step, classification, this.inPlan(plan, step));
    return { route, estimate: estimateStep(route, this.costTable) };
  }

  private routeTask(classification: Classification, text: string, files: string[] = this.taskFiles, keywords = true): RouteDecision {
    return this.warm(route({ classification, text, override: this.forced, files, history: this.history, keywords }, this.config));
  }

  private routePlan(plan: Plan, classification: Classification): Record<string, RouteDecision> {
    return Object.fromEntries(plan.steps.map((s) => [s.id, this.routeStep(s, classification, this.inPlan(plan, s))]));
  }

  /**
   * Whether a step is one of a written plan (rated on its own, with the planner's difficulty) rather than the whole request.
   * A single step the planner wrote and rated counts as a plan step; the fallback single step (no plan) does not.
   */
  private inPlan(plan: Plan, step: PlanStep): boolean {
    return plan.steps.length > 1 || step.difficulty !== undefined;
  }

  /** A step of a written plan is rated on its own text and the planner's difficulty; a lone task on the request itself. */
  private routeStep(step: PlanStep, classification: Classification, inPlan = true): RouteDecision {
    // A lone task is rated on the user's own words (its step title is boilerplate and would hide a leading question word).
    const text = inPlan ? `${step.title}\n${step.instructions}` : step.instructions;
    return this.warm(route({ classification, text, step, solo: !inPlan, override: this.forced, files: inPlan ? undefined : this.taskFiles, history: this.history }, this.config));
  }

  private awaitApproval(): Promise<Plan> {
    return new Promise<Plan>((resolve, reject) => {
      if (this.ctl?.signal.aborted) return reject(cancelled());
      this.approval = { resolve, reject };
    }).finally(() => {
      this.approval = null;
    });
  }




  /** The checks after one step (see selectChecks); says once per session that tests wait for the last plan step. */
  private checksFor(lastStep: boolean): Check[] {
    const { checks, deferred } = selectChecks(detectChecks(this.cwd, this.config), lastStep, this.config);
    if (deferred && !this.deferredTestsNoted) {
      this.deferredTestsNoted = true;
      this.bus.emit({ type: 'notice', level: 'info', message: 'Tests run after the last step; earlier steps get the quicker checks (verify.testEveryStep: true runs them every step).' });
    }
    return checks;
  }



  /** Returns a description of the problems, or undefined when the step passes (or could not be reviewed). */
  private async review(task: string, step: PlanStep, files: string[], signal: AbortSignal, score?: number): Promise<string | undefined> {
    const emit = this.bus.emit.bind(this.bus);
    const contents = gatherFiles(this.cwd, files, this.config.limits.maxContextBytes, { skipSecrets: true });
    if (contents.length === 0) return undefined;
    // A step rated hard is checked by a stronger reviewer than the one that would check a rename.
    const tier = reviewerTier(score, this.config);
    const out = await reviewStep({ task, step, files: contents, config: this.config, cwd: this.cwd, run: this.run, signal, tier, effort: tier === 'sonnet' && this.config.runner.autoEffort ? 'low' : undefined });
    this.addCallUsage(out.usage);
    if (out.kind === 'unavailable') {
      emit({ type: 'step:review', stepId: step.id, pass: true, issues: [], skipped: out.reason });
      return undefined;
    }
    emit({ type: 'step:review', stepId: step.id, pass: out.pass, issues: out.issues });
    return out.pass ? undefined : `A review of your changes found problems with this step:\n${out.issues.map((i) => `- ${i}`).join('\n')}`;
  }


  /** `/good` and `/bad`: your verdict on the last task. It feeds the learning, so a model that keeps getting it wrong for you is used less. */
  rateLast(feedback: 'good' | 'bad'): void {
    const emit = this.bus.emit.bind(this.bus);
    const last = this.lastTaskId;
    if (!last || !this.deps.tracker) return emit({ type: 'notice', level: 'info', message: 'No finished task to rate yet in this session.' });
    const err = this.deps.tracker.setFeedback(last.id, feedback);
    if (err) return emit({ type: 'notice', level: 'warn', message: err });
    const rungs = [...new Set(last.steps.filter((s) => s.rated).map((s) => `${s.rated!.tier}${s.rated!.effort ? ` · ${s.rated!.effort}` : ''}`))].join(', ');
    emit({
      type: 'notice', level: 'info',
      message: feedback === 'good'
        ? `Thanks. Noted as good${rungs ? ` (${rungs})` : ''}.`
        : `Noted as wrong${rungs ? `: it counts against ${rungs} for similar work` : ''}, so smart leans to a stronger model or more effort there. /undo reverts its changes.`,
    });
  }

  /** Revert the working tree to how it was before the most recent task that changed files (`force`: even over later edits). */
  undo(force = false): Promise<void> {
    return this.changes.undo(force);
  }

  /** Publish a unified diff of the most recent task that changed files. */
  diff(): Promise<void> {
    return this.changes.diff();
  }

  private addCallUsage(usage: Usage): void {
    this.taskUsage = addUsage(this.taskUsage, usage);
    this.overhead = addUsage(this.overhead, usage);
    this.bus.emit({ type: 'tokens', usage, sessionTotal: this.sessionTotal });
  }

  private async runOneStep(a: {
    plan: Plan;
    step: PlanStep;
    index: number;
    total: number;
    classification: Classification;
    touched: string[];
    current: (s: Stage) => void;
    /** The user's overall request (for the reviewer). */
    prompt: string;
    /** Working-tree snapshot before this step; updated to the snapshot after it. */
    cursor: { tree: string | null };
    /** Files the user referenced with @path (given to the first step). */
    referenced: import('./runner.js').FileContext[];
  }): Promise<StepRecord> {
    const { plan, step, index, total, classification, touched } = a;
    const stepStart = a.cursor.tree;
    const emit = this.bus.emit.bind(this.bus);
    const signal = this.ctl!.signal;
    const perm = resolvePermissionMode(this.permissionMode, this.deps.uid ?? process.getuid?.());
    const first = this.routeStep(step, classification, this.inPlan(plan, step));
    // Learning files the outcome under the rung that actually ran first, with the rater's own effort for it (so the key matches
    // what the rater looks up later, whether or not effort is applied).
    const startEffort = first.tier === first.ratedTier ? first.effort : effortAt(first.tier, first.score ?? 0.5);
    const rec: StepRecord = {
      stepId: step.id, title: step.title, model: first.model, tier: first.tier, attempts: 0, escalated: false, usage: emptyUsage(), outcome: 'failed',
      ...(first.score !== undefined ? { rated: { tier: first.tier, ...(startEffort ? { effort: startEffort } : {}), score: first.score } } : {}),
    };

    let tier = first.tier;
    let failuresOnTier = 0;
    let failure: string | undefined;
    /** The decision the current model was chosen with. Retries adjust the effort from THIS each time, so they never compound. */
    let base = first;
    let decision: RouteDecision;

    for (;;) {
      const cap = this.config.limits.maxBudgetUsdPerTask;
      if (cap && this.taskUsage.costUsd >= cap) {
        rec.outcome = 'failed';
        const msg = `Task budget of $${cap} reached (spent $${this.taskUsage.costUsd.toFixed(2)}); stopping.`;
        emit({ type: 'notice', level: 'warn', message: msg });
        emit({ type: 'step:failed', stepId: step.id, error: msg });
        return rec;
      }
      rec.attempts += 1;
      rec.tier = tier;
      rec.model = base.model;
      const effort = effortFor({ decision: base, tier, failuresOnTier, escalated: rec.escalated, config: this.config });
      // The reason already names the rated effort; say so again only when a retry, an escalation or a pinned setting changed it.
      decision = effort === base.effort ? base : { ...base, effort, reason: `${base.reason}${effort ? ` · effort ${effort}` : ''}` };
      emit({ type: 'stage', stage: 'verify', status: 'pending' });
      emit({ type: 'step:start', stepId: step.id, title: step.title, route: decision, attempt: rec.attempts, at: this.now() });
      a.current('execute');

      // One persisted Claude Code session per conversation: steps and follow-up tasks resume it.
      const resuming = this.config.session.resume && this.conv.sessionId !== null;
      const sessionId = this.config.session.resume ? (this.conv.sessionId ?? randomUUID()) : undefined;
      const memory = !resuming && index === 0 ? renderMemory(this.conv) : '';
      const note = index === 0 ? this.notes.join(' ') : '';

      let ok = false;
      let context = 0;
      this.changes.fresh = null; // this attempt may change files before any snapshot sees them
      try {
        const res = await runStep({
          plan, step, index, total, touchedFiles: touched, failure, memory: memory || undefined, note: note || undefined, referenced: index === 0 ? a.referenced : undefined,
          session: sessionId ? { id: sessionId, resume: resuming } : undefined,
          effort,
          maxBudgetUsd: stepBudget(this.config, this.taskUsage.costUsd),
          config: this.config, cwd: this.cwd, run: this.run, route: decision, permissionMode: perm.mode, signal,
          onDelta: (text) => emit({ type: 'step:stream', stepId: step.id, text }),
          onOutput: (kind, text) => {
            if (kind === 'text') this.lastReply = text;
            emit({ type: 'step:output', stepId: step.id, kind, text });
          },
          onProgress: (p) => {
            context = p.contextTokens ?? context;
            emit({
              type: 'tokens', stepId: step.id,
              usage: { ...emptyUsage(), inputTokens: p.inputTokens, outputTokens: p.outputTokens, cacheReadTokens: p.cacheReadTokens },
              sessionTotal: addUsage(this.sessionTotal, { ...emptyUsage(), inputTokens: p.inputTokens, outputTokens: p.outputTokens }),
            });
          },
        });
        if (res.text.trim()) this.lastReply = res.text; // the final message is authoritative for follow-up memory
        rec.usage = addUsage(rec.usage, res.usage);
        this.taskUsage = addUsage(this.taskUsage, res.usage);
        emit({ type: 'tokens', stepId: step.id, usage: res.usage, sessionTotal: this.sessionTotal });
        if (note) this.notes = [];
        // What actually changed on disk (catches files made by shell commands), plus what the tool events reported.
        const after = await this.changes.snap();
        this.changes.fresh = after;
        const stepChanges = stepStart && after ? await this.cp.changes(stepStart, after) : null;
        const changedNow = stepChanges ? stepChanges.files.filter((f) => f.status !== 'D').map((f) => this.changes.fromRoot(f.path)) : [];
        const stepFiles = [...new Set([...changedNow, ...res.touched])];
        for (const f of stepFiles) if (!touched.includes(f)) touched.push(f);
        if (after) a.cursor.tree = after;
        if (sessionId) {
          this.conv.sessionId = sessionId;
          if (context > 0) this.conv.contextTokens = context;
        }
        this.conv.lastTier = tier;
        this.conv.lastCallAt = this.now();
        this.conv.lastCallAtByTier = { ...this.conv.lastCallAtByTier, [tier]: this.conv.lastCallAt };

        // verify
        // Nothing to check when no file changed for a question, or when only prose and images changed.
        const skipVerify = (classification.complexity === 'trivial' && stepFiles.length === 0) || isDocsOnly(stepFiles);
        const checks = skipVerify ? [] : this.checksFor(index === total - 1);
        if (checks.length > 0) a.current('verify');
        const v = await runChecks(checks, {
          cwd: this.cwd, config: this.config, exec: this.deps.exec, signal,
          onCheck: (r) => emit({ type: 'step:verify', stepId: step.id, ...r }),
        });
        if (signal.aborted) throw cancelled();
        if (checks.length > 0) this.changes.fresh = null; // a check can write files (a formatter, a build)
        // This attempt's own problem (`failure` still holds the previous attempt's text, which was already sent to the model).
        let problem: string | undefined = v.ok ? undefined : `${v.failure?.command} failed:\n${v.failure?.output}`;
        let reviewed = false;
        if (v.ok && shouldReview(this.config, classification, plan.steps.length, checks.length, stepFiles)) {
          a.current('verify');
          problem = await this.review(a.prompt, step, stepFiles, signal, base.score);
          reviewed = true;
        }
        emit({ type: 'stage', stage: 'verify', status: checks.length === 0 && !reviewed ? 'skipped' : problem ? 'failed' : 'done' });
        a.current('execute');
        if (problem) failure = problem;
        else ok = true;
      } catch (e) {
        if (isCancelled(e)) {
          rec.outcome = 'cancelled';
          emit({ type: 'step:failed', stepId: step.id, error: 'Cancelled', at: this.now() });
          return rec;
        }
        // The saved Claude Code session is gone (cleaned up, other machine): start a new one, carrying our memory.
        if (e instanceof SmartError && e.kind === 'claude' && resuming && /No conversation found/i.test(e.message)) {
          this.conv.sessionId = null;
          this.conv.contextTokens = 0;
          emit({ type: 'notice', level: 'warn', message: 'The previous Claude Code session was not found; starting a new one with a summary of the conversation.' });
          rec.attempts -= 1;
          continue;
        }
        // Auth / missing CLI / internal problems will not fix themselves: abort the task.
        if (e instanceof SmartError && e.kind !== 'claude') throw e;
        failure = (e as Error).message;
      }

      if (ok) {
        rec.outcome = 'done';
        emit({ type: 'step:done', stepId: step.id, at: this.now() });
        return rec;
      }

      failuresOnTier += 1;
      // A forced model is a user decision: retry it, but never silently switch to another.
      const next = this.forced ? (failuresOnTier <= this.config.escalation.retriesPerModel ? ({ action: 'retry', tier } as const) : ({ action: 'give_up' } as const)) : nextAttempt({ tier, failuresOnTier }, this.config);
      if (next.action === 'give_up') {
        rec.outcome = 'failed';
        emit({ type: 'step:failed', stepId: step.id, error: failure ?? 'failed', at: this.now() });
        return rec;
      }
      if (next.action === 'escalate') {
        rec.escalated = true;
        emit({ type: 'step:escalate', stepId: step.id, from: next.from, to: next.tier, reason: `failed ${failuresOnTier}x on ${next.from}` });
        tier = next.tier;
        failuresOnTier = 0;
        base = { ...base, tier, model: this.config.models[tier], reason: `escalated from ${next.from}`, source: undefined };
      }
    }
  }

  private async finish(
    summary: TaskSummary,
    f: { startedAt: string; prompt: string; touched: string[]; startTree: string | null; aborted?: boolean; doneIds?: Set<string>; keepPending?: boolean; /** The execute stage was reached: resumable even if no step finished. */ executing?: boolean },
  ): Promise<TaskSummary> {
    const { startedAt, prompt, aborted = false } = f;
    const overhead = this.overhead;
    // A snapshot still running in the background (early exit: direct answer, cancel) shares the temporary index with the next task: wait for it.
    await this.bgSnapshot?.catch(() => null);
    this.bgSnapshot = null;
    const changed = await this.changes.summarize(summary.dryRun, f.startTree, prompt);
    if (!summary.dryRun && summary.steps.some((s) => s.outcome !== 'skipped')) {
      recordTask(this.conv, {
        prompt,
        complexity: summary.classification?.complexity,
        summary: summary.plan && summary.plan.steps.length > 1 ? summary.plan.summary : undefined,
        outcome: summary.cancelled ? 'cancelled' : summary.ok ? 'done' : 'failed',
        files: changed.length > 0 ? changed : f.touched,
        reply: this.lastReply,
        at: startedAt,
      });
    }
    // A task that stopped after planning can be continued with /resume; a finished one clears that.
    if (!summary.dryRun) {
      const unfinished = !f.keepPending && !summary.ok && summary.plan && summary.classification && (f.executing || summary.steps.some((x) => x.outcome !== 'skipped'));
      if (unfinished) {
        this.conv.pending = { prompt, classification: summary.classification!, plan: summary.plan!, doneStepIds: [...(f.doneIds ?? [])], at: startedAt };
      } else if (summary.ok && !f.keepPending) {
        delete this.conv.pending;
      }
    }
    this.saveConversation();
    this.emitConversation();
    summary.totals = this.taskUsage;
    this.sessionDone = addUsage(this.sessionDone, this.taskUsage);
    this.taskUsage = emptyUsage();
    if (this.deps.tracker && summary.totals.costUsd + summary.totals.outputTokens > 0) {
      const record: TaskRecord = {
        id: summary.taskId, startedAt, prompt, classification: summary.classification, overhead,
        steps: summary.steps, totals: summary.totals, ok: summary.ok,
      };
      const err = this.deps.tracker.append(record);
      if (!err) this.lastTaskId = { id: summary.taskId, steps: summary.steps };
      if (err) this.bus.emit({ type: 'notice', level: 'warn', message: err });
    }
    // The task is over for callers from here on: a frontend that reacts to the terminal event below may start the next one at once.
    this.release();
    if (!aborted) {
      this.bus.emit({ type: 'stage', stage: 'done', status: summary.ok ? 'done' : 'failed' });
      this.bus.emit({ type: 'task:done', taskId: summary.taskId, totals: summary.totals, ok: summary.ok, at: this.now() });
    }
    return summary;
  }
}

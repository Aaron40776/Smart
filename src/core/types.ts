export type Complexity = 'trivial' | 'small_edit' | 'multi_file' | 'large_build';
export const COMPLEXITIES: readonly Complexity[] = ['trivial', 'small_edit', 'multi_file', 'large_build'];

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface Classification {
  complexity: Complexity;
  needsPlan: boolean;
  reason: string;
  /** How much reasoning the task needs, independent of its size. Blended into the rater's score (`hard` adds 0.3 to the classifier's opinion). */
  difficulty?: Difficulty;
  /** A complete answer to a pure question that needs no project files, tools or current information. */
  answer?: string;
  /** True when the classifier output was unusable and defaults were applied. */
  fallback?: boolean;
}

/** How hard Claude Code thinks (`--effort`), lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** How much reasoning a piece of work needs, independent of its size. */
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface PlanStep {
  id: string;
  title: string;
  instructions: string;
  files: string[];
  acceptance: string[];
  skipped?: boolean;
  /** Per-step model tier chosen by the user in the approval screen. */
  tier?: ModelTier;
  /** The planner's own rating of this step: it knows the plan best. */
  difficulty?: Difficulty;
}

export interface Plan {
  summary: string;
  features: string[];
  fileStructure: string[];
  steps: PlanStep[];
}

export interface RouteDecision {
  tier: ModelTier;
  /** Which rule decided: lets callers know whether the choice was the user's or automatic. */
  source?: 'override' | 'step' | 'keyword' | 'fallback' | 'complexity' | 'session';
  /** Concrete model name, read from config. */
  model: string;
  reason: string;
  /** Thinking effort chosen for this tier (unset for Haiku, or when effort is left at Claude Code's default). */
  effort?: Effort;
  /** 0..1 difficulty score from the rater, and how sure it is (0..1). */
  score?: number;
  confidence?: number;
  /** The tier the rater picked, before the warm-cache or limit rules changed it. */
  ratedTier?: ModelTier;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** One rolling usage window of the Claude account (e.g. the 5-hour and 7-day limits). */
export interface LimitWindow {
  /** 0..1 share of the window's allowance already used. */
  utilization: number;
  /** Epoch seconds when the window resets. */
  resetsAt?: number;
}

export interface Limits {
  windows: Record<string, LimitWindow>;
  /** Claude's own verdict, e.g. "allowed", "allowed_warning", "rejected". */
  status?: string;
  /** Epoch ms when this was observed. */
  at: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  costUsd: a.costUsd + b.costUsd,
});

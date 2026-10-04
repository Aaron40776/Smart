import type { Classification, Limits, ModelTier, Plan, RouteDecision, Usage } from './types.js';
import type { ErrorKind } from './errors.js';
import type { FileChange } from './checkpoint.js';

export type Stage = 'classify' | 'plan' | 'approve' | 'execute' | 'verify' | 'done';
export type StageStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

/** Everything the UI (or any other frontend) can observe. All payloads are plain JSON. */
export type SmartEvent =
  | { type: 'task:start'; taskId: string; prompt: string; dryRun: boolean; at?: number }
  | { type: 'stage'; stage: Stage; status: StageStatus }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'classified'; classification: Classification; route: RouteDecision }
  | { type: 'plan:ready'; plan: Plan; routes: Record<string, RouteDecision>; /** Steps already finished in an earlier run (`/resume`). */ done?: string[] }
  | { type: 'plan:approved'; plan: Plan }
  | { type: 'step:start'; stepId: string; title: string; route: RouteDecision; attempt: number; at?: number }
  | { type: 'step:output'; stepId: string; kind: 'text' | 'tool'; text: string }
  /** Live text of a step as it is written; the complete text follows as `step:output`. */
  | { type: 'step:stream'; stepId: string; text: string }
  | { type: 'tokens'; stepId?: string; usage: Usage; sessionTotal: Usage }
  | { type: 'step:verify'; stepId: string; command: string; ok: boolean; output: string }
  | { type: 'step:review'; stepId: string; pass: boolean; issues: string[]; skipped?: string }
  | { type: 'changes'; files: FileChange[]; insertions: number; deletions: number }
  | { type: 'diff'; text: string }
  | { type: 'step:escalate'; stepId: string; from: ModelTier; to: ModelTier; reason: string }
  | { type: 'step:done'; stepId: string; at?: number }
  | { type: 'step:failed'; stepId: string; error: string; at?: number }
  /** `failure`: why it did not finish (see pipeline/outcome.ts), absent when ok. */
  | { type: 'task:done'; taskId: string; totals: Usage; ok: boolean; at?: number; failure?: string }
  | { type: 'task:cancelled'; taskId: string }
  | { type: 'conversation'; tasks: number; resumed: boolean }
  | { type: 'limits'; limits: Limits }
  | { type: 'error'; kind: ErrorKind; message: string; hint?: string };

export type SmartEventType = SmartEvent['type'];
export type Listener = (event: SmartEvent) => void;

/** Minimal typed event bus. The core only ever emits; frontends subscribe. */
export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SmartEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // A misbehaving subscriber must never break the pipeline.
      }
    }
  }
}

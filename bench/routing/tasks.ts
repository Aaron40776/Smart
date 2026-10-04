import type { Complexity, Difficulty } from '../../src/core/types.js';

/**
 * Representative tasks for the routing benchmark. Each one says what the work really demands (`truth`) and what a cheap
 * classifier would plausibly say about it (`classifier`), which may be wrong on purpose (see `misjudged`).
 *
 * `truth.difficulty` (0..1) is the capability a model needs to get the work right on a good day (see sim.ts CAPABILITY).
 * These numbers are one person's judgement, chosen before running the benchmark; they are inputs to a model of the world,
 * not measurements.
 */
export interface BenchStep {
  title: string;
  /** What the planner would say (it rates its own steps). */
  plannerDifficulty?: Difficulty;
  /** What the step really needs. */
  difficulty: number;
  /** The step only touches prose (README, docs): no checks run. */
  docsOnly?: boolean;
}

export interface BenchTask {
  id: string;
  category: string;
  prompt: string;
  classifier: { complexity: Complexity; needsPlan: boolean; difficulty?: Difficulty; answer?: string };
  /** One entry for a single-step task; several when the planner would split it. */
  steps: BenchStep[];
  /** Whether the project has automated checks that catch a wrong result. Without them only the reviewer can. */
  checks: boolean;
  /** The task only reads (an explanation of the code): nothing to verify, a wrong answer goes unnoticed. */
  readOnly?: boolean;
  /** The classifier's label is wrong for this task (it is in the set to show what the local signals and escalation recover). */
  misjudged?: boolean;
  /** For `--live`: files to create in a scratch git repository, and a check command (run through `--config`). */
  fixture?: { files: Record<string, string>; verify?: string };
}

export const TASKS: BenchTask[] = [
  {
    id: 'typo-readme', category: 'trivial edit', prompt: 'fix the typo in the README heading',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'easy' }, steps: [{ title: 'Fix typo', difficulty: 0.05, docsOnly: true }], checks: false,
    fixture: { files: { 'README.md': '# Snek game\n\nA small game.\n' } },
  },
  {
    id: 'typo-code', category: 'typo fix', prompt: 'fix the typo in the error message in src/server.js',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'easy' }, steps: [{ title: 'Fix typo', difficulty: 0.12 }], checks: true,
    fixture: {
      files: { 'src/server.js': "export function start(port) {\n  if (!port) throw new Error('port is requried');\n  return port;\n}\n", 'package.json': '{"type":"module"}\n' },
      verify: 'node -e "import(\'./src/server.js\').then(m=>{try{m.start()}catch(e){if(e.message!==\'port is required\')process.exit(1)}})"',
    },
  },
  {
    id: 'question-general', category: 'simple question', prompt: 'what is the difference between let and const in JavaScript?',
    classifier: { complexity: 'trivial', needsPlan: false, difficulty: 'easy', answer: '`const` cannot be reassigned; `let` can.' }, steps: [{ title: 'Answer', difficulty: 0.05 }], checks: false, readOnly: true,
  },
  {
    id: 'question-code', category: 'simple question', prompt: 'how does the retry logic in src/http.ts decide when to give up?',
    classifier: { complexity: 'trivial', needsPlan: false, difficulty: 'normal' }, steps: [{ title: 'Explain', difficulty: 0.3 }], checks: false, readOnly: true,
  },
  {
    id: 'bugfix', category: 'ordinary bug fix', prompt: 'the date picker shows the wrong month in January; fix it',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'normal' }, steps: [{ title: 'Fix month', difficulty: 0.38 }], checks: true,
  },
  {
    id: 'feature', category: 'multi-file feature', prompt: 'add a dark mode toggle to the settings page and remember the choice',
    classifier: { complexity: 'multi_file', needsPlan: true, difficulty: 'normal' },
    steps: [{ title: 'Theme state and storage', plannerDifficulty: 'normal', difficulty: 0.35 }, { title: 'Toggle in settings', plannerDifficulty: 'easy', difficulty: 0.25 }], checks: true,
  },
  {
    id: 'build', category: 'large build', prompt: 'build a snake game with a score board and three levels',
    classifier: { complexity: 'large_build', needsPlan: true, difficulty: 'normal' },
    steps: [
      { title: 'Game loop and board', plannerDifficulty: 'normal', difficulty: 0.4 },
      { title: 'Levels and speed', plannerDifficulty: 'normal', difficulty: 0.42 },
      { title: 'Score board', plannerDifficulty: 'easy', difficulty: 0.25 },
    ], checks: true,
  },
  {
    id: 'architecture', category: 'architecture change', prompt: 'split the monolithic server into separate auth and billing modules with clear interfaces',
    classifier: { complexity: 'large_build', needsPlan: true, difficulty: 'hard' },
    steps: [
      { title: 'Define module boundaries', plannerDifficulty: 'hard', difficulty: 0.72 },
      { title: 'Move auth', plannerDifficulty: 'normal', difficulty: 0.5 },
      { title: 'Move billing', plannerDifficulty: 'normal', difficulty: 0.5 },
    ], checks: true,
  },
  {
    id: 'security', category: 'security issue', prompt: 'fix the SQL injection in the search endpoint',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'hard' }, steps: [{ title: 'Parameterise query', difficulty: 0.6 }], checks: true,
  },
  {
    id: 'race', category: 'concurrency', prompt: 'fix the race condition in the job queue worker that sometimes runs a job twice',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'hard' }, steps: [{ title: 'Fix race', difficulty: 0.78 }], checks: true,
  },
  {
    id: 'perf', category: 'performance', prompt: 'the report export is slow for large accounts; optimize it',
    classifier: { complexity: 'multi_file', needsPlan: false, difficulty: 'normal' }, steps: [{ title: 'Optimize export', difficulty: 0.6 }], checks: true,
  },
  {
    id: 'debug', category: 'investigation', prompt: 'tests fail intermittently on CI with a timeout in test/api.test.ts; find the root cause and fix it',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'hard' }, steps: [{ title: 'Find and fix', difficulty: 0.75 }], checks: true,
  },
  {
    id: 'migration', category: 'migration', prompt: 'migrate the users table to store emails case-insensitively, with a backfill',
    classifier: { complexity: 'multi_file', needsPlan: true, difficulty: 'hard' },
    steps: [{ title: 'Schema change', plannerDifficulty: 'normal', difficulty: 0.5 }, { title: 'Backfill', plannerDifficulty: 'hard', difficulty: 0.65 }], checks: true,
  },
  {
    id: 'docs', category: 'documentation only', prompt: 'document the public API of src/client.ts in docs/api.md',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'easy' }, steps: [{ title: 'Write docs', difficulty: 0.3, docsOnly: true }], checks: true,
  },
  {
    id: 'vague', category: 'ambiguous', prompt: 'make the dashboard better',
    classifier: { complexity: 'multi_file', needsPlan: false, difficulty: 'normal' }, steps: [{ title: 'Improve', difficulty: 0.5 }], checks: false,
  },
  {
    id: 'escalate', category: 'needs escalation', prompt: 'the parser drops the last token when the input ends with a comment',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'normal' }, steps: [{ title: 'Fix parser', difficulty: 0.7 }], checks: true, misjudged: true,
  },
  {
    id: 'caught', category: 'verification catches a wrong result', prompt: 'round prices to two decimals wherever money is shown',
    classifier: { complexity: 'small_edit', needsPlan: false, difficulty: 'easy' }, steps: [{ title: 'Round prices', difficulty: 0.48 }], checks: true, misjudged: true,
  },
  {
    id: 'rename', category: 'cross-cutting rename', prompt: 'rename getUser to fetchUser across the codebase',
    classifier: { complexity: 'multi_file', needsPlan: false, difficulty: 'easy' }, steps: [{ title: 'Rename', difficulty: 0.28 }], checks: true,
  },
];

import type { Agent } from '../types';

/**
 * Copy pools for locally simulated agent activity. Kept out of the reducer so
 * the state machine stays readable and the wording is easy to tune.
 */

export const TASK_POOL: string[] = [
  'Summarize this week customer interviews',
  'Audit onboarding funnel drop-off',
  'Draft release notes for v2.5',
  'Compare vendor pricing for analytics tooling',
  'Triage the overnight error backlog',
  'Build a churn risk shortlist',
  'Review pull requests awaiting a second opinion',
  'Reconcile last month expense reports',
];

export const PROGRESS_POOL: string[] = [
  'Working through the source material now.',
  'Halfway done — early results look consistent.',
  'Cross-checking my findings against last quarter.',
  'Cleaning up the output before I hand it over.',
];

export const MESSAGE_POOL: string[] = [
  'Finished the first pass. Two findings look worth your time.',
  'One source contradicts the others — I went with the most recent.',
  'This took longer than expected; the dataset was messier than advertised.',
  'I can go deeper on any section if you want more detail.',
  'Quick note: I skipped three records that looked like duplicates.',
];

export const COMPLETION_POOL: string[] = [
  'Task complete. Summary and sources are attached.',
  'Done — everything checked out on the second pass.',
  'Finished ahead of schedule. No blockers found.',
  'Complete. I flagged two items for your review later.',
];

export const FAILURE_POOL: string[] = [
  'Run failed: the upstream API returned 502 three times in a row.',
  'Stopped early: I hit the rate limit and could not continue.',
  'Failed to finish — a required credential appears to have expired.',
  'Run aborted: the input file was malformed past row 4,200.',
];

export interface SimulatedApproval {
  title: string;
  description: string;
  message: string;
}

export const APPROVAL_POOL: SimulatedApproval[] = [
  {
    title: 'Purchase report access',
    description:
      'The full competitor report costs $180 and unlocks pricing history for all 14 vendors.',
    message: 'I need approval before purchasing access to the full report.',
  },
  {
    title: 'Send outreach emails',
    description:
      'I drafted 24 personalised emails to shortlisted candidates. Sending is not reversible.',
    message: 'I need your approval before sending these emails.',
  },
  {
    title: 'Delete stale records',
    description:
      'I found 1,842 duplicate customer records. Removing them permanently rewrites the table.',
    message: 'Can I go ahead and delete the duplicates?',
  },
  {
    title: 'Run the paid enrichment job',
    description:
      'Enriching 3,400 leads costs roughly $95 in API credits at current rates.',
    message: 'This one costs money, so I want your sign-off first.',
  },
];

export const INPUT_POOL: string[] = [
  'Which timeframe should I use — last quarter or the trailing twelve months?',
  'Do you want this written for the exec team or the engineering team?',
  'I need a budget ceiling before I can shortlist vendors.',
  'Should I include churned customers in the analysis?',
];

export function pickOne<T>(items: readonly T[], seed: number = Math.random()): T {
  const index = Math.floor(seed * items.length) % items.length;
  return items[index] as T;
}

/** Prefers an agent matching the predicate; falls back to any agent. */
export function pickAgent(
  agents: Agent[],
  prefer: (agent: Agent) => boolean,
): Agent | null {
  if (agents.length === 0) return null;
  const preferred = agents.filter(prefer);
  const pool = preferred.length > 0 ? preferred : agents;
  return pickOne(pool);
}

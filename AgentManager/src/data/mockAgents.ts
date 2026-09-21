import type { Agent, AgentEvent, ApprovalRequest } from '../types';

/**
 * All mock timestamps are generated relative to app launch so the prototype
 * always looks freshly active rather than frozen on a hardcoded date.
 */
const BOOT = Date.now();

export function minutesAgo(mins: number): string {
  return new Date(BOOT - mins * 60_000).toISOString();
}

export const mockAgents: Agent[] = [
  {
    id: 'agt_research',
    name: 'Research Agent',
    provider: 'openai',
    account: 'personal@openai',
    status: 'running',
    currentTask: 'Research AI CRM competitors',
    startedAt: minutesAgo(34),
    lastUpdated: minutesAgo(3),
    unread: 2,
    avatar: 'RE',
  },
  {
    id: 'agt_coding',
    name: 'Coding Agent',
    provider: 'anthropic',
    account: 'eng-team@anthropic',
    status: 'needs_approval',
    currentTask: 'Deploy updated authentication service',
    startedAt: minutesAgo(52),
    lastUpdated: minutesAgo(6),
    unread: 1,
    avatar: 'CO',
  },
  {
    id: 'agt_recruiting',
    name: 'Recruiting Agent',
    provider: 'openai',
    account: 'people-ops@openai',
    status: 'needs_approval',
    currentTask: 'Source senior iOS engineers',
    startedAt: minutesAgo(97),
    lastUpdated: minutesAgo(22),
    unread: 1,
    avatar: 'RC',
  },
  {
    id: 'agt_finance',
    name: 'Finance Agent',
    provider: 'custom',
    account: 'internal-ops',
    status: 'needs_input',
    currentTask: 'Prepare cash flow analysis',
    startedAt: minutesAgo(78),
    lastUpdated: minutesAgo(14),
    unread: 1,
    avatar: 'FI',
  },
  {
    id: 'agt_pipeline',
    name: 'Data Pipeline Agent',
    provider: 'custom',
    account: 'internal-ops',
    status: 'failed',
    currentTask: 'Sync nightly analytics warehouse',
    startedAt: minutesAgo(180),
    lastUpdated: minutesAgo(41),
    unread: 1,
    avatar: 'DP',
  },
  {
    id: 'agt_content',
    name: 'Content Agent',
    provider: 'google',
    account: 'marketing@google',
    status: 'running',
    currentTask: 'Draft six onboarding blog posts',
    startedAt: minutesAgo(19),
    lastUpdated: minutesAgo(2),
    unread: 0,
    avatar: 'CN',
  },
  {
    id: 'agt_marketing',
    name: 'Marketing Agent',
    provider: 'google',
    account: 'marketing@google',
    status: 'completed',
    currentTask: 'Generate Q4 campaign concepts',
    startedAt: minutesAgo(240),
    lastUpdated: minutesAgo(96),
    unread: 0,
    avatar: 'MK',
  },
  {
    id: 'agt_qa',
    name: 'QA Agent',
    provider: 'anthropic',
    account: 'eng-team@anthropic',
    status: 'completed',
    currentTask: 'Regression-test the checkout flow',
    startedAt: minutesAgo(310),
    lastUpdated: minutesAgo(148),
    unread: 0,
    avatar: 'QA',
  },
  {
    id: 'agt_support',
    name: 'Support Agent',
    provider: 'openai',
    account: 'personal@openai',
    status: 'idle',
    currentTask: null,
    startedAt: null,
    lastUpdated: minutesAgo(420),
    unread: 0,
    avatar: 'SU',
  },
];

export const mockApprovals: ApprovalRequest[] = [
  {
    id: 'apr_deploy_auth',
    agentId: 'agt_coding',
    title: 'Deploy to production',
    description:
      'Authentication service v2.4.1 passed all 214 tests in staging. Deploying ' +
      'replaces the running production build and briefly invalidates active sessions.',
    status: 'pending',
    createdAt: minutesAgo(6),
  },
  {
    id: 'apr_candidate_db',
    agentId: 'agt_recruiting',
    title: 'Purchase candidate database access',
    description:
      'A 30-day seat on the sourcing platform costs $240 and unlocks contact ' +
      'details for the 38 shortlisted iOS engineers.',
    status: 'pending',
    createdAt: minutesAgo(22),
  },
];

export const mockEvents: AgentEvent[] = [
  // Research Agent — the worked example from the brief.
  {
    id: 'evt_res_1',
    agentId: 'agt_research',
    type: 'started',
    message: 'Started researching AI CRM competitors.',
    timestamp: minutesAgo(34),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_res_2',
    agentId: 'agt_research',
    type: 'progress',
    message: 'Researching competitors…',
    timestamp: minutesAgo(28),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_res_3',
    agentId: 'agt_research',
    type: 'message',
    message: 'I found 14 competitors and analyzed their pricing.',
    timestamp: minutesAgo(9),
    requiresAction: false,
    read: false,
  },
  {
    id: 'evt_res_4',
    agentId: 'agt_research',
    type: 'message',
    message:
      'Three of them changed pricing in the last quarter. Want me to chart the movement?',
    timestamp: minutesAgo(3),
    requiresAction: false,
    read: false,
  },

  // Coding Agent — pending approval.
  {
    id: 'evt_cod_1',
    agentId: 'agt_coding',
    type: 'started',
    message: 'Started work on the authentication service update.',
    timestamp: minutesAgo(52),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_cod_2',
    agentId: 'agt_coding',
    type: 'progress',
    message: 'Rewrote token refresh handling and added 18 regression tests.',
    timestamp: minutesAgo(31),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_cod_3',
    agentId: 'agt_coding',
    type: 'message',
    message: 'All 214 tests pass in staging.',
    timestamp: minutesAgo(12),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_cod_4',
    agentId: 'agt_coding',
    type: 'approval_request',
    message: 'I need approval before deploying to production.',
    timestamp: minutesAgo(6),
    requiresAction: true,
    read: false,
    approvalId: 'apr_deploy_auth',
  },

  // Recruiting Agent — pending approval.
  {
    id: 'evt_rec_1',
    agentId: 'agt_recruiting',
    type: 'progress',
    message: 'Shortlisted 38 senior iOS engineers from 1,240 profiles.',
    timestamp: minutesAgo(40),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_rec_2',
    agentId: 'agt_recruiting',
    type: 'approval_request',
    message: 'I need approval before purchasing access to the full report.',
    timestamp: minutesAgo(22),
    requiresAction: true,
    read: false,
    approvalId: 'apr_candidate_db',
  },

  // Finance Agent — needs input.
  {
    id: 'evt_fin_1',
    agentId: 'agt_finance',
    type: 'progress',
    message: 'Reconciled 412 transactions across three accounts.',
    timestamp: minutesAgo(46),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_fin_2',
    agentId: 'agt_finance',
    type: 'input_request',
    message:
      'Which currency should the consolidated forecast use — SEK or USD?',
    timestamp: minutesAgo(14),
    requiresAction: true,
    read: false,
  },

  // Data Pipeline Agent — failure.
  {
    id: 'evt_pip_1',
    agentId: 'agt_pipeline',
    type: 'progress',
    message: 'Loaded 2.1M rows into the staging warehouse.',
    timestamp: minutesAgo(64),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_pip_2',
    agentId: 'agt_pipeline',
    type: 'failed',
    message:
      'Sync failed: connection to the warehouse timed out after 3 retries.',
    timestamp: minutesAgo(41),
    requiresAction: true,
    read: false,
  },

  // Content Agent — quietly running.
  {
    id: 'evt_con_1',
    agentId: 'agt_content',
    type: 'started',
    message: 'Started drafting six onboarding blog posts.',
    timestamp: minutesAgo(19),
    requiresAction: false,
    read: true,
  },
  {
    id: 'evt_con_2',
    agentId: 'agt_content',
    type: 'progress',
    message: 'Two drafts complete, four in progress.',
    timestamp: minutesAgo(2),
    requiresAction: false,
    read: true,
  },

  // Marketing Agent — completed today.
  {
    id: 'evt_mkt_1',
    agentId: 'agt_marketing',
    type: 'completed',
    message: 'Delivered 12 campaign concepts with headline variants.',
    timestamp: minutesAgo(96),
    requiresAction: false,
    read: true,
  },

  // QA Agent — completed today.
  {
    id: 'evt_qa_1',
    agentId: 'agt_qa',
    type: 'completed',
    message: 'Checkout regression suite passed — 3 flaky tests quarantined.',
    timestamp: minutesAgo(148),
    requiresAction: false,
    read: true,
  },

  // Support Agent — historical, now idle.
  {
    id: 'evt_sup_1',
    agentId: 'agt_support',
    type: 'completed',
    message: 'Cleared the overnight ticket backlog (26 tickets).',
    timestamp: minutesAgo(420),
    requiresAction: false,
    read: true,
  },
];

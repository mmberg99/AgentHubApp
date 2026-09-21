#!/usr/bin/env node
/**
 * Sends one synthetic AgentNotificationEvent to the relay's ingestion port,
 * over the exact path a real notifier uses: loopback HTTP, bearer token,
 * protocol validation, push.
 *
 *   node bin/send-test-event.mjs completed
 *   node bin/send-test-event.mjs needs_approval
 *
 * Text is fixed and generic. Nothing here reads a transcript, a prompt, a file
 * or any tool output — there is no code path by which it could.
 */

import { randomUUID } from 'node:crypto';

import { BIND_HOST, INGEST_PORT, INGEST_TOKEN } from '../src/config.mjs';

const TYPES = ['started', 'running', 'idle', 'completed', 'needs_approval', 'needs_input', 'failed'];

const type = process.argv[2] ?? 'completed';
if (!TYPES.includes(type)) {
  console.error(`[test] unknown type "${type}". One of: ${TYPES.join(', ')}`);
  process.exit(1);
}

// Optional second argument overrides the eventId, so duplicate suppression can
// be exercised by sending the same id twice.
const eventId = process.argv[3] ?? randomUUID();

const MESSAGES = {
  started: 'Claude Code started a session.',
  running: 'Claude Code is working on a task.',
  idle: 'Claude Code is waiting for background work to finish.',
  completed: 'Claude Code completed a task.',
  needs_approval: 'Claude Code needs your approval.',
  needs_input: 'Claude Code is waiting for your input.',
  failed: 'Claude Code failed a task.',
};

const event = {
  version: 1,
  eventId,
  agentId: 'win_claude_code',
  agentName: 'Claude Code',
  type,
  title: 'Claude Code',
  message: MESSAGES[type],
  timestamp: new Date().toISOString(),
  provider: 'claude',
};

const response = await fetch(`http://${BIND_HOST}:${INGEST_PORT}/events`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${INGEST_TOKEN}`,
  },
  body: JSON.stringify(event),
});

const body = await response.json().catch(() => ({}));
console.log(`[test] type=${type} eventId=${eventId}`);
console.log(`[test] HTTP ${response.status} ${JSON.stringify(body)}`);
process.exit(response.ok ? 0 : 1);

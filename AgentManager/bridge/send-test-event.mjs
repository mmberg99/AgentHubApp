#!/usr/bin/env node
/**
 * Sends one harmless test event to the AgentHub bridge.
 *
 * Useful on the Mac to prove the pipeline before involving Windows, and it runs
 * on Windows too (any machine with Node 18+).
 *
 *   AGENTHUB_BRIDGE_TOKEN=... node bridge/send-test-event.mjs
 *   AGENTHUB_BRIDGE_TOKEN=... node bridge/send-test-event.mjs failed
 *   AGENTHUB_BRIDGE_TOKEN=... node bridge/send-test-event.mjs completed --url http://192.168.1.42:8787
 *
 * Payloads carry status text only — never code, prompts, file contents or secrets.
 */

import { randomUUID } from 'node:crypto';

const TOKEN = process.env.AGENTHUB_BRIDGE_TOKEN ?? '';
if (!TOKEN) {
  console.error('AGENTHUB_BRIDGE_TOKEN is not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : 'http://127.0.0.1:8787';
const type = args.find((a) => !a.startsWith('--') && a !== baseUrl) ?? 'completed';

const TEMPLATES = {
  started: ['Claude Code started a task', 'A task has started on your Windows PC.'],
  running: ['Claude Code is working', 'A task is in progress on your Windows PC.'],
  completed: ['Claude Code finished a task', 'The task completed successfully on your Windows PC.'],
  needs_approval: ['Claude Code needs approval', 'A step is waiting for your approval on your Windows PC.'],
  needs_input: ['Claude Code needs input', 'A question is waiting for your answer on your Windows PC.'],
  failed: ['Claude Code failed', 'A task stopped with an error on your Windows PC.'],
};

const template = TEMPLATES[type];
if (!template) {
  console.error(`Unknown type "${type}". Use one of: ${Object.keys(TEMPLATES).join(', ')}`);
  process.exit(1);
}

const event = {
  version: 1,
  eventId: randomUUID(),
  agentId: 'win_claude_code',
  agentName: 'Claude Code',
  type,
  title: template[0],
  message: template[1],
  timestamp: new Date().toISOString(),
  provider: 'claude',
};

const target = `${baseUrl.replace(/\/$/, '')}/events`;

try {
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(event),
  });

  const text = await response.text();
  console.log(`POST ${target} -> ${response.status} ${text}`);
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.error(`Failed to reach ${target}: ${error.message}`);
  console.error('Is the bridge running, and is the Mac firewall allowing the connection?');
  process.exit(1);
}

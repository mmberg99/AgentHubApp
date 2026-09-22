/**
 * Summarisation through the local Claude CLI, on this machine's existing
 * Claude subscription. No API key exists or is read anywhere in this file.
 *
 * WHAT LEAVES THIS MACHINE. The text of the single message being summarised,
 * and the fixed instructions. It travels on the child's STDIN, never on the
 * command line, so it is not visible in a process listing and cannot land in
 * a shell history. No identifier goes with it: not the messageId, taskId,
 * subtaskId, project, path or timestamp.
 *
 * WHY THE FLAGS ARE NOT OPTIONAL. A plain `claude -p` on this machine is not a
 * neutral text-in/text-out call. Measured behaviour, all of it corrected here:
 *
 *   - It runs the user's own AgentHub notifier hooks from ~/.claude/settings.json,
 *     which post the summarised message straight back into AgentHub as a new
 *     task and push a notification — a summary that feeds itself more work to
 *     summarise. `--settings {"disableAllHooks":true}` stops this. It applies
 *     to one invocation, above the user's files, and writes to no file.
 *   - It loads every MCP server the user has, including remote ones.
 *     `--disallowedTools mcp__*` with `--strict-mcp-config` removes them.
 *   - It loads the user's skills and slash commands. `--disable-slash-commands`
 *     removes them.
 *   - It writes a full transcript of the run, the summarised message included,
 *     into ~/.claude/projects. `--no-session-persistence` stops that: nothing
 *     is written and the session cannot be resumed.
 *
 * WHY NOT `--disallowedTools *`. It also removes the internal StructuredOutput
 * tool that `--json-schema` is delivered through, and the run then fails with
 * the card already written but denied. The tool surface is an allowlist of
 * exactly that one tool instead.
 *
 * FAILURE IS NEVER RETRIED HERE. A CLI failure is most often a usage limit or
 * an authentication problem, neither of which a retry improves, and both of
 * which cost subscription allowance to rediscover. Every failure is reported
 * as non-retryable so the caller falls back to its local preview at once and
 * waits out a cooldown before trying that message again.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
  SUMMARY_CLI_EFFORT,
  SUMMARY_CLI_MAX_TURNS,
  SUMMARY_CLI_MODEL,
  SUMMARY_CLI_PATH,
  SUMMARY_CLI_TIMEOUT_MS,
} from '../config.mjs';
import { SummaryError, validateCard } from './summaryCard.mjs';
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, wrapMessage } from './summaryPrompt.mjs';

/** Recorded on every card this provider produces. */
export const PROVIDER_NAME = 'claude-cli';

/**
 * The hook kill switch, as a literal. It is asserted before every spawn, so a
 * future edit that drops or mangles it fails the run instead of quietly
 * letting a summariser trigger the user's own hooks.
 */
export const HOOK_SETTINGS = '{"disableAllHooks":true}';

/** Env names the child must never see. */
const SCRUBBED_ENV_PREFIX = 'AGENTHUB_';

/**
 * The exact argument list. Pure, so a test can assert every flag without
 * running anything.
 */
export function buildCliArgs(options = {}) {
  const schema = options.schema ?? SUMMARY_SCHEMA;
  return [
    '-p', SYSTEM_PROMPT,
    // Nothing about this run is written to disk or can be resumed.
    '--no-session-persistence',
    // The user's own hooks must not run for a summary.
    '--settings', HOOK_SETTINGS,
    // The only tool in the session is the one --json-schema needs.
    '--tools', 'StructuredOutput',
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config',
    '--disable-slash-commands',
    // Nobody is here to answer a prompt; anything that would ask is denied.
    '--permission-prompts', 'none',
    '--max-turns', String(options.maxTurns ?? SUMMARY_CLI_MAX_TURNS),
    '--model', options.model ?? SUMMARY_CLI_MODEL,
    '--effort', options.effort ?? SUMMARY_CLI_EFFORT,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
  ];
}

/**
 * Fails closed if the containment flags are not all present and correct.
 * Called immediately before spawning, never skipped.
 */
export function assertContained(args) {
  const pairs = [
    ['--settings', HOOK_SETTINGS],
    ['--tools', 'StructuredOutput'],
    ['--disallowedTools', 'mcp__*'],
    ['--model', null],
    ['--output-format', 'json'],
  ];
  for (const [flag, value] of pairs) {
    const at = args.indexOf(flag);
    if (at === -1) throw new SummaryError(`summariser missing ${flag}`, false);
    if (value !== null && args[at + 1] !== value) {
      throw new SummaryError(`summariser ${flag} was altered`, false);
    }
  }
  for (const flag of [
    '--no-session-persistence',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--json-schema',
  ]) {
    if (!args.includes(flag)) throw new SummaryError(`summariser missing ${flag}`, false);
  }
  // Belt and braces: the settings value must really disable hooks.
  let settings;
  try {
    settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  } catch {
    throw new SummaryError('summariser settings are not JSON', false);
  }
  if (settings?.disableAllHooks !== true) {
    throw new SummaryError('summariser would run hooks', false);
  }
  // A resumed or continued session would reach the user's real conversations.
  for (const forbidden of ['--resume', '--continue', '-c', '--session-id', '--fork-session',
    '--dangerously-skip-permissions', '--bare']) {
    if (args.includes(forbidden)) throw new SummaryError(`summariser must not use ${forbidden}`, false);
  }
  return true;
}

/** The child's environment: the relay's, minus everything AgentHub. */
export function childEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.toUpperCase().startsWith(SCRUBBED_ENV_PREFIX)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Pulls the card out of `--output-format json`. Every failure is final: see
 * the note at the top of this file.
 */
export function parseCliResult(stdout) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new SummaryError('unreadable cli output', false);
  }
  if (typeof body !== 'object' || body === null) throw new SummaryError('unreadable cli output', false);
  if (body.type !== 'result') throw new SummaryError('no cli result', false);
  // `subtype` is the machine-readable outcome. Human-readable text, including
  // anything about usage limits, is never inspected or acted on.
  if (body.subtype !== 'success') throw new SummaryError(`cli ${String(body.subtype)}`, false);
  if (body.is_error === true) throw new SummaryError('cli reported an error', false);
  if (body.structured_output === undefined || body.structured_output === null) {
    throw new SummaryError('no structured output', false);
  }
  return validateCard(body.structured_output);
}

/**
 * One summarisation. Resolves to a card, or throws a SummaryError.
 *
 * `options.spawnImpl` is a test seam; nothing else in the relay passes it.
 */
export async function requestSummary(text, options = {}) {
  const args = buildCliArgs(options);
  assertContained(args);

  // A test that forgets to inject a fake would otherwise start a real Claude
  // process and spend real subscription allowance. The suite sets this.
  if (!options.spawnImpl && process.env.AGENTHUB_NO_REAL_CLI === '1') {
    throw new SummaryError('real cli refused: AGENTHUB_NO_REAL_CLI is set', false);
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? SUMMARY_CLI_TIMEOUT_MS;
  const nonce = randomBytes(8).toString('hex');
  const model = options.model ?? SUMMARY_CLI_MODEL;

  const stdout = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(options.cliPath ?? SUMMARY_CLI_PATH, args, {
        // A neutral directory: no project settings, no CLAUDE.md, no .mcp.json.
        cwd: options.cwd ?? tmpdir(),
        env: childEnv(options.env),
        // No shell: it would mangle the quoting of the JSON arguments.
        shell: false,
        windowsHide: true,
      });
    } catch {
      reject(new SummaryError('cli could not start', false));
      return;
    }

    let out = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new SummaryError('cli timed out', false));
    }, timeoutMs);

    child.on('error', () => finish(reject, new SummaryError('cli could not start', false)));
    child.stdout?.on('data', (chunk) => { out += chunk; });
    // stderr is deliberately not collected: it can carry diagnostic text we
    // have no use for and never want in a log or an error.
    child.stderr?.resume?.();
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new SummaryError(`cli exited ${code}`, false));
        return;
      }
      finish(resolve, out);
    });

    try {
      child.stdin.end(wrapMessage(text, nonce));
    } catch {
      finish(reject, new SummaryError('cli stdin unavailable', false));
    }
  });

  const card = parseCliResult(stdout);
  return { ...card, model, provider: PROVIDER_NAME };
}

/**
 * Nothing to configure: this provider uses the Claude login already on this
 * machine. Whether that login is valid is discovered by running, and a failure
 * is handled like any other.
 */
export function isConfigured() {
  return true;
}

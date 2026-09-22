#!/usr/bin/env node
/**
 * Store the summarisation provider key on this machine, and nowhere else.
 *
 *   npm run set-summarizer-key            read the key from stdin, no echo
 *   npm run set-summarizer-key -- --status    say whether one is configured
 *   npm run set-summarizer-key -- --remove    delete it
 *
 * The key is typed into this terminal, never into a chat, a command line (where
 * it would land in shell history), an environment variable or a source file. It
 * is written to summarizer.json with the same owner-only ACL the VAPID private
 * key gets, and no character of it is ever printed back — not even the last
 * few. The only confirmation is that a key of a plausible length was stored.
 */

import { existsSync, rmSync } from 'node:fs';

import {
  SUMMARIZER_FILE,
  SUMMARY_BACKEND,
  SUMMARY_MODEL,
} from '../src/config.mjs';
import { SUMMARY_PROVIDER } from '../src/summarizer.mjs';
import { readJson, restrictToOwner, writeJsonAtomic } from '../src/storage.mjs';

const args = process.argv.slice(2);

/** Says plainly when a key would be stored but not used. */
function backendNote() {
  if (SUMMARY_BACKEND !== 'anthropic-api') {
    console.log(`  note      AgentHub is summarising with the "${SUMMARY_BACKEND}" backend, so this`);
    console.log('            key is not in use. Set AGENTHUB_SUMMARY_BACKEND=anthropic-api to use it.');
  }
}

function describe() {
  if (!existsSync(SUMMARIZER_FILE)) {
    console.log('summariser: no API key configured');
    if (SUMMARY_BACKEND === 'claude-cli') {
      console.log('  backend   claude-cli - summaries come from this machine\'s Claude');
      console.log('            subscription and need no key at all. Nothing to do here.');
    } else {
      console.log('  AgentHub will use its local preview generator.');
    }
    return;
  }
  const raw = readJson(SUMMARIZER_FILE, null);
  const key = typeof raw?.apiKey === 'string' ? raw.apiKey : '';
  console.log('summariser: configured');
  console.log(`  file      ${SUMMARIZER_FILE}`);
  console.log(`  provider  ${raw?.provider ?? SUMMARY_PROVIDER}`);
  console.log(`  model     ${raw?.model ?? SUMMARY_MODEL}`);
  console.log(`  key       stored (${key.length} characters; no part of it is ever printed)`);
  console.log(`  updated   ${raw?.updatedAt ?? 'unknown'}`);
  backendNote();
}

if (args.includes('--status')) {
  describe();
  process.exit(0);
}

if (args.includes('--remove')) {
  if (existsSync(SUMMARIZER_FILE)) {
    rmSync(SUMMARIZER_FILE, { force: true });
    console.log('summariser key removed. AgentHub falls back to its local preview generator.');
  } else {
    console.log('summariser key was not configured; nothing to remove.');
  }
  process.exit(0);
}

/** Reads a line from the terminal without echoing it. */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      // Piped input: read it, but say so, because a pipe usually means the key
      // came from a file or a command line and may be recoverable elsewhere.
      let piped = '';
      console.warn(
        'Reading the key from a pipe. Prefer running this command directly in a\n' +
          'terminal, where the key is typed with echo off and never stored anywhere\n' +
          'a pipe might have taken it from.',
      );
      input.setEncoding('utf8');
      input.on('data', (chunk) => {
        piped += chunk;
      });
      input.on('end', () => resolve(piped.trim()));
      input.on('error', reject);
      return;
    }

    process.stdout.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();

    let value = '';
    const onData = (char) => {
      switch (char) {
        case '\u0004': // Ctrl+D
        case '\r':
        case '\n':
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        case '\u0003': // Ctrl+C
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        case '\u007f': // Backspace
        case '\b':
          value = value.slice(0, -1);
          return;
        default:
          // Ignore other control characters; take everything else verbatim.
          if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
  });
}

const apiKey = (await readSecret('Anthropic API key (input hidden): ')).trim();

if (apiKey.length < 16) {
  console.error('That does not look like an API key. Nothing was written.');
  process.exit(1);
}
if (/\s/.test(apiKey)) {
  console.error('The key contains whitespace. Nothing was written.');
  process.exit(1);
}
if (!apiKey.startsWith('sk-ant-')) {
  console.warn('Warning: an Anthropic API key normally begins with "sk-ant-". Writing it anyway.');
}

writeJsonAtomic(
  SUMMARIZER_FILE,
  {
    version: 1,
    provider: SUMMARY_PROVIDER,
    model: SUMMARY_MODEL,
    apiKey,
    updatedAt: new Date().toISOString(),
  },
  { secret: true },
);

const locked = restrictToOwner(SUMMARIZER_FILE);
console.log(`Written to ${SUMMARIZER_FILE}`);
console.log(`  key       stored (${apiKey.length} characters; no part of it is ever printed)`);
console.log(`  model     ${SUMMARY_MODEL}`);
console.log(`  ACL       ${locked ? 'restricted to this Windows user' : 'COULD NOT BE RESTRICTED - check the file permissions'}`);
console.log('Restart the relay for it to take effect.');

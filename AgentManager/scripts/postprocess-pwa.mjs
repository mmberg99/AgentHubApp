#!/usr/bin/env node
/**
 * Injects PWA / iOS Home Screen metadata into the exported index.html.
 *
 * WHY POST-PROCESSING RATHER THAN app/+html.tsx
 *   `+html.tsx` only applies to Expo Router's static rendering
 *   (`web.output: "static"`), which renders every route through Node at build
 *   time. This app ships as a single-page export (`web.output: "single"`), so
 *   `+html.tsx` would not be applied to it at all. Switching output modes to
 *   add six tags would be a real behavioural change to a working app. This
 *   script edits only the generated HTML, changes no runtime behaviour, and is
 *   trivially reversible.
 *
 * The script is idempotent: re-running it will not duplicate tags.
 * It hard-codes no hostname; every reference is origin-relative.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const INDEX = join(DIST, 'index.html');
const MARKER = '<!-- agenthub:pwa -->';

if (!existsSync(INDEX)) {
  console.error(`[pwa] ${INDEX} not found. Run the web export first:`);
  console.error('[pwa]   npx expo export --platform web');
  process.exit(1);
}

let html = readFileSync(INDEX, 'utf8');

if (html.includes(MARKER)) {
  console.log('[pwa] metadata already present; nothing to do.');
  process.exit(0);
}

const TAGS = `    ${MARKER}
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#0C0C0F" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="AgentHub" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="application-name" content="AgentHub" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
    <link rel="icon" type="image/png" sizes="512x512" href="/icons/icon-512.png" />
    <!-- /agenthub:pwa -->
`;

if (!html.includes('</head>')) {
  console.error('[pwa] no </head> in exported HTML; refusing to guess where to inject.');
  process.exit(1);
}

html = html.replace('</head>', `${TAGS}  </head>`);
writeFileSync(INDEX, html, 'utf8');
console.log(`[pwa] injected Home Screen metadata into ${INDEX}`);

// Every file the tags point at must actually exist in the export, or the
// install will silently fall back to a screenshot icon on iOS.
const required = [
  'manifest.webmanifest',
  'sw.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

let missing = 0;
for (const rel of required) {
  const ok = existsSync(join(DIST, rel));
  if (!ok) missing += 1;
  console.log(`[pwa]   ${ok ? 'ok     ' : 'MISSING'} ${rel}`);
}

if (missing > 0) {
  console.error(`[pwa] ${missing} required file(s) missing from ${DIST}/.`);
  console.error('[pwa] They belong in public/, which Expo copies into the export.');
  process.exit(1);
}

/*
 * Strip this machine's absolute project path out of the build.
 *
 * React Native's LogBox stack-frame formatter embeds the project root as a
 * string literal so it can shorten paths in its error overlay. That leaks the
 * Mac username into an artifact which is about to be copied to another machine
 * and served to a phone. The value is only ever used to prettify stack traces,
 * so replacing it with a neutral token changes nothing at runtime.
 */
const PROJECT_ROOT = process.cwd();
const TEXT_EXT = new Set(['.js', '.html', '.json', '.webmanifest', '.css', '.txt']);

// The project root can appear in a bundle in several spellings. On Windows the
// native form is `C:\path`, but bundlers commonly normalise to `C:/path`, and
// anything embedded in a JSON string literal arrives double-escaped. All of
// them are the same leak, so all of them are rewritten.
const ROOT_SPELLINGS = [
  PROJECT_ROOT,
  PROJECT_ROOT.replace(/\\/g, '/'),
  PROJECT_ROOT.replace(/\\/g, '\\\\'),
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

let sanitized = 0;
for (const file of walk(DIST)) {
  if (!TEXT_EXT.has(extname(file))) continue;
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const spelling of ROOT_SPELLINGS) {
    if (!after.includes(spelling)) continue;
    after = after.split(spelling).join('/app');
  }
  if (after === before) continue;
  writeFileSync(file, after, 'utf8');
  sanitized += 1;
  console.log(`[pwa] sanitized build path in ${file}`);
}
console.log(`[pwa] path sanitization: ${sanitized} file(s) rewritten.`);

console.log('[pwa] export is PWA-complete.');

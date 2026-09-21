#!/usr/bin/env node
/**
 * Packages the exported web build into a single archive for the Windows host.
 *
 * The archive contains ONLY the static web runtime. No source, no node_modules,
 * no .git, no environment files, no tokens.
 *
 * The build is scanned before packaging: a bearer token or a hard-coded LAN
 * address in a file that is about to leave this machine is a real problem, so
 * the script refuses to produce an archive when it finds one.
 *
 * Archiving is cross-platform. The project now builds on Windows, where the
 * `zip` binary does not exist, so the archive is produced with PowerShell's
 * Compress-Archive there and with `zip` everywhere else. Both paths archive a
 * staging copy of the export, which is how excluded files stay excluded
 * without relying on the differing exclude syntaxes of the two tools.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const DIST = 'dist';
const OUT_DIR = 'build';
const ARCHIVE = join(OUT_DIR, 'AgentHub-PWA.zip');

if (!existsSync(DIST)) {
  console.error(`[pkg] ${DIST}/ not found. Build first:  npm run build:web`);
  process.exit(1);
}

/* ---------------------------------------------------------------- scanning */

const TEXT_EXT = new Set(['.js', '.html', '.json', '.webmanifest', '.css', '.map', '.txt']);

// Patterns that must never appear in an artifact that leaves this Mac.
const FORBIDDEN = [
  { name: 'bridge bearer token env name', re: /AGENTHUB_BRIDGE_TOKEN/ },
  { name: 'Authorization bearer header', re: /Bearer\s+[A-Za-z0-9._-]{12,}/ },
  { name: 'private LAN address (192.168.x.x)', re: /192\.168\.\d{1,3}\.\d{1,3}/ },
  { name: 'private LAN address (10.x.x.x)', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'Mac home directory path', re: /\/Users\/[A-Za-z0-9._-]+\// },
  // The build host is now Windows, so the same leak has a second spelling.
  // Bundlers emit these with forward slashes, single backslashes or
  // JSON-escaped double backslashes depending on how the path was embedded.
  { name: 'Windows user directory path', re: /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[A-Za-z0-9._-]+/ },
  { name: 'Windows drive-absolute path', re: /[A-Za-z]:(?:\\\\|\/)(?:source|Program Files|Windows)(?:\\{1,2}|\/)/ },
  { name: 'AgentHub bridge endpoint env name', re: /AGENTHUB_MAC_ENDPOINT/ },
  { name: 'private key material', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// Loopback is reported but tolerated: it is the documented default of the
// development-only local bridge transport, which must keep working on the Mac.
const LOOPBACK = /127\.0\.0\.1|localhost/;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const files = walk(DIST);
const findings = [];
const loopbackHits = [];

for (const file of files) {
  if (!TEXT_EXT.has(extname(file))) continue;
  const content = readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) {
    if (rule.re.test(content)) findings.push(`${relative(DIST, file)}: ${rule.name}`);
  }
  if (LOOPBACK.test(content)) loopbackHits.push(relative(DIST, file));
}

console.log(`[pkg] scanned ${files.length} files in ${DIST}/`);

if (loopbackHits.length > 0) {
  console.log('[pkg] loopback references (expected - dev bridge default, harmless when unreachable):');
  for (const hit of loopbackHits) console.log(`[pkg]   ${hit}`);
}

if (findings.length > 0) {
  console.error('[pkg] REFUSING TO PACKAGE - forbidden content found:');
  for (const f of findings) console.error(`[pkg]   ${f}`);
  process.exit(1);
}

console.log('[pkg] no secrets, credentials or private network addresses found.');

/* --------------------------------------------------------------- packaging */

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(ARCHIVE)) rmSync(ARCHIVE);

// Files that belong to the build, not to the runtime the browser loads.
// metadata.json is Expo's export bookkeeping; .DS_Store is Finder noise that
// rode along from the project's macOS history.
const EXCLUDE = new Set(['metadata.json', '.DS_Store', 'Thumbs.db']);

// Stage the exact archive contents in a scratch directory. Doing the filtering
// here rather than in the archiver's own exclude syntax keeps the two
// platforms producing byte-identical file lists.
const STAGE = join(OUT_DIR, '.archive-staging');
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
cpSync(DIST, STAGE, {
  recursive: true,
  filter: (src) => !EXCLUDE.has(src.split(/[\\/]/).pop()),
});

function hasZipBinary() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (hasZipBinary()) {
  // -r recurse, -q quiet, -X drop extended attributes/resource forks.
  // Run from inside the staging dir so archive paths are relative to the web root.
  execFileSync('zip', ['-r', '-q', '-X', resolve(ARCHIVE), '.'], { cwd: STAGE });
  console.log('[pkg] archived with zip.');
} else if (process.platform === 'win32') {
  // Entries are added one at a time with an explicitly forward-slashed name.
  // Both Compress-Archive and ZipFile::CreateFromDirectory write Windows
  // backslashes into entry names on this runtime, which the ZIP spec forbids
  // (4.4.17.1: separators are always '/'). Tools on the unpacking side are
  // then free to treat the backslash as part of the filename, which flattens
  // the whole export into junk names at the web root.
  const script = join(OUT_DIR, '.archive.ps1');
  writeFileSync(
    script,
    [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$stage = '${resolve(STAGE)}'`,
      `$dest  = '${resolve(ARCHIVE)}'`,
      '$zip = [System.IO.Compression.ZipFile]::Open($dest, "Create")',
      'try {',
      '  Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {',
      '    $rel = $_.FullName.Substring($stage.Length + 1).Replace("\\", "/")',
      '    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)',
      '  }',
      '} finally { $zip.Dispose() }',
    ].join('\n'),
    'utf8',
  );
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(script)],
    { stdio: 'inherit' },
  );
  rmSync(script, { force: true });
  console.log('[pkg] archived with System.IO.Compression (no zip binary on this host).');
} else {
  console.error('[pkg] no `zip` binary found and this is not Windows; cannot create the archive.');
  console.error('[pkg] install zip, or archive build/.archive-staging/ by hand.');
  process.exit(1);
}

rmSync(STAGE, { recursive: true, force: true });

const size = statSync(ARCHIVE).size;
console.log(`[pkg] created ${ARCHIVE} (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log('[pkg] archive root is the web root: index.html sits at the top level.');

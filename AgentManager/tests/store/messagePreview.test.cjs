/**
 * Collapsed conversation cards: the locally derived preview.
 *
 *   npm run test:store
 *
 * Everything here is pure: text in, a title and a short body out. No model, no
 * network, no stored summary. The original message is never modified — the
 * expanded card renders the very same string these tests pass in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BUILD = path.join(__dirname, '.build');
const { buildMessagePreview, clearMessagePreviewCache } = require(
  path.join(BUILD, 'lib', 'messagePreview.js'),
);

const preview = (text, role = 'assistant') => buildMessagePreview(text, role);
const joined = (p) => [p.title ?? '', p.paragraph ?? '', ...p.bullets].join('\n');

/* ------------------------------------------------------------- fixtures */

const STRUCTURED = [
  '## Implemented conversation improvements',
  '',
  'Here is what changed in this release. Everything is staged and nothing has been deployed yet.',
  '',
  '- Newest messages appear **first** in the conversation',
  '- Markdown now renders correctly instead of showing raw markers',
  '- Subtask completion alerts can be disabled from Settings',
  '- Existing conversation storage remains unchanged',
  '- Mobile layout still works correctly at iPhone width',
  '',
  'Let me know if you want anything adjusted before I deploy this to the live directory.',
].join('\n');

const PARAGRAPH = [
  'I looked into the authentication failure and found the cause.',
  'The relay was rejecting the capability token because the subscription record had been pruned',
  'by Apple after the endpoint expired, so every read returned a 401 even though the phone still',
  'had a token stored locally. Re-registering the device mints a fresh token and the reads succeed',
  'again, which is why the problem disappeared after you re-enabled notifications on the phone.',
].join(' ');

const CODE_HEAVY = [
  'Fixed the lifecycle classification.',
  '',
  'The stop handler now checks for outstanding work before reporting completion:',
  '',
  '```ts',
  'function classifyStop(context) {',
  '  if (context.hasBackgroundWork || context.hasScheduledWork) {',
  '    return "idle";',
  '  }',
  '  return "completed";',
  '}',
  '// SENTINEL_CODE_ONLY_MARKER',
  '```',
  '',
  'All 243 notifier tests pass.',
].join('\n');

const LONG_PROMPT = [
  'I want three UX improvements in AgentHub. I would like them staged rather than deployed so I can review them first.',
  '',
  '- Show newest messages first in the conversation',
  '- Improve message formatting so Markdown renders',
  '- Add a control over subtask notifications',
  '- Keep the stored conversation exactly as it is',
  '',
  'Do not deploy. Build, test and stage only, then stop for approval when the bundle is ready.',
].join('\n');

test.beforeEach(() => clearMessagePreviewCache());

/* -------------------------------------------------- collapse or show whole */

test('1. a long Claude response is collapsed by default', () => {
  const p = preview(STRUCTURED);
  assert.equal(p.needsExpansion, true);
  assert.ok(p.title);
  assert.ok(p.bullets.length > 0);
});

test('2. a long user prompt is collapsed by default', () => {
  const p = preview(LONG_PROMPT, 'user');
  assert.equal(p.needsExpansion, true);
  assert.ok(p.title);
});

test('3. a short Claude response is shown whole, with no expand action', () => {
  for (const short of [
    'Done. All 74 tests pass.',
    'Deployed. The live bundle is entry-8c1e9995.',
    'Yes, that works.',
  ]) {
    assert.equal(preview(short).needsExpansion, false, short);
  }
});

test('4. a short user prompt is shown whole', () => {
  for (const short of ['Run the tests.', 'Deploy it.', 'Looks good, ship it.']) {
    assert.equal(preview(short, 'user').needsExpansion, false, short);
  }
});

test('a card is only offered when it is clearly shorter than the message', () => {
  const borderline = `${'The relay restart completed and both subscriptions loaded correctly. '.repeat(4)}Nothing else changed.`;
  const p = preview(borderline);
  if (p.needsExpansion) {
    const shown = (p.title?.length ?? 0) + (p.paragraph?.length ?? 0);
    assert.ok(shown < borderline.length * 0.75, 'a collapsed card must be clearly shorter');
  }
  // A message that is nothing but its own bullets gains nothing from a card.
  const bulletsOnly = ['- Relay restarted', '- PWA deployed', '- Tests passing', '- Backups made', '- Rollback ready', '- Hooks unchanged', '- VAPID untouched'].join('\n');
  assert.equal(preview(bulletsOnly).needsExpansion, false);
});

/* ------------------------------------------------------------------ title */

test('5. the title is clean: no Markdown markers, no trailing punctuation', () => {
  const p = preview(STRUCTURED);
  assert.equal(p.title, 'Implemented conversation improvements');
  assert.equal(/[#*`_>]/.test(p.title), false);
});

test('a generic heading is skipped in favour of the first real sentence', () => {
  const p = preview(['## Summary', ...STRUCTURED.split('\n').slice(1)].join('\n'));
  assert.notEqual(p.title, 'Summary');
  assert.equal(p.title, 'Here is what changed in this release');
});

test('a title is never raw code, a bare URL or punctuation', () => {
  const urlOnly = `https://example.test/a/very/long/path/that/goes/on\n\n${'x '.repeat(200)}`;
  assert.equal(/^https?:\/\//.test(preview(urlOnly).title ?? ''), false);
  const codeFirst = [
    '```js',
    'const x = 1;',
    'console.log(x);',
    'const y = 2;',
    '```',
    '',
    'That is the fix, and it works. I verified it against the staged build and every suite passes.',
  ].join('\n');
  assert.equal(preview(codeFirst).title, 'That is the fix, and it works');
});

test('a user prompt takes its subject from its own words, never reinterpreted', () => {
  const p = preview(LONG_PROMPT, 'user');
  assert.equal(p.title, 'I want three UX improvements in AgentHub');
  assert.ok(LONG_PROMPT.includes(p.title), "the title is the user's own text");
});

/* -------------------------------------------------- paragraph vs bullets */

test('6. a paragraph-style response produces a concise paragraph, not bullets', () => {
  const p = preview(PARAGRAPH);
  assert.equal(p.kind, 'paragraph');
  assert.equal(p.bullets.length, 0);
  assert.ok(p.paragraph);
  assert.ok(p.paragraph.length <= 201, String(p.paragraph.length));
  assert.ok(p.paragraph.length < PARAGRAPH.length * 0.7);
  assert.equal(p.paragraph.includes('  '), false, 'whitespace is collapsed');
  assert.equal(p.paragraph.startsWith('I looked into the authentication'), false, 'the title is not repeated');
});

test('7. a structured response produces bullets carrying its real points', () => {
  const p = preview(STRUCTURED);
  assert.equal(p.kind, 'bullets');
  assert.ok(p.bullets.some((b) => b.includes('Newest messages appear first')));
  assert.ok(p.bullets.some((b) => b.includes('Markdown now renders')));
  assert.ok(p.bullets.some((b) => b.includes('Subtask completion alerts')));
});

test('8 + 9. the bullet count follows the content, with no hard cap at 4', () => {
  const two = preview([
    'Two things changed in this release of the app, and both of them are small.',
    '',
    '- Relay restarted cleanly with both subscriptions loaded',
    '- PWA deployed to the live directory and verified over Tailscale',
    '',
    'Nothing else was touched during this deployment window, and the rollback backup is in place.',
    'I have left everything else on the machine exactly as it was.',
  ].join('\n'));
  assert.equal(two.bullets.length, 2);

  const eight = preview([
    'Release notes for this deployment, covering everything that changed tonight.',
    '',
    '- Relay restarted',
    '- PWA deployed',
    '- Tests all passing',
    '- Backups created',
    '- Tailscale unchanged',
    '- VAPID untouched',
    '- Hooks unchanged',
    '- Rollback verified',
    '',
    'Nothing else on the machine was touched, and the rollback path has been verified end to end.',
  ].join('\n'));
  assert.ok(eight.bullets.length > 4, `expected more than 4, got ${eight.bullets.length}`);
  assert.equal(eight.bullets.length, 8, 'every distinct short point survives');

  const five = preview([
    'Five findings came out of the review of the notification pipeline this afternoon.',
    '',
    '- First finding about the relay delivery path',
    '- Second finding about the notifier classification',
    '- Third finding about the service worker payload',
    '- Fourth finding about the store reducer',
    '- Fifth finding about the conversation UI',
    '',
    'Each one is small on its own, but together they explain the behaviour you saw. I have not changed anything yet and I am waiting for your go-ahead.',
  ].join('\n'));
  assert.equal(five.bullets.length, 5);
});

test('the card stays bounded even when a message has very many points', () => {
  const many = [
    'Here is a long list of everything that happened during the run.',
    '',
    ...Array.from({ length: 60 }, (_, i) => `- Point number ${i} describing something that changed in the system`),
  ].join('\n');
  const p = preview(many);
  assert.ok(p.bullets.length > 4, 'still content-driven');
  const size = p.bullets.reduce((n, b) => n + b.length, 0);
  assert.ok(size <= 520, `bullets should stay within a readable budget, got ${size}`);
  assert.ok(size < many.length * 0.25, 'and far shorter than the message');
});

test('10. repeated and contained points are not shown twice', () => {
  const p = preview([
    'Deployment summary for this evening, with the duplicates it actually contained.',
    '',
    '- Relay restarted cleanly',
    '- Relay restarted cleanly',
    '- relay restarted cleanly!',
    '- Relay restarted',
    '- PWA deployed to the live directory',
    '',
    'Nothing else was touched during the window, and the backups are all in place.',
  ].join('\n'));
  const normalized = p.bullets.map((b) => b.toLowerCase().replace(/[^a-z0-9]/g, ''));
  assert.equal(new Set(normalized).size, normalized.length, 'no duplicates');
  assert.equal(p.bullets.filter((b) => /relay restarted/i.test(b)).length, 1);
  assert.ok(p.bullets.some((b) => b.includes('PWA deployed')));
});

test('a point identical to the title is not repeated as a bullet', () => {
  const p = preview([
    'Relay restarted cleanly and everything is healthy now.',
    '',
    '- Relay restarted cleanly',
    '- PWA deployed to the live directory',
    '- Tests all passing on every suite',
    '- Backups created and verified end to end',
    '',
    'Nothing else on the machine was touched, and the rollback path has been checked.',
  ].join('\n'));
  assert.equal(p.bullets.some((b) => b.toLowerCase().startsWith('relay restarted cleanly')), false);
  assert.ok(p.bullets.some((b) => b.includes('PWA deployed')));
});

/* ---------------------------------------------------- markdown and code */

test('11. Markdown markers never appear in the collapsed card', () => {
  const p = preview([
    '### Results of the **latest** run',
    '',
    "Everything below came out of tonight's verification pass on the staged build.",
    '',
    '- Fixed `hook_context.py` and **hardened** the *validator* logic',
    '- Added [the notes](https://example.test/notes) for reviewers to read',
    '- Removed ~~the old path~~ entirely from the codebase',
    '',
    'That is the full set of changes, and the staged bundle is ready for your review.',
  ].join('\n'));
  const all = joined(p);
  for (const marker of ['**', '`', '~~', '](', '###', '- ']) {
    assert.equal(all.includes(marker), false, `marker ${marker} leaked into the preview`);
  }
  assert.ok(all.includes('hook_context.py'), 'the words survive, only the syntax goes');
  assert.ok(all.includes('the notes'), 'a link shows its label');
  assert.equal(all.includes('https://example.test/notes'), false, 'not its URL');
});

test('12. a large code block never appears in the collapsed card', () => {
  const p = preview(CODE_HEAVY);
  assert.equal(p.needsExpansion, true);
  const all = joined(p);
  assert.equal(all.includes('SENTINEL_CODE_ONLY_MARKER'), false);
  assert.equal(all.includes('function classifyStop'), false);
  assert.equal(all.includes('{'), false);
  assert.equal(p.title, 'Fixed the lifecycle classification');
  assert.ok(all.includes('outstanding work'), 'the prose around the code is what is shown');
});

test('a code-only response collapses to what it is, never dumping the code', () => {
  const codeOnly = ['```js', ...Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`), '```'].join('\n');
  const p = preview(codeOnly);
  assert.equal(p.needsExpansion, true);
  assert.equal(p.title, 'Code (40 lines)');
  assert.equal(joined(p).includes('const line0'), false);
});

/* ------------------------------------------------------- user summaries */

test('a user prompt with several distinct requests becomes bullets', () => {
  const p = preview(LONG_PROMPT, 'user');
  assert.equal(p.kind, 'bullets');
  assert.ok(p.bullets.some((b) => b.includes('newest messages first')));
  assert.ok(p.bullets.some((b) => b.includes('subtask notifications')));
});

test('a single long request becomes one to three sentences, not the whole prompt', () => {
  const oneRequest = [
    'Please redesign the conversation messages so they are compact and easy to scan on the phone.',
    'Long messages currently take up far too much vertical space and I have to scroll past them.',
    'They should collapse by default and expand when I tap them.',
    'Do not change any stored data, do not deploy, and stop for my approval when the build is staged.',
    'I would also like the code blocks to keep scrolling inside their own box.',
  ].join(' ');
  const p = preview(oneRequest, 'user');
  assert.equal(p.kind, 'paragraph');
  assert.ok(p.paragraph.length <= 201);
  assert.ok(p.paragraph.length < oneRequest.length * 0.7);
});

/* -------------------------------------------- purity, safety, determinism */

test('14 + 18. the original text is never modified; the card is only a view of it', () => {
  const copy = `${STRUCTURED}`;
  const p = preview(STRUCTURED);
  assert.equal(STRUCTURED, copy, 'the input string is untouched');
  assert.ok(joined(p).length < STRUCTURED.length, 'and the card is strictly smaller');
});

test('previews are deterministic and need no network at all', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the preview generator must never make a request');
  };
  try {
    const a = preview(STRUCTURED);
    clearMessagePreviewCache();
    const b = preview(STRUCTURED);
    assert.deepEqual(a, b, 'same text, same card, every time');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('repeated previews are memoised, so scrolling does not re-parse', () => {
  const first = preview(STRUCTURED);
  assert.equal(preview(STRUCTURED), first, 'the very same object is returned');
  clearMessagePreviewCache();
  assert.notEqual(preview(STRUCTURED), first, 'and the cache can be cleared');
});

test('a heading names the card whoever wrote it; only Claude boilerplate is skipped', () => {
  const asUser = preview(STRUCTURED, 'user');
  const asClaude = preview(STRUCTURED, 'assistant');
  assert.equal(asClaude.title, 'Implemented conversation improvements');
  assert.equal(asUser.title, asClaude.title, 'a real heading is the subject either way');

  // "Summary" says nothing on its own, so the first real sentence wins. A
  // single short word is not a useful title for either role.
  const generic = ['## Summary', ...STRUCTURED.split('\n').slice(1)].join('\n');
  assert.equal(preview(generic, 'assistant').title, 'Here is what changed in this release');
  assert.equal(preview(generic, 'user').title, 'Here is what changed in this release');

  // A real heading the user typed is taken as written, never reinterpreted.
  const userHeading = ['## My release checklist for tonight', ...STRUCTURED.split('\n').slice(1)].join('\n');
  assert.equal(preview(userHeading, 'user').title, 'My release checklist for tonight');
});

test('25 + 26. a preview is plain text: no markup, no link targets, no handlers', () => {
  const hostile = [
    'Here is the result of the investigation into the reported problem, with the details below.',
    '',
    '- <script>alert(1)</script> should stay literal in the preview',
    '- <img src=x onerror="alert(1)"> is only text as well',
    '- [tap me](javascript:alert1) must not become a link',
    '- [safe](https://example.test) keeps only its label',
    '',
    'Nothing in that list is markup: every one of those is displayed as the characters written.',
  ].join('\n');
  const p = preview(hostile);
  const all = joined(p);
  for (const value of [p.title, p.paragraph, ...p.bullets]) {
    assert.ok(value === null || typeof value === 'string', 'a card carries strings, nothing else');
  }
  assert.equal(all.includes('javascript:'), false, 'an unsafe target is dropped entirely');
  assert.equal(all.includes('https://example.test'), false, 'a safe link shows its label, not its URL');
  assert.ok(all.includes('<script>alert(1)</script>'), 'raw HTML stays literal text');
  assert.ok(all.includes('onerror='), 'and is never an attribute');
});

test('malformed and hostile input never throws', () => {
  for (const value of ['', '   ', '\n\n\n', '#'.repeat(500), '`'.repeat(2000), '- '.repeat(3000), 'x'.repeat(20000), null, undefined, 42]) {
    assert.doesNotThrow(() => buildMessagePreview(value, 'assistant'), String(value).slice(0, 20));
    assert.doesNotThrow(() => buildMessagePreview(value, 'user'));
  }
  assert.equal(buildMessagePreview('', 'assistant').needsExpansion, false);
  assert.equal(buildMessagePreview(null, 'assistant').needsExpansion, false);
});

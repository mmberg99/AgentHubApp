/**
 * Markdown subset: what Claude's visible text becomes before it is rendered.
 *
 *   npm run test:store
 *
 * The renderer turns these blocks and spans into React Native <Text>/<View>.
 * There is no HTML step anywhere, so the security property this file proves is
 * structural: markup-looking input stays DATA (plain text spans), and only an
 * allow-listed URL scheme ever becomes a tappable link.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BUILD = path.join(__dirname, '.build');
const {
  parseMarkdownBlocks,
  parseInline,
  safeHref,
  truncateMarkdown,
} = require(path.join(BUILD, 'lib', 'markdown.js'));

/** Flattened plain text of a span list, ignoring styling. */
const plain = (spans) => spans.map((s) => s.text).join('');
const blocksOf = (src) => parseMarkdownBlocks(src);
const kinds = (src) => blocksOf(src).map((b) => b.kind);

/* ------------------------------------------------------------------ inline */

test('bold, italic, strikethrough and inline code become styled spans', () => {
  const spans = parseInline('plain **bold** and *italic* and ~~gone~~ and `code()` end');
  assert.equal(plain(spans), 'plain bold and italic and gone and code() end');
  assert.equal(spans.find((s) => s.text === 'bold').bold, true);
  assert.equal(spans.find((s) => s.text === 'italic').italic, true);
  assert.equal(spans.find((s) => s.text === 'gone').strike, true);
  assert.equal(spans.find((s) => s.text === 'code()').code, true);
  // The markers themselves never survive into the text.
  assert.equal(plain(spans).includes('**'), false);
  assert.equal(plain(spans).includes('`'), false);
});

test('bold wins over italic when both could match, and nesting combines styles', () => {
  const spans = parseInline('**bold with `code` inside**');
  assert.equal(plain(spans), 'bold with code inside');
  assert.ok(spans.every((s) => s.bold));
  assert.equal(spans.find((s) => s.text === 'code').code, true);
});

test('markup inside a code span is literal', () => {
  const spans = parseInline('`**not bold** [not a link](https://x.test)`');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].code, true);
  assert.equal(spans[0].text, '**not bold** [not a link](https://x.test)');
  assert.equal(spans[0].bold, undefined);
  assert.equal(spans[0].href, undefined);
});

test('underscores are left alone so snake_case and __init__ read correctly', () => {
  assert.equal(plain(parseInline('call __init__ on my_var_name now')), 'call __init__ on my_var_name now');
  assert.equal(parseInline('my_var_name').every((s) => !s.italic), true);
});

test('a lone asterisk and multiplication are not emphasis', () => {
  assert.equal(plain(parseInline('2 * 3 * 4')), '2 * 3 * 4');
  assert.equal(parseInline('2 * 3 * 4').some((s) => s.italic), false);
});

/* ------------------------------------------------------------------- links */

test('only http, https and mailto become links', () => {
  assert.equal(safeHref('https://example.test/x?a=1'), 'https://example.test/x?a=1');
  assert.equal(safeHref('http://example.test'), 'http://example.test');
  assert.equal(safeHref('mailto:someone@example.test'), 'mailto:someone@example.test');
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox',
    'file:///C:/Windows/System32',
    '//evil.test/path',
    '/relative/path',
    'example.test',
    '',
  ]) {
    assert.equal(safeHref(bad), null, bad);
  }
});

test('a link with a safe target is tappable; an unsafe one degrades to plain text', () => {
  const ok = parseInline('see [the docs](https://example.test/docs) here');
  const link = ok.find((s) => s.text === 'the docs');
  assert.equal(link.href, 'https://example.test/docs');

  // A hostile scheme the pattern DOES match: the label survives, the target
  // is dropped entirely, and nothing is tappable.
  const rejected = parseInline('see [click me](javascript:alert1) here');
  assert.equal(rejected.every((s) => s.href === undefined), true, 'no tappable target survives');
  assert.equal(plain(rejected), 'see click me here');
  assert.equal(plain(rejected).includes('javascript:'), false, 'the target is not shown either');

  // A URL with parentheses matches no link pattern at all, so the whole thing
  // stays literal text. Ugly, but inert: still not a link.
  const literal = parseInline('see [click me](javascript:alert(document.cookie)) here');
  assert.equal(literal.every((s) => s.href === undefined), true, 'still no tappable target');
  assert.equal(plain(literal), 'see [click me](javascript:alert(document.cookie)) here');
});

/* ------------------------------------------------------------------ blocks */

test('headings, paragraphs, rules and blockquotes', () => {
  const blocks = blocksOf('# Title\n\nA paragraph.\n\n---\n\n> quoted line\n> second line');
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'paragraph', 'rule', 'quote']);
  assert.equal(blocks[0].level, 1);
  assert.equal(plain(blocks[0].spans), 'Title');
  assert.equal(plain(blocks[3].spans), 'quoted line\nsecond line');
  assert.equal(blocksOf('### Deeper')[0].level, 3);
});

test('unordered and ordered lists, with their numbers preserved', () => {
  const ul = blocksOf('- one\n- two\n- three')[0];
  assert.equal(ul.kind, 'list');
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items.map((i) => plain(i.spans)), ['one', 'two', 'three']);

  const ol = blocksOf('1. first\n2. second\n3. third')[0];
  assert.equal(ol.ordered, true);
  assert.deepEqual(ol.items.map((i) => i.marker), [1, 2, 3]);
  assert.deepEqual(ol.items.map((i) => plain(i.spans)), ['first', 'second', 'third']);

  const nested = blocksOf('- top\n  - child')[0];
  assert.deepEqual(nested.items.map((i) => i.indent), [0, 1]);
});

test('list items keep their inline formatting', () => {
  const ul = blocksOf('- **bold** item with `code`')[0];
  assert.equal(ul.items[0].spans.find((s) => s.text === 'bold').bold, true);
  assert.equal(ul.items[0].spans.find((s) => s.text === 'code').code, true);
});

test('fenced code keeps its text byte for byte and is never parsed as markup', () => {
  const src = [
    'Here is code:',
    '',
    '```ts',
    'const x = { a: 1 };',
    '',
    '// **not bold**  <script>alert(1)</script>',
    'if (a < b && c > d) return `t`;',
    '```',
    '',
    'After.',
  ].join('\n');
  const blocks = blocksOf(src);
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'code', 'paragraph']);
  const code = blocks[1];
  assert.equal(code.language, 'ts');
  assert.equal(
    code.text,
    'const x = { a: 1 };\n\n// **not bold**  <script>alert(1)</script>\nif (a < b && c > d) return `t`;',
  );
  assert.equal(blocks[2].kind, 'paragraph');
  assert.equal(plain(blocks[2].spans), 'After.');
});

test('an unterminated fence still renders as code instead of swallowing the rest', () => {
  const blocks = blocksOf('```\nnever closed\nmore');
  assert.deepEqual(blocks.map((b) => b.kind), ['code']);
  assert.equal(blocks[0].text, 'never closed\nmore');
});

test('soft line breaks inside a paragraph are preserved', () => {
  const block = blocksOf('line one\nline two')[0];
  assert.equal(block.kind, 'paragraph');
  assert.equal(plain(block.spans), 'line one\nline two');
});

/* ---------------------------------------------------------------- security */

test('raw HTML is data, never markup', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://evil.test"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '<div onclick="steal()">x</div>',
  ].join('\n\n');
  const blocks = blocksOf(hostile);
  // Every one of them is a paragraph of plain text: no element, no href.
  assert.ok(blocks.every((b) => b.kind === 'paragraph'));
  const spans = blocks.flatMap((b) => b.spans);
  assert.equal(spans.every((s) => s.href === undefined), true, 'no HTML attribute becomes a link');
  // The characters survive, so the user sees exactly what Claude wrote.
  const shown = blocks.map((b) => plain(b.spans)).join('\n');
  assert.ok(shown.includes('<script>alert(1)</script>'));
  assert.ok(shown.includes('onerror='));
  // And nothing in the output is anything but text and style flags.
  const allowed = new Set(['text', 'bold', 'italic', 'strike', 'code', 'href']);
  for (const span of spans) {
    for (const key of Object.keys(span)) assert.ok(allowed.has(key), key);
  }
});

test('pathological input terminates and never throws', () => {
  for (const src of [
    '*'.repeat(5000),
    '`'.repeat(5000),
    '['.repeat(2000) + ']'.repeat(2000),
    '**'.repeat(3000),
    '> '.repeat(2000),
    '- '.repeat(2000),
    '#'.repeat(500),
    '\u0000\u0007 control chars',
    '',
  ]) {
    assert.doesNotThrow(() => parseMarkdownBlocks(src), JSON.stringify(src.slice(0, 20)));
  }
  assert.deepEqual(parseMarkdownBlocks(''), []);
  assert.deepEqual(parseMarkdownBlocks(null), []);
});

test('a realistic Claude answer produces every supported block', () => {
  const answer = [
    '## Summary',
    '',
    'Implemented the **corrected lifecycle**. See [the docs](https://example.test/d).',
    '',
    '- `Stop` with work outstanding reports *Idle*',
    '- `Stop` with nothing outstanding reports **Completed**',
    '',
    '1. Restart the relay',
    '2. Deploy the PWA',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '> All 74 tests pass.',
  ].join('\n');
  assert.deepEqual(kinds(answer), ['heading', 'paragraph', 'list', 'list', 'code', 'quote']);
  const rendered = blocksOf(answer);
  assert.equal(rendered[2].ordered, false);
  assert.equal(rendered[3].ordered, true);
  assert.equal(rendered[4].text, 'npm test');
  assert.equal(plain(rendered[5].spans), 'All 74 tests pass.');
});

/* -------------------------------------------------------------- truncation */

test('collapsing prefers a line boundary and never invents content', () => {
  const src = 'line one\nline two\nline three\nline four';
  const short = truncateMarkdown(src, 1000);
  assert.equal(short.truncated, false);
  assert.equal(short.text, src);

  const cut = truncateMarkdown(src, 20);
  assert.equal(cut.truncated, true);
  assert.ok(src.startsWith(cut.text.replace('…', '')));
  assert.ok(cut.text.length <= 21);
});

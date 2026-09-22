/**
 * A small, bounded Markdown subset for displaying Claude's visible responses.
 *
 * WHY NOT A LIBRARY. Nothing suitable is installed, and the usual React Native
 * options are unmaintained or pull a full CommonMark engine. More importantly,
 * this parser produces DATA ONLY — a list of blocks and styled spans — which
 * `components/Markdown.tsx` renders with React Native <Text> and <View>. There
 * is no HTML anywhere in the pipeline: no `dangerouslySetInnerHTML`, no DOM
 * parsing, no sanitizer to get wrong. Raw HTML in the source is never markup;
 * it stays literal text and is displayed as typed.
 *
 * WHAT IS SUPPORTED
 *   headings, paragraphs (with soft line breaks), unordered and ordered lists
 *   (one nesting level shown as indentation), fenced code blocks, blockquotes,
 *   horizontal rules, and inline bold, italic, strikethrough, code and links.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED
 *   Underscore emphasis (`_x_`, `__x__`). Developer text is full of
 *   `snake_case` and `__init__`, and treating those as emphasis is a visible
 *   bug that is worse than showing the underscore. Asterisk emphasis, which is
 *   what Claude emits, is supported. Also out: tables, reference links,
 *   footnotes, and HTML — all render as plain text rather than disappearing.
 *
 * LINKS. Only http, https and mailto survive as links (`safeHref`). Anything
 * else — `javascript:`, `data:`, `vbscript:`, an unknown scheme — renders as
 * plain label text with no target, so a malicious URL cannot be tapped.
 *
 * The source string is never modified; this is a presentation layer only.
 */

export interface MarkdownSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Present only for a link with a scheme on the allow-list. */
  href?: string;
}

export interface MarkdownListItem {
  spans: MarkdownSpan[];
  /** Nesting depth, 0 for a top-level item. Capped at MAX_LIST_INDENT. */
  indent: number;
  /** Number shown for an ordered item. */
  marker?: number;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: MarkdownSpan[] }
  | { kind: 'paragraph'; spans: MarkdownSpan[] }
  | { kind: 'code'; text: string; language: string | null }
  | { kind: 'quote'; spans: MarkdownSpan[] }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'rule' };

const MAX_LIST_INDENT = 3;
const MAX_INLINE_DEPTH = 5;
const MAX_INLINE_TOKENS = 400;
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * A URL that is safe to hand to `Linking.openURL`, or null.
 *
 * Scheme-relative (`//host`) and relative URLs resolve against nothing useful
 * in this app, so only absolute URLs with an allow-listed scheme pass.
 */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s<>"]/.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (!scheme) return null;
  return SAFE_SCHEMES.includes(`${scheme[1].toLowerCase()}:`) ? value : null;
}

/* ---------------------------------------------------------------- inline */

interface InlineRule {
  re: RegExp;
  build: (match: RegExpExecArray, depth: number) => MarkdownSpan[];
}

function nest(text: string, depth: number, patch: Partial<MarkdownSpan>): MarkdownSpan[] {
  return parseInline(text, depth + 1).map((span) => ({ ...span, ...patch }));
}

/**
 * Order is a tie-breaker only: the earliest match in the string wins, so
 * `**bold**` beats the italic rule that could also start one character later.
 */
const INLINE_RULES: InlineRule[] = [
  // Code first in spirit: inside a code span nothing else is markup, which the
  // build function guarantees by not recursing.
  { re: /`([^`\n]+)`/, build: (m) => [{ text: m[1], code: true }] },
  {
    re: /\[([^\]\n]*)\]\(([^()\s]*)\)/,
    build: (m, depth) => {
      const href = safeHref(m[2]);
      const label = m[1].length > 0 ? m[1] : m[2];
      // An unsafe or malformed target degrades to plain, untappable text.
      return href ? nest(label, depth, { href }) : nest(label, depth, {});
    },
  },
  { re: /\*\*([^\n]+?)\*\*/, build: (m, depth) => nest(m[1], depth, { bold: true }) },
  { re: /~~([^\n]+?)~~/, build: (m, depth) => nest(m[1], depth, { strike: true }) },
  { re: /\*([^\s*][^*\n]*?)\*/, build: (m, depth) => nest(m[1], depth, { italic: true }) },
];

/** Splits one line of text into styled spans. Never throws. */
export function parseInline(source: string, depth = 0): MarkdownSpan[] {
  if (source.length === 0) return [];
  if (depth > MAX_INLINE_DEPTH) return [{ text: source }];

  const out: MarkdownSpan[] = [];
  let rest = source;
  let guard = 0;

  while (rest.length > 0) {
    if (guard >= MAX_INLINE_TOKENS) {
      out.push({ text: rest });
      break;
    }
    guard += 1;

    let best: { rule: InlineRule; match: RegExpExecArray } | null = null;
    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(rest);
      if (match && (best === null || match.index < best.match.index)) {
        best = { rule, match };
      }
    }

    if (!best) {
      out.push({ text: rest });
      break;
    }
    if (best.match.index > 0) out.push({ text: rest.slice(0, best.match.index) });
    out.push(...best.rule.build(best.match, depth));
    rest = rest.slice(best.match.index + best.match[0].length);
  }

  return out.filter((span) => span.text.length > 0);
}

/* ---------------------------------------------------------------- blocks */

const FENCE = /^\s{0,3}(```+|~~~+)\s*([A-Za-z0-9_+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

function isBlockStart(line: string): boolean {
  return (
    line.trim().length === 0 ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

const indentOf = (raw: string): number => Math.min(Math.floor(raw.length / 2), MAX_LIST_INDENT);

/**
 * Splits a document into blocks. Anything unrecognised becomes a paragraph, so
 * no input is ever dropped: the worst case is that text is shown as typed.
 */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Fenced code: content is preserved byte for byte, never parsed.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closing = FENCE.exec(lines[i]);
        if (closing && closing[1][0] === marker) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({
        kind: 'code',
        text: body.join('\n').replace(/\n+$/, ''),
        language: fence[2] ? fence[2] : null,
      });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        spans: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const quote = QUOTE.exec(lines[i]);
        if (!quote) break;
        body.push(quote[1]);
        i += 1;
      }
      blocks.push({ kind: 'quote', spans: parseInline(body.join('\n').trim()) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line) && ORDERED.test(line);
      const items: MarkdownListItem[] = [];
      while (i < lines.length) {
        const bullet = ordered ? null : BULLET.exec(lines[i]);
        const numbered = ordered ? ORDERED.exec(lines[i]) : null;
        const match = bullet ?? numbered;
        if (!match) break;
        const textParts = [match[3]];
        i += 1;
        // Continuation lines: indented text that starts no other block.
        while (i < lines.length && lines[i].trim().length > 0 && !isBlockStart(lines[i])) {
          textParts.push(lines[i].trim());
          i += 1;
        }
        items.push({
          spans: parseInline(textParts.join(' ')),
          indent: indentOf(match[1]),
          ...(numbered ? { marker: Number(numbered[2]) } : {}),
        });
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // A line that looks like a block start but matched nothing above.
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n').trim()) });
  }

  return blocks;
}

/**
 * Shortens Markdown source for a collapsed view, preferring a line boundary so
 * a fence or list is not cut mid-token. Returns the original when it fits.
 */
export function truncateMarkdown(source: string, limit: number): { text: string; truncated: boolean } {
  if (source.length <= limit) return { text: source, truncated: false };
  const cut = source.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  const text = lastBreak > limit * 0.5 ? cut.slice(0, lastBreak) : cut;
  return { text: `${text.trimEnd()}…`, truncated: true };
}

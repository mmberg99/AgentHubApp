/**
 * Collapsed previews for conversation messages.
 *
 * LOCAL AND DETERMINISTIC. No model, no network, no stored summary. A preview
 * is derived from the message text alone, by reusing the Markdown parser in
 * `./markdown.ts`, so the same text always yields the same card and the
 * conversation never leaves the device to be summarised.
 *
 * PRESENTATION ONLY. Nothing here rewrites, stores or replaces a message. The
 * complete original text is always what the expanded card renders, and what
 * the relay keeps on Windows is untouched.
 *
 * WHAT IT PRODUCES
 *   title      a short phrase naming what the message is about
 *   bullets    the message's own list items or section headings, shortened
 *   paragraph  used instead of bullets when the message is one idea
 *
 * Code blocks are never quoted in a preview: their surrounding prose is used
 * instead, and the code itself appears only when the card is expanded.
 *
 * BULLET COUNT is chosen by the content, not by a fixed number. Every useful
 * item is a candidate; the list is bounded by a character budget rather than a
 * count, so two useful points give two bullets and eight short ones give
 * eight, while a card can still never grow into a wall of text.
 */

import { parseMarkdownBlocks, type MarkdownBlock, type MarkdownSpan } from './markdown';

export type MessageRole = 'user' | 'assistant';

export interface MessagePreview {
  /** Short phrase for the card header. Null when nothing useful could be derived. */
  title: string | null;
  /** Which body the card shows. */
  kind: 'paragraph' | 'bullets';
  /** Set when `kind` is 'paragraph'. */
  paragraph: string | null;
  /** Set when `kind` is 'bullets'; ordered as they appear in the message. */
  bullets: string[];
  /**
   * True when the message is long enough that collapsing genuinely helps. When
   * false the UI shows the whole message and offers no expand action.
   */
  needsExpansion: boolean;
}

/* --------------------------------------------------------------- tuning */

/** Below this, a message is shown in full: collapsing would save nothing. */
const COLLAPSE_MIN_CHARS = 320;
const COLLAPSE_MIN_LINES = 6;
/** A fenced block longer than this is reason enough to collapse. */
const COLLAPSE_CODE_LINES = 2;
const TITLE_MAX = 64;
const PARAGRAPH_MAX = 200;
const BULLET_MAX = 96;
/** Total characters across bullets. The COUNT is free; the size is bounded. */
const BULLET_BUDGET = 420;
/** Always show at least this many bullets, even if each is long. */
const BULLET_FLOOR = 2;
/** A preview this close to the original is not worth collapsing. */
const PREVIEW_RATIO = 0.75;

/** Headings too generic to name a card; the first real sentence beats them. */
const GENERIC_HEADINGS = new Set([
  'summary', 'overview', 'result', 'results', 'note', 'notes', 'update',
  'done', 'tldr', 'tl;dr', 'conclusion', 'output', 'response', 'answer',
  'introduction', 'background', 'details', 'context',
]);

/* --------------------------------------------------------------- helpers */

const flatten = (spans: MarkdownSpan[]): string =>
  spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Cuts at a word boundary and marks the cut. Never splits mid-word. */
function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const base = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** The first sentence, or the whole string when it has no terminator. */
function firstSentence(value: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(value);
  return match ? match[1] : value;
}

/** The first one to three sentences, within a character budget. */
function leadingSentences(value: string, max: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < 3 && rest.length > 0; i += 1) {
    const sentence = firstSentence(rest);
    if (out.length > 0 && out.length + sentence.length + 1 > max) break;
    out = out.length > 0 ? `${out} ${sentence}` : sentence;
    rest = rest.slice(sentence.length).trim();
    if (out.length >= max) break;
  }
  return shorten(out.length > 0 ? out : value, max);
}

function cleanTitle(value: string): string {
  const stripped = value
    .replace(/^[#>\s]*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d{1,3}[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:;,.\-–—]+$/, '')
    .trim();
  const short = shorten(stripped, TITLE_MAX);
  return short.length > 0 ? short[0].toUpperCase() + short.slice(1) : '';
}

/** Rejects punctuation-only, bare URLs, code-looking and one-word fragments. */
function isUsefulTitle(value: string): boolean {
  if (value.length < 4) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (/^https?:\/\/\S*$/i.test(value)) return false;
  if (/^[{}[\]();=<>|/\\]/.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  return words.length >= 2 || value.length >= 12;
}

/* ----------------------------------------------------------------- title */

function deriveTitle(blocks: MarkdownBlock[], role: MessageRole): string | null {
  // A heading at the very top usually IS the subject, whoever wrote it.
  for (const block of blocks.slice(0, 2)) {
    if (block.kind !== 'heading') continue;
    const candidate = cleanTitle(flatten(block.spans));
    if (!isUsefulTitle(candidate)) continue;
    // Claude routinely opens with a boilerplate heading and the first real
    // sentence says more. A heading the USER typed is their own chosen
    // subject, so it is taken as written rather than second-guessed.
    if (role === 'assistant' && GENERIC_HEADINGS.has(candidate.toLowerCase())) continue;
    return candidate;
  }
  // Otherwise the first real sentence of the message.
  for (const block of blocks) {
    if (block.kind === 'paragraph' || block.kind === 'quote') {
      const candidate = cleanTitle(firstSentence(flatten(block.spans)));
      if (isUsefulTitle(candidate)) return candidate;
    }
    if (block.kind === 'list' && block.items.length > 0) {
      const candidate = cleanTitle(firstSentence(flatten(block.items[0].spans)));
      if (isUsefulTitle(candidate)) return candidate;
    }
    if (block.kind === 'heading') {
      const candidate = cleanTitle(flatten(block.spans));
      if (isUsefulTitle(candidate)) return candidate;
    }
  }
  return null;
}

/* --------------------------------------------------------------- bullets */

/** Candidate points, in the order the message makes them. */
function collectBullets(blocks: MarkdownBlock[]): string[] {
  const items: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'list') continue;
    for (const item of block.items) items.push(flatten(item.spans));
  }
  if (items.length >= 2) return items;

  // No list: a message organised into sections is still structured, so use
  // each heading with the first sentence beneath it.
  const sections: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind !== 'heading') continue;
    const heading = flatten(block.spans);
    const next = blocks[i + 1];
    const detail =
      next && (next.kind === 'paragraph' || next.kind === 'quote')
        ? firstSentence(flatten(next.spans))
        : '';
    sections.push(detail ? `${heading}: ${detail}` : heading);
  }
  return sections.length >= 2 ? sections : [];
}

/**
 * Drops empties, near-duplicates and anything already said, shortens each
 * point, then keeps as many as the character budget allows. The number of
 * bullets therefore follows the content.
 */
function refineBullets(candidates: string[], title: string | null): string[] {
  const seen = new Set<string>();
  if (title) seen.add(normalize(title));

  const cleaned: string[] = [];
  for (const raw of candidates) {
    const text = shorten(raw.replace(/\s+/g, ' ').trim(), BULLET_MAX);
    const key = normalize(text);
    if (key.length < 3) continue;
    if (seen.has(key)) continue;
    // A point already contained in one we kept adds nothing.
    if ([...seen].some((prev) => prev.length > 0 && (prev.includes(key) || key.includes(prev)))) {
      continue;
    }
    seen.add(key);
    cleaned.push(text);
  }

  const kept: string[] = [];
  let used = 0;
  for (const bullet of cleaned) {
    if (kept.length >= BULLET_FLOOR && used + bullet.length > BULLET_BUDGET) break;
    kept.push(bullet);
    used += bullet.length;
  }
  return kept;
}

/* ------------------------------------------------------------- paragraph */

function deriveParagraph(blocks: MarkdownBlock[], title: string | null): string | null {
  for (const block of blocks) {
    if (block.kind !== 'paragraph' && block.kind !== 'quote') continue;
    const text = flatten(block.spans);
    if (text.length === 0) continue;

    // When the title came from this paragraph's first sentence, summarise what
    // follows instead of repeating it.
    if (title && normalize(text).startsWith(normalize(title))) {
      const rest = text.slice(firstSentence(text).length).trim();
      if (rest.length >= 24) return leadingSentences(rest, PARAGRAPH_MAX);
      continue;
    }
    return leadingSentences(text, PARAGRAPH_MAX);
  }
  return null;
}

/* ----------------------------------------------------------------- build */

const CACHE_LIMIT = 200;
const cache = new Map<string, MessagePreview>();

function compute(text: string, role: MessageRole): MessagePreview {
  const empty: MessagePreview = {
    title: null,
    kind: 'paragraph',
    paragraph: null,
    bullets: [],
    needsExpansion: false,
  };
  if (typeof text !== 'string' || text.trim().length === 0) return empty;

  const blocks = parseMarkdownBlocks(text);
  const lines = text.split('\n').length;
  const longCode = blocks.some(
    (b) => b.kind === 'code' && b.text.split('\n').length > COLLAPSE_CODE_LINES,
  );
  const worthCollapsing =
    text.length > COLLAPSE_MIN_CHARS || lines > COLLAPSE_MIN_LINES || longCode;

  if (!worthCollapsing) return empty;

  const title = deriveTitle(blocks, role);
  const bullets = refineBullets(collectBullets(blocks), title);
  const paragraph = bullets.length >= 2 ? null : deriveParagraph(blocks, title);
  const kind: MessagePreview['kind'] = bullets.length >= 2 ? 'bullets' : 'paragraph';

  if (!title && bullets.length === 0 && !paragraph) {
    // A message that is nothing but code: there is no prose to summarise, but
    // dumping forty lines into the feed is exactly what we are avoiding. Name
    // it by what it is and let the card be expanded.
    if (!longCode) return empty;
    const codeLines = blocks.reduce(
      (n, b) => (b.kind === 'code' ? n + b.text.split('\n').length : n),
      0,
    );
    return {
      title: `Code (${codeLines} ${codeLines === 1 ? 'line' : 'lines'})`,
      kind: 'paragraph',
      paragraph: null,
      bullets: [],
      needsExpansion: true,
    };
  }

  const previewLength =
    (title?.length ?? 0) + (paragraph?.length ?? 0) + bullets.reduce((n, b) => n + b.length, 0);
  // A "summary" nearly as long as the message is not a summary.
  if (!longCode && previewLength >= text.length * PREVIEW_RATIO) return empty;

  return { title, kind, paragraph, bullets, needsExpansion: true };
}

/**
 * Preview for one message. Memoised per (role, text): a message's card is
 * computed once however often the list re-renders while scrolling.
 */
export function buildMessagePreview(text: string, role: MessageRole): MessagePreview {
  const key = `${role}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const preview = compute(text, role);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, preview);
  return preview;
}

/** Test seam: forget memoised previews. */
export function clearMessagePreviewCache(): void {
  cache.clear();
}

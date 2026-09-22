/**
 * What a summary provider must return, and how a failure is described.
 *
 * Both providers — the local Claude CLI and the Anthropic API — produce the
 * same card and are validated by the same function here, so the relay's
 * guarantees about a summary do not depend on where it came from.
 */

export class SummaryError extends Error {
  constructor(reason, retryable) {
    super(reason);
    this.reason = reason;
    this.retryable = retryable;
  }
}

/**
 * Rebuilds a card from a provider's parsed JSON, or throws.
 *
 * A schema guarantees the shape of an object, not that it says anything: a
 * reply can satisfy `{title, style, paragraph, bullets}` and still be a
 * bullets card with no bullets. Everything a card must actually contain is
 * checked here, and anything else the provider sent is dropped.
 */
export function validateCard(parsed) {
  if (typeof parsed !== 'object' || parsed === null) throw new SummaryError('invalid json', false);

  const style = parsed.style === 'bullets' || parsed.style === 'paragraph' ? parsed.style : null;
  if (!style) throw new SummaryError('invalid style', false);

  const title = typeof parsed.title === 'string' ? parsed.title : '';
  if (title.trim().length === 0) throw new SummaryError('empty title', false);

  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.filter((b) => typeof b === 'string' && b.trim().length > 0)
    : [];
  const paragraph = typeof parsed.paragraph === 'string' ? parsed.paragraph : '';

  if (style === 'bullets' && bullets.length === 0) throw new SummaryError('no bullets', false);
  if (style === 'paragraph' && paragraph.trim().length === 0) throw new SummaryError('no paragraph', false);

  return { title, style, paragraph, bullets };
}

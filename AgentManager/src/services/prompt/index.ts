import { notConfiguredPromptSender } from './notConfiguredPromptSender';
import type { PromptSender } from './types';

export * from './notConfiguredPromptSender';
export * from './types';

let active: PromptSender = notConfiguredPromptSender;

export function getPromptSender(): PromptSender {
  return active;
}

/**
 * Registration point for a future reviewed transport. Nothing calls this today.
 * A real implementation must be authenticated, scoped to one task, and unable
 * to execute anything the reviewed design did not allow.
 */
export function setPromptSender(sender: PromptSender): void {
  active = sender;
}

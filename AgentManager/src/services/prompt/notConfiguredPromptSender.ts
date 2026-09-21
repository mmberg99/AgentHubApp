import type { PromptSender, PromptSendRequest, PromptSendResult } from './types';

/**
 * The only sender that exists today. It performs no network activity of any
 * kind — it simply reports that sending is not configured, so the UI can say
 * so honestly rather than pretend.
 */
export const notConfiguredPromptSender: PromptSender = {
  id: 'not-configured',
  configured: false,
  description:
    'Sending is not configured yet. Your draft is saved on this device; the phone → agent path is being designed separately.',

  async send(_request: PromptSendRequest): Promise<PromptSendResult> {
    return {
      ok: false,
      reason: 'not-configured',
      message: 'Sending prompts to an agent is not configured yet. Your draft has been kept.',
    };
  },
};

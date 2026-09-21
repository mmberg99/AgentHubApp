/**
 * Prompt sending — the seam, not the mechanism.
 *
 * AgentHub is deliberately ONE-WAY today: events flow Windows -> phone and
 * nothing flows back. The follow-up prompt editor exists so a draft can be
 * written and kept on the phone; actually delivering it to an agent would be a
 * new remote-command path with its own threat model (authentication, replay,
 * which process receives it, what it may do), and that is designed and
 * reviewed separately before any transport is wired in here.
 *
 * Until then there is exactly one implementation, and it says so plainly.
 */

export interface PromptSendRequest {
  taskId: string;
  projectId: string;
  agentId: string;
  prompt: string;
}

export type PromptSendResult =
  | { ok: true; message: string }
  | { ok: false; reason: 'not-configured' | 'rejected' | 'network'; message: string };

export interface PromptSender {
  readonly id: string;
  /** False until a reviewed transport exists. Drives the button's copy. */
  readonly configured: boolean;
  /** One line shown under the Send button describing the current state. */
  readonly description: string;
  send(request: PromptSendRequest): Promise<PromptSendResult>;
}

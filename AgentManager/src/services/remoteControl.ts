import { Linking } from 'react-native';

/**
 * "Continue in Claude": hand the user over to Claude Remote Control.
 *
 * AgentHub does not deliver prompts to Claude. When the user wants to
 * continue a task from the phone, AgentHub opens the officially documented
 * Remote Control destination and the user picks the session there.
 *
 * DESTINATION. `https://claude.ai/code` is the documented session list for
 * Remote Control ("Open claude.ai/code or the Claude app and find the session
 * by name in the session list"). Anthropic documents no `claude://` scheme
 * and no app deep link other than the QR code shown in the terminal, so this
 * is a plain HTTPS URL: iOS opens it in Safari, or in the Claude app if Apple
 * Universal Links are configured for that host — behaviour AgentHub neither
 * assumes nor depends on. If the app is not installed, the web session list
 * works in the browser.
 *
 * PRIVACY. A session-specific URL (`claude.ai/code/<id>`) would require the
 * raw Claude session id on the phone, which AgentHub never transmits. So the
 * link is deliberately NOT session-specific: the user identifies the session
 * by its name in Claude's list, which for VS Code sessions is derived from the
 * first prompt, the same text AgentHub uses for the task title.
 *
 * NOTHING IS SENT. No prompt text, task, project or identifier travels with
 * this action; it is the bare URL and nothing else.
 */
export const CLAUDE_CODE_URL = 'https://claude.ai/code';

export function openClaudeCode(): Promise<void> {
  return Linking.openURL(CLAUDE_CODE_URL).then(
    () => undefined,
    () => undefined,
  );
}

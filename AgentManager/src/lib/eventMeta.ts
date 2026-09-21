import type { Ionicons } from '@expo/vector-icons';

import type { Theme } from '../theme';
import type { AgentEventType } from '../types';

type IconName = keyof typeof Ionicons.glyphMap;

/** Icon + colour for an event, resolved against the active theme. */
export function eventMeta(
  type: AgentEventType,
  theme: Theme,
): { icon: IconName; color: string } {
  switch (type) {
    case 'approval_request':
      return { icon: 'shield-checkmark-outline', color: theme.status.needs_approval.fg };
    case 'input_request':
      return { icon: 'help-circle-outline', color: theme.status.needs_input.fg };
    case 'failed':
      return { icon: 'alert-circle-outline', color: theme.status.failed.fg };
    case 'completed':
      return { icon: 'checkmark-circle-outline', color: theme.status.completed.fg };
    case 'started':
      return { icon: 'play-circle-outline', color: theme.status.running.fg };
    case 'idle':
      return { icon: 'hourglass-outline', color: theme.status.idle.fg };
    case 'approved':
      return { icon: 'checkmark-done-outline', color: theme.colors.positive };
    case 'rejected':
      return { icon: 'close-circle-outline', color: theme.colors.textSecondary };
    case 'progress':
      return { icon: 'ellipsis-horizontal-circle-outline', color: theme.colors.textSecondary };
    case 'message':
    default:
      return { icon: 'chatbubble-outline', color: theme.colors.textSecondary };
  }
}

/** Short label used in the activity inbox, e.g. "needs approval". */
export function eventHeadline(type: AgentEventType): string {
  switch (type) {
    case 'approval_request':
      return 'needs approval';
    case 'input_request':
      return 'needs input';
    case 'failed':
      return 'encountered an error';
    case 'completed':
      return 'finished its task';
    case 'started':
      return 'started a task';
    case 'idle':
      return 'is waiting on background work';
    case 'approved':
      return 'was approved';
    case 'rejected':
      return 'was rejected';
    case 'progress':
      return 'made progress';
    case 'message':
    default:
      return 'sent a message';
  }
}

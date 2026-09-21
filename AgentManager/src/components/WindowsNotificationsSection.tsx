import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { relativeTime } from '../lib/time';
import {
  buildSimulatedConversation,
  buildSimulatedEvent,
  currentSimulatedTaskId,
  useNotificationService,
  useNotificationStatus,
  type SimulatedEventKey,
} from '../services/notifications';
import { lastRemoteEvent, useAgentStore } from '../store';
import { useTheme } from '../theme';
import { Card } from './Card';
import { SectionHeader } from './SectionHeader';
import { ActionRow, InfoRow, ToggleRow } from './SettingsRow';

const TRANSPORT_LABELS: Record<string, string> = {
  none: 'None',
  simulated: 'Simulated only',
  'local-bridge': 'Local bridge',
  'expo-push': 'Expo push',
};

/**
 * Settings section for events arriving from the Windows PC.
 *
 * Every value here reflects real local state. Nothing claims to be connected
 * or registered unless it is, simulated activity is reported separately from
 * real traffic, and the bearer token and LAN address are never displayed.
 */
export function WindowsNotificationsSection() {
  const theme = useTheme();
  const service = useNotificationService();
  const status = useNotificationStatus();
  const { events, historyIsDurable, conversations, setConversation } = useAgentStore();

  // Real transport events only — simulated ones are excluded by the selector.
  const latestReal = lastRemoteEvent(events);

  const deliver = (key: SimulatedEventKey) => {
    service.deliverSimulated(buildSimulatedEvent(key));
  };

  /** Local-only sample conversation for the current simulated task. */
  const simulateConversation = () => {
    let taskId = currentSimulatedTaskId();
    if (!taskId) {
      deliver('running');
      taskId = currentSimulatedTaskId();
    }
    if (!taskId) return;
    setConversation(buildSimulatedConversation(conversations[taskId], taskId));
  };

  const connection = (() => {
    switch (status.connectionState) {
      case 'connected':
        return { value: 'Connected', tone: theme.status.completed.fg, tag: undefined as string | undefined };
      case 'unavailable':
        return { value: 'Unavailable', tone: theme.colors.attention, tag: undefined as string | undefined };
      case 'simulated':
      default:
        return { value: 'Not configured', tone: theme.colors.textTertiary, tag: 'SIMULATED' as string | undefined };
    }
  })();

  return (
    <>
      <View style={styles.section}>
        <SectionHeader title="Windows Local Bridge" />
        <Text
          style={[
            theme.typography.caption,
            { color: theme.colors.textTertiary, marginBottom: 10, lineHeight: 18 },
          ]}
        >
          Private network development only. Your Windows PC posts events to a
          bridge on this Mac and AgentHub reads them — one-way. AgentHub cannot
          send commands back, and no inbound port is opened on your PC.
        </Text>

        <Card padded={false}>
          <InfoRow
            icon="git-network-outline"
            label="Transport"
            value={TRANSPORT_LABELS[status.transport] ?? status.transport}
            // Loopback address only. The Mac's LAN address is never shown here.
            description={status.endpoint ?? undefined}
          />
          <InfoRow
            icon={status.connectionState === 'connected' ? 'checkmark-circle-outline' : 'cloud-offline-outline'}
            label="Connection"
            value={connection.value}
            valueTone={connection.tone}
            tag={connection.tag}
            description={
              status.connectionState === 'unavailable' && status.lastError
                ? status.lastError
                : undefined
            }
          />
          <InfoRow
            icon="wifi-outline"
            label="Last bridge contact"
            value={status.lastContactAt ? `${relativeTime(status.lastContactAt)} ago` : 'Never'}
          />
          <InfoRow
            icon="desktop-outline"
            label="Last real Windows event"
            value={
              latestReal
                ? `${relativeTime(latestReal.timestamp)} ago`
                : status.lastRealEventAt
                  ? `${relativeTime(status.lastRealEventAt)} ago`
                  : 'None yet'
            }
            description={latestReal?.message ?? status.lastRealEventTitle ?? undefined}
          />
          <InfoRow
            icon="albums-outline"
            label="Real events this session"
            value={String(status.realEventCount)}
            description="Simulated events are not counted"
          />
          <ToggleRow
            icon="notifications-outline"
            label="Notifications enabled"
            description={status.enabled ? 'Accepting events' : 'Incoming events ignored'}
            value={status.enabled}
            onValueChange={(next) => {
              void service.setEnabled(next);
            }}
          />
          <InfoRow
            icon="shield-outline"
            label="Rejected payloads"
            description="Failed protocol validation"
            value={String(status.rejectedCount)}
            valueTone={status.rejectedCount > 0 ? theme.colors.attention : theme.colors.textTertiary}
          />
          <ActionRow
            icon="refresh-outline"
            label="Check bridge now"
            description="Polls the local bridge immediately"
            onPress={() => {
              void service.checkNow();
            }}
            isLast
          />
        </Card>

        <Card style={styles.notice}>
          <View style={styles.noticeRow}>
            <Ionicons name="information-circle-outline" size={16} color={theme.colors.textTertiary} />
            <Text
              style={[
                theme.typography.caption,
                { color: theme.colors.textSecondary, flex: 1, lineHeight: 18 },
              ]}
            >
              {historyIsDurable
                ? 'Agent history is saved on this device.'
                : 'Agent history is session-only: reloading AgentHub clears it. The bridge queue is also in memory, so events are not replayed after a reload, and nothing is received while the bridge or Mac is off.'}
            </Text>
          </View>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Simulate Windows event" />
        <Text
          style={[
            theme.typography.caption,
            { color: theme.colors.textTertiary, marginBottom: 10, lineHeight: 18 },
          ]}
        >
          Injects an event through the exact pipeline a real notification uses:
          transport, protocol validation, then app state. These are tagged
          SIMULATED everywhere and never counted as real Windows events.
        </Text>

        <Card padded={false}>
          <ActionRow
            icon="folder-open-outline"
            label="Session opened"
            description="New Claude session, no prompt yet — Idle"
            tint={theme.status.idle.fg}
            onPress={() => deliver('session_open')}
          />
          <ActionRow
            icon="ellipsis-horizontal-circle-outline"
            label="Prompt submitted"
            description="The agent starts working — Running"
            tint={theme.status.running.fg}
            onPress={() => deliver('running')}
          />
          <ActionRow
            icon="hourglass-outline"
            label="Stopped, background work"
            description="Tests or subagents still running — Idle"
            tint={theme.status.idle.fg}
            onPress={() => deliver('idle')}
          />
          <ActionRow
            icon="checkmark-circle-outline"
            label="Task completed"
            tint={theme.status.completed.fg}
            onPress={() => deliver('completed')}
          />
          <ActionRow
            icon="shield-checkmark-outline"
            label="Needs approval"
            description="Respond on your Windows PC"
            tint={theme.status.needs_approval.fg}
            onPress={() => deliver('needs_approval')}
          />
          <ActionRow
            icon="help-circle-outline"
            label="Needs input"
            description="Respond on your Windows PC"
            tint={theme.status.needs_input.fg}
            onPress={() => deliver('needs_input')}
          />
          <ActionRow
            icon="alert-circle-outline"
            label="Failed"
            tint={theme.status.failed.fg}
            onPress={() => deliver('failed')}
          />
          <ActionRow
            icon="git-branch-outline"
            label="Subagent started"
            description="Child of the current task — never a task of its own"
            tint={theme.status.running.fg}
            onPress={() => deliver('subagent_start')}
          />
          <ActionRow
            icon="git-branch-outline"
            label="Subagent needs approval"
            description="Marks the parent task Needs action"
            tint={theme.status.needs_approval.fg}
            onPress={() => deliver('subagent_needs_approval')}
          />
          <ActionRow
            icon="git-branch-outline"
            label="Subagent finished"
            description="The parent task stays as it is"
            tint={theme.status.completed.fg}
            onPress={() => deliver('subagent_stop')}
          />
          <ActionRow
            icon="chatbubbles-outline"
            label="Prompt + response"
            description="Adds a sample conversation turn to the current task (local only)"
            tint={theme.colors.accent}
            onPress={simulateConversation}
            isLast
          />
        </Card>

        <Card style={styles.notice}>
          <View style={styles.noticeRow}>
            <Ionicons name="lock-closed-outline" size={16} color={theme.colors.textTertiary} />
            <Text
              style={[
                theme.typography.caption,
                { color: theme.colors.textSecondary, flex: 1, lineHeight: 18 },
              ]}
            >
              Event payloads carry status only. Titles and messages are treated as
              lock-screen visible: absolute file paths and key-like tokens are
              redacted on arrival, and no provider secrets are stored on this device.
            </Text>
          </View>
        </Card>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
  },
  notice: {
    marginTop: 10,
  },
  noticeRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
});

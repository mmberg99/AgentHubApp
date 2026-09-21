import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  ApprovalCard,
  Avatar,
  Button,
  Card,
  EmptyState,
  Screen,
  SectionHeader,
  StatusPill,
} from '../../src/components';
import { eventMeta } from '../../src/lib/eventMeta';
import { clockTime, elapsed, relativeTime } from '../../src/lib/time';
import {
  eventsForAgent,
  findAgent,
  pendingApprovalsForAgent,
  useAgentStore,
} from '../../src/store';
import { providerLabels, useTheme } from '../../src/theme';
import type { AgentEvent } from '../../src/types';

export default function AgentDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agentId = typeof id === 'string' ? id : '';

  const {
    agents,
    events,
    approvals,
    approve,
    reject,
    answerInput,
    sendMessage,
    markAgentRead,
    retryAgent,
  } = useAgentStore();

  const agent = findAgent(agents, agentId);
  const [draft, setDraft] = useState('');

  // Opening the agent clears its unread badge.
  useEffect(() => {
    if (agentId) markAgentRead(agentId);
    // markAgentRead is stable for the lifetime of the store provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const timeline = useMemo(() => eventsForAgent(events, agentId), [events, agentId]);
  const pending = useMemo(
    () => pendingApprovalsForAgent(approvals, agentId),
    [approvals, agentId],
  );
  const messages = useMemo(
    () => timeline.filter((e) => e.type === 'message').slice(0, 4),
    [timeline],
  );
  const inputRequest = useMemo(
    () => timeline.find((e) => e.type === 'input_request' && e.requiresAction),
    [timeline],
  );

  if (!agent) {
    return (
      <Screen title="Not found">
        <Card>
          <EmptyState
            icon="help-circle-outline"
            title="That agent no longer exists"
            description="It may have been removed from the workspace."
          />
          <Button label="Back to agents" onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }

  // No phone -> Windows command path exists, so remote agents are read-only.
  const isRemoteAgent = agent.origin === 'remote';

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    if (inputRequest) {
      answerInput(agent.id, text);
    } else {
      sendMessage(agent.id, text);
    }
    setDraft('');
  };

  return (
    <>
      <Stack.Screen options={{ title: agent.name }} />
      <Screen>
        <Card style={styles.headerCard}>
          <View style={styles.headerRow}>
            <Avatar initials={agent.avatar} status={agent.status} size={52} />
            <View style={styles.headerText}>
              <Text style={[theme.typography.title, { color: theme.colors.text }]}>
                {agent.name}
              </Text>
              <Text
                style={[theme.typography.caption, { color: theme.colors.textTertiary }]}
              >
                {providerLabels[agent.provider]} · {agent.account}
              </Text>
            </View>
          </View>

          <View style={styles.statusRow}>
            <StatusPill status={agent.status} />
            <Text style={[theme.typography.caption, { color: theme.colors.textTertiary }]}>
              Updated {relativeTime(agent.lastUpdated)} ago
            </Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.separator }]} />

          <Text style={[theme.typography.micro, { color: theme.colors.textTertiary }]}>
            CURRENT TASK
          </Text>
          <Text
            style={[
              theme.typography.body,
              { color: agent.currentTask ? theme.colors.text : theme.colors.textTertiary, marginTop: 4 },
            ]}
          >
            {agent.currentTask ?? 'No active task'}
          </Text>

          {agent.startedAt ? (
            <View style={styles.metaRow}>
              <Ionicons name="time-outline" size={14} color={theme.colors.textTertiary} />
              <Text
                style={[theme.typography.caption, { color: theme.colors.textTertiary }]}
              >
                Started {clockTime(agent.startedAt)} · running {elapsed(agent.startedAt)}
              </Text>
            </View>
          ) : null}

          {agent.status === 'failed' && !isRemoteAgent ? (
            <Button
              label="Retry task"
              icon="refresh"
              variant="secondary"
              style={{ marginTop: 16 }}
              onPress={() => retryAgent(agent.id)}
            />
          ) : null}
        </Card>

        {pending.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Waiting on you" count={pending.length} emphasis />
            {pending.map((request) => (
              <ApprovalCard
                key={request.id}
                request={request}
                onApprove={() => approve(request.id)}
                onReject={() => reject(request.id)}
              />
            ))}
          </View>
        ) : null}

        {inputRequest ? (
          <View style={styles.section}>
            <SectionHeader title="Question for you" emphasis />
            <Card attention>
              <Text style={[theme.typography.body, { color: theme.colors.text, lineHeight: 21 }]}>
                {inputRequest.message}
              </Text>
              <Text
                style={[
                  theme.typography.caption,
                  { color: theme.colors.textTertiary, marginTop: 8 },
                ]}
              >
                Asked {relativeTime(inputRequest.timestamp)} ago
              </Text>
            </Card>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader title="Recent messages" />
          {messages.length === 0 ? (
            <Card>
              <EmptyState compact icon="chatbubble-outline" title="No messages yet" />
            </Card>
          ) : (
            messages.map((event) => (
              <Card key={event.id} style={styles.messageCard}>
                <Text style={[theme.typography.body, { color: theme.colors.text, lineHeight: 21 }]}>
                  {event.message}
                </Text>
                <Text
                  style={[
                    theme.typography.caption,
                    { color: theme.colors.textTertiary, marginTop: 6 },
                  ]}
                >
                  {relativeTime(event.timestamp)} ago
                </Text>
              </Card>
            ))
          )}

          {isRemoteAgent ? (
            <Card style={styles.composer}>
              <View style={styles.remoteNotice}>
                <Ionicons
                  name="desktop-outline"
                  size={16}
                  color={theme.colors.textTertiary}
                />
                <Text
                  style={[
                    theme.typography.caption,
                    { color: theme.colors.textSecondary, flex: 1, lineHeight: 18 },
                  ]}
                >
                  This agent runs on your Windows PC. AgentHub receives its events
                  one-way and cannot reply or send commands — respond on the PC.
                </Text>
              </View>
            </Card>
          ) : (
          <Card style={styles.composer} padded={false}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={inputRequest ? 'Answer the question…' : `Message ${agent.name}…`}
              placeholderTextColor={theme.colors.textTertiary}
              style={[
                theme.typography.body,
                styles.input,
                { color: theme.colors.text },
              ]}
              multiline
              accessibilityLabel="Reply to agent"
            />
            <View style={styles.composerActions}>
              <Button
                label={inputRequest ? 'Send answer' : 'Send'}
                icon="arrow-up"
                variant="primary"
                onPress={handleSend}
                disabled={draft.trim().length === 0}
              />
            </View>
          </Card>
          )}
        </View>

        <View style={styles.section}>
          <SectionHeader title="Activity timeline" count={timeline.length} />
          <Card>
            {timeline.length === 0 ? (
              <EmptyState compact icon="time-outline" title="Nothing recorded yet" />
            ) : (
              timeline.map((event, index) => (
                <TimelineItem
                  key={event.id}
                  event={event}
                  isLast={index === timeline.length - 1}
                />
              ))
            )}
          </Card>
        </View>
      </Screen>
    </>
  );
}

function TimelineItem({ event, isLast }: { event: AgentEvent; isLast: boolean }) {
  const theme = useTheme();
  const meta = eventMeta(event.type, theme);

  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineGutter}>
        <Ionicons name={meta.icon} size={16} color={meta.color} />
        {!isLast ? (
          <View style={[styles.timelineLine, { backgroundColor: theme.colors.separator }]} />
        ) : null}
      </View>
      <View style={[styles.timelineBody, { paddingBottom: isLast ? 0 : 18 }]}>
        <Text style={[theme.typography.body, { color: theme.colors.text, lineHeight: 20 }]}>
          {event.message}
        </Text>
        <Text
          style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 3 }]}
        >
          {clockTime(event.timestamp)} · {relativeTime(event.timestamp)} ago
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerCard: {
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  headerText: {
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 16,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 10,
  },
  section: {
    marginBottom: 24,
  },
  messageCard: {
    marginBottom: 8,
  },
  composer: {
    marginTop: 4,
  },
  remoteNotice: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  input: {
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  composerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 4,
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 12,
  },
  timelineGutter: {
    alignItems: 'center',
    width: 18,
  },
  timelineLine: {
    flex: 1,
    width: StyleSheet.hairlineWidth * 2,
    marginTop: 4,
  },
  timelineBody: {
    flex: 1,
  },
});

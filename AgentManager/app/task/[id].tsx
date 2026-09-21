import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  Card,
  EmptyState,
  ExpandableText,
  MessageBubble,
  Screen,
  SectionHeader,
  TaskStateDot,
  taskStateColors,
  taskTitle,
} from '../../src/components';
import { useTaskConversation } from '../../src/services/conversation';
import { eventMeta } from '../../src/lib/eventMeta';
import { clockTime, relativeTime, shortDate } from '../../src/lib/time';
import { getPromptSender } from '../../src/services/prompt';
import {
  childConversationFor,
  childOutputFor,
  conversationFor,
  eventsForTask,
  findTask,
  latestOutputFor,
  statusLabel,
  subtaskTitle,
  subtasksFor,
  useAgentStore,
  visualStateFor,
} from '../../src/store';
import { useTheme } from '../../src/theme';
import type { ConversationMessage } from '../../src/protocol';
import type { AgentEvent, Subtask } from '../../src/types';

/** Only an https URL may be opened. Anything else keeps Open Chat disabled. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

export default function TaskDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = typeof id === 'string' ? decodeURIComponent(id) : '';

  const {
    tasks,
    subtasks,
    taskMeta,
    events,
    conversations,
    acceptTask,
    unacceptTask,
    setTaskMeta,
    forgetTask,
  } = useAgentStore();
  const task = findTask(tasks, taskId);
  const meta = taskMeta[taskId] ?? {};
  const timeline = useMemo(() => eventsForTask(events, taskId), [events, taskId]);
  const children = useMemo(() => subtasksFor(subtasks, taskId), [subtasks, taskId]);
  // The user-visible conversation lives on Windows; fetch it for this task on
  // open and whenever the task's activity changes.
  useTaskConversation(taskId, task?.updatedAt);
  const thread = conversationFor(conversations, taskId);
  const latestOutput = latestOutputFor(conversations, taskId);

  /* ---------------------------------------------------- local field state */

  const [title, setTitle] = useState(meta.customTitle ?? '');
  const [chatUrl, setChatUrl] = useState(meta.chatUrl ?? '');
  const [draft, setDraft] = useState(meta.promptDraft ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  /** Set the instant Forget is confirmed, so the "not found" view never flashes. */
  const [forgetting, setForgetting] = useState(false);

  // Re-seed the fields if persisted meta arrives after first render or the
  // route changes to another task.
  useEffect(() => {
    setTitle(meta.customTitle ?? '');
    setChatUrl(meta.chatUrl ?? '');
    setDraft(meta.promptDraft ?? '');
    setNotice(null);
    // Only when the task changes; the fields are the source of truth while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Autosave the prompt draft as it is typed (debounced), so leaving the
  // screen or closing the app never loses it.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!task) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if ((meta.promptDraft ?? '') !== draft) setTaskMeta(task.id, { promptDraft: draft });
    }, 500);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (forgetting) {
    // Navigation away is already in flight; render nothing meanwhile.
    return <Screen>{null}</Screen>;
  }

  if (!task) {
    return (
      <Screen title="Not found">
        <Card>
          <EmptyState
            icon="help-circle-outline"
            title="That task no longer exists"
            description="It may have fallen off the local history cap."
          />
          <Button label="Back" onPress={() => router.back()} style={{ marginTop: 12 }} />
        </Card>
      </Screen>
    );
  }

  const state = visualStateFor(task.status);
  const colors = taskStateColors(theme, state);
  const accepted = task.acceptedAt !== null;
  const finished = state === 'finished' && !accepted;
  const chatUrlValid = isHttpsUrl(chatUrl);
  const savedChatValid = Boolean(meta.chatUrl && isHttpsUrl(meta.chatUrl));
  const sender = getPromptSender();

  /* -------------------------------------------------------------- actions */

  const saveTitle = () => {
    setTaskMeta(task.id, { customTitle: title.trim() });
    setNotice(title.trim() ? 'Name saved.' : 'Name reset to default.');
  };

  const saveChatUrl = () => {
    const value = chatUrl.trim();
    if (value && !isHttpsUrl(value)) {
      setNotice('The ChatGPT link must be an https:// URL.');
      return;
    }
    setTaskMeta(task.id, { chatUrl: value });
    setNotice(value ? 'ChatGPT link saved.' : 'ChatGPT link removed.');
  };

  const openChat = () => {
    if (!meta.chatUrl || !isHttpsUrl(meta.chatUrl)) return;
    void Linking.openURL(meta.chatUrl);
  };

  /**
   * Forget: this device only. Removes the task record, its metadata (ChatGPT
   * link, prompt draft, custom title) and its accepted state, leaves every
   * other task, all notification settings and the push registration exactly
   * as they are, and deletes nothing on Claude or Windows.
   */
  const onForget = () => {
    const id = task.id;
    setForgetting(true);
    if (router.canGoBack()) router.back();
    else router.replace('/');
    forgetTask(id);
  };

  const sendPrompt = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setSending(true);
    setTaskMeta(task.id, { promptDraft: draft });
    const result = await sender.send({
      taskId: task.id,
      projectId: task.projectId,
      agentId: task.agentId,
      prompt,
    });
    setSending(false);
    setNotice(result.message);
  };

  /* ------------------------------------------------------------ rendering */

  return (
    <>
      <Stack.Screen options={{ title: task.projectName }} />
      <Screen>
        {/* Header */}
        <Card style={styles.headerCard}>
          <View style={styles.titleRow}>
            <TaskStateDot state={state} size={12} />
            <Text style={[theme.typography.title, { color: theme.colors.text, flex: 1 }]}>
              {taskTitle(task, meta)}
            </Text>
          </View>

          <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 6 }]}>
            {task.agentName} · {task.projectName}
            {task.origin === 'simulated' ? ' · simulated' : ''}
          </Text>

          <View style={[styles.divider, { backgroundColor: theme.colors.separator }]} />

          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusChip,
                { backgroundColor: colors.soft, borderColor: colors.border },
              ]}
            >
              <Text style={[theme.typography.captionStrong, { color: colors.fg }]}>
                {accepted ? 'Accepted' : statusLabel(task.status)}
              </Text>
            </View>
            <Text style={[theme.typography.caption, { color: theme.colors.textTertiary }]}>
              Updated {relativeTime(task.updatedAt)} ago · started {clockTime(task.createdAt)}
            </Text>
          </View>

          {accepted ? (
            <View style={styles.acceptedRow}>
              <Ionicons name="checkmark-circle" size={16} color={theme.colors.positive} />
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary, flex: 1 }]}>
                Accepted {shortDate(task.acceptedAt as string)}. It stays in Summary; a new event
                from this session would bring it back to Home.
              </Text>
            </View>
          ) : null}

          {finished ? (
            <Button
              label="Accept"
              icon="checkmark"
              variant="primary"
              style={{ marginTop: 16 }}
              onPress={() => {
                acceptTask(task.id);
                setNotice('Accepted. This task has moved to Summary.');
              }}
            />
          ) : null}

          {accepted ? (
            <Button
              label="Move back to active"
              icon="arrow-undo-outline"
              variant="secondary"
              style={{ marginTop: 16 }}
              onPress={() => {
                unacceptTask(task.id);
                setNotice('Back on Home.');
              }}
            />
          ) : null}

          {state === 'action' && !accepted ? (
            <View style={styles.acceptedRow}>
              <Ionicons name="desktop-outline" size={16} color={theme.colors.textTertiary} />
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary, flex: 1 }]}>
                {statusLabel(task.status)} — respond on your Windows PC. AgentHub receives events
                one-way and cannot answer for you.
              </Text>
            </View>
          ) : null}
        </Card>

        {notice ? (
          <Card style={styles.notice}>
            <View style={styles.noticeRow}>
              <Ionicons name="information-circle-outline" size={16} color={theme.colors.textTertiary} />
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary, flex: 1 }]}>
                {notice}
              </Text>
            </View>
          </Card>
        ) : null}

        {/* Latest output: the newest visible Claude response, shown on top when
            the main session has finished. Same record as the last CLAUDE turn
            in Conversation below; nothing is stored twice. */}
        {task.status === 'completed' && latestOutput ? (
          <View style={styles.section}>
            <SectionHeader title="Latest output" />
            <Card>
              <ExpandableText text={latestOutput.text} limit={900} />
              <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 10 }]}>
                {clockTime(latestOutput.timestamp)} · {relativeTime(latestOutput.timestamp)} ago
                {latestOutput.truncated ? ' · cut at the sender\'s size limit' : ''}
              </Text>
            </Card>
          </View>
        ) : null}

        {/* Conversation: the task's own user-visible turns, oldest first. */}
        <View style={styles.section}>
          <SectionHeader title="Conversation" count={thread.length} />
          {thread.length === 0 ? (
            <Card>
              <EmptyState
                compact
                icon="chatbubbles-outline"
                title="No conversation captured yet"
                description="Prompts and Claude's visible responses are recorded from the next turn onward and kept on your Windows PC."
              />
            </Card>
          ) : (
            <View>
              {thread.map((message, index) => (
                <MessageBubble key={message.messageId} message={message} isLast={index === thread.length - 1} />
              ))}
            </View>
          )}
        </View>

        {/* Agent activity: subagents of this task. Their prompts/outputs stay
            here, visually apart from the parent conversation above. */}
        {children.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Agent activity" count={children.length} />
            <Card padded={false}>
              {children.map((child, index) => (
                <SubtaskRow
                  key={child.id}
                  subtask={child}
                  output={childOutputFor(conversations, taskId, child.id)}
                  messages={childConversationFor(conversations, taskId, child.id)}
                  isLast={index === children.length - 1}
                />
              ))}
            </Card>
            <Text
              style={[
                theme.typography.caption,
                { color: theme.colors.textTertiary, marginTop: 8, lineHeight: 18 },
              ]}
            >
              Subagents this session launched. They finish on their own; only the main session
              finishes the task. Tap one to see its output.
            </Text>
          </View>
        ) : null}

        {/* Follow-up prompt: finished tasks only */}
        {finished ? (
          <View style={styles.section}>
            <SectionHeader title="Follow-up prompt" />
            <Card padded={false}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="What should the agent do next?"
                placeholderTextColor={theme.colors.textTertiary}
                multiline
                style={[theme.typography.body, styles.multiline, { color: theme.colors.text }]}
                accessibilityLabel="Follow-up prompt"
              />
              <View style={styles.cardActions}>
                <Text
                  style={[theme.typography.caption, { color: theme.colors.textTertiary, flex: 1 }]}
                >
                  {draft.trim().length > 0 ? 'Draft saved on this device.' : ''}
                </Text>
                <Button
                  label={sender.configured ? 'Send to agent' : 'Send to agent (not configured)'}
                  icon="arrow-up"
                  variant={sender.configured ? 'primary' : 'secondary'}
                  onPress={() => void sendPrompt()}
                  disabled={draft.trim().length === 0}
                  loading={sending}
                />
              </View>
            </Card>
            <Text
              style={[
                theme.typography.caption,
                { color: theme.colors.textTertiary, marginTop: 8, lineHeight: 18 },
              ]}
            >
              {sender.description}
            </Text>
          </View>
        ) : null}

        {/* ChatGPT link: all tasks */}
        <View style={styles.section}>
          <SectionHeader title="ChatGPT conversation" />
          <Card padded={false}>
            <TextInput
              value={chatUrl}
              onChangeText={setChatUrl}
              placeholder="https://chatgpt.com/c/…"
              placeholderTextColor={theme.colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={[theme.typography.body, styles.input, { color: theme.colors.text }]}
              accessibilityLabel="ChatGPT conversation URL"
            />
            <View style={styles.cardActions}>
              <Text
                style={[
                  theme.typography.caption,
                  {
                    color:
                      chatUrl.trim().length > 0 && !chatUrlValid
                        ? theme.colors.negative
                        : theme.colors.textTertiary,
                    flex: 1,
                  },
                ]}
              >
                {chatUrl.trim().length > 0 && !chatUrlValid
                  ? 'Must start with https://'
                  : savedChatValid
                    ? 'Saved'
                    : 'Paste a link, then Save'}
              </Text>
              <Button label="Save" variant="secondary" onPress={saveChatUrl} />
              <Button
                label="Open Chat"
                icon="open-outline"
                variant="primary"
                onPress={openChat}
                disabled={!savedChatValid}
              />
            </View>
          </Card>
          <Text
            style={[
              theme.typography.caption,
              { color: theme.colors.textTertiary, marginTop: 8, lineHeight: 18 },
            ]}
          >
            Stored only on this device and opened as a normal link. AgentHub never reads the
            conversation.
          </Text>
        </View>

        {/* Rename */}
        <View style={styles.section}>
          <SectionHeader title="Task name" />
          <Card padded={false}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={task.title}
              placeholderTextColor={theme.colors.textTertiary}
              style={[theme.typography.body, styles.input, { color: theme.colors.text }]}
              accessibilityLabel="Task name"
            />
            <View style={styles.cardActions}>
              <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, flex: 1 }]}>
                Leave empty to use “{task.title}”
              </Text>
              <Button label="Save" variant="secondary" onPress={saveTitle} />
            </View>
          </Card>
        </View>

        {/* Timeline */}
        <View style={styles.section}>
          <SectionHeader title="History" count={timeline.length} />
          <Card>
            {timeline.length === 0 ? (
              <EmptyState
                compact
                icon="time-outline"
                title="No events in this session"
                description="Event history is kept for the current app session; the task itself is saved."
              />
            ) : (
              timeline.map((event, index) => (
                <TimelineItem key={event.id} event={event} isLast={index === timeline.length - 1} />
              ))
            )}
          </Card>
        </View>

        {/* Forget: removes this one task from this device */}
        <View style={styles.section}>
          <SectionHeader title="Remove from AgentHub" />
          {confirmForget ? (
            <Card>
              <Text style={[theme.typography.headline, { color: theme.colors.text }]}>
                Forget this task?
              </Text>
              <Text
                style={[
                  theme.typography.caption,
                  { color: theme.colors.textSecondary, marginTop: 6, lineHeight: 18 },
                ]}
              >
                This removes it from AgentHub on this device. It does not delete anything from
                Claude or Windows.
              </Text>
              <View style={styles.confirmRow}>
                <Button label="Cancel" variant="secondary" onPress={() => setConfirmForget(false)} fill />
                <Button label="Forget" icon="trash-outline" variant="danger" onPress={onForget} fill />
              </View>
            </Card>
          ) : (
            <Button
              label="Forget task"
              icon="trash-outline"
              variant="danger"
              onPress={() => setConfirmForget(true)}
            />
          )}
          <Text
            style={[
              theme.typography.caption,
              { color: theme.colors.textTertiary, marginTop: 8, lineHeight: 18 },
            ]}
          >
            Removes this task, its ChatGPT link, draft and accepted state from this device only.
            Other tasks, notifications and push registration are untouched.
          </Text>
        </View>
      </Screen>
    </>
  );
}

function SubtaskRow({
  subtask,
  output,
  messages,
  isLast,
}: {
  subtask: Subtask;
  output: ConversationMessage | null;
  messages: ConversationMessage[];
  isLast: boolean;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const state = visualStateFor(subtask.status);
  const colors = taskStateColors(theme, state);
  const prompts = messages.filter((m) => m.role === 'user');
  const hasDetail = output !== null || prompts.length > 0;
  return (
    <View
      style={
        !isLast
          ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator }
          : null
      }
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${subtaskTitle(subtask)}, ${statusLabel(subtask.status)}`}
        style={({ pressed }) => [styles.subtaskRow, pressed ? { backgroundColor: theme.colors.cardPressed } : null]}
      >
        <TaskStateDot state={state} size={10} />
        <View style={{ flex: 1 }}>
          <Text style={[theme.typography.bodyStrong, { color: theme.colors.text }]} numberOfLines={expanded ? undefined : 1}>
            {subtaskTitle(subtask)}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 2 }]}>
            {subtask.agentType ? `${subtask.agentType} · ` : ''}
            Updated {relativeTime(subtask.updatedAt)} ago
            {hasDetail ? (expanded ? ' · hide output' : ' · show output') : ''}
          </Text>
        </View>
        <View style={[styles.statusChip, { backgroundColor: colors.soft, borderColor: colors.border }]}>
          <Text style={[theme.typography.captionStrong, { color: colors.fg }]}>
            {statusLabel(subtask.status)}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.subtaskDetail}>
          {prompts.length > 0 ? (
            <View style={{ marginBottom: 10 }}>
              <Text style={[theme.typography.captionStrong, { color: theme.colors.textSecondary, marginBottom: 6 }]}>
                Instructions
              </Text>
              {prompts.map((m) => (
                <ExpandableText key={m.messageId} text={m.text} limit={400} color={theme.colors.textSecondary} />
              ))}
            </View>
          ) : null}
          <Text style={[theme.typography.captionStrong, { color: theme.colors.textSecondary, marginBottom: 6 }]}>
            Output
          </Text>
          {output ? (
            <ExpandableText text={output.text} limit={600} />
          ) : (
            <Text style={[theme.typography.caption, { color: theme.colors.textTertiary }]}>
              {subtask.status === 'completed'
                ? 'No output was captured for this subagent.'
                : 'Output appears when the subagent finishes.'}
            </Text>
          )}
        </View>
      ) : null}
    </View>
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
        <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 3 }]}>
          {clockTime(event.timestamp)} · {relativeTime(event.timestamp)} ago
          {event.subtaskId ? ' · subagent' : ''}
          {event.stale ? ' · late' : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerCard: {
    marginBottom: 12,
  },
  subtaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  subtaskDetail: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    paddingLeft: 38,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 14,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
  },
  acceptedRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 14,
  },
  notice: {
    marginBottom: 12,
  },
  noticeRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  section: {
    marginTop: 12,
    marginBottom: 12,
  },
  multiline: {
    minHeight: 96,
    maxHeight: 220,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 6,
    textAlignVertical: 'top',
  },
  input: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 4,
  },
  confirmRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
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

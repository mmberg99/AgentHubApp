import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Card, EmptyState, Screen, SectionHeader, taskTitle } from '../../src/components';
import { shortDate } from '../../src/lib/time';
import { acceptedTasks, groupTasksByProject, useAgentStore } from '../../src/store';
import { useTheme } from '../../src/theme';
import type { Task, TaskMeta } from '../../src/types';

/**
 * Summary: every task the user has explicitly accepted, grouped by project.
 *
 * Accepting archives; it never deletes. Tapping a row opens the task's
 * details, history and saved ChatGPT link, and offers a way back to active.
 */
export default function SummaryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { tasks, taskMeta } = useAgentStore();

  const accepted = useMemo(() => acceptedTasks(tasks), [tasks]);
  const groups = useMemo(() => groupTasksByProject(accepted), [accepted]);

  return (
    <Screen
      title="Summary"
      subtitle={
        accepted.length === 0
          ? 'Accepted work appears here'
          : `${accepted.length} accepted ${accepted.length === 1 ? 'task' : 'tasks'} across ${groups.length} ${groups.length === 1 ? 'project' : 'projects'}`
      }
    >
      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon="checkmark-done-outline"
            title="Nothing accepted yet"
            description="When a finished task looks good, press Accept on it. It moves here and stays out of your way on Home."
          />
        </Card>
      ) : (
        groups.map((group) => (
          <View key={group.project.id} style={styles.section}>
            <SectionHeader title={group.project.name} count={group.tasks.length} />
            <Card padded={false}>
              {group.tasks.map((task, index) => (
                <AcceptedRow
                  key={task.id}
                  task={task}
                  meta={taskMeta[task.id]}
                  isLast={index === group.tasks.length - 1}
                  onPress={() => router.push(`/task/${encodeURIComponent(task.id)}`)}
                />
              ))}
            </Card>
          </View>
        ))
      )}

      <View style={{ height: theme.spacing.lg }} />
    </Screen>
  );
}

function AcceptedRow({
  task,
  meta,
  isLast,
  onPress,
}: {
  task: Task;
  meta?: TaskMeta;
  isLast: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={
        isLast
          ? undefined
          : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator }
      }
    >
    <Card
      onPress={onPress}
      padded={false}
      style={styles.flat}
      accessibilityLabel={`${taskTitle(task, meta)}, accepted`}
    >
      <View style={styles.row}>
        <Ionicons name="checkmark-circle" size={18} color={theme.colors.positive} />
        <View style={styles.body}>
          <Text style={[theme.typography.bodyStrong, { color: theme.colors.text }]} numberOfLines={1}>
            {taskTitle(task, meta)}
          </Text>
          <Text
            style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 2 }]}
            numberOfLines={1}
          >
            {task.agentName}
            {meta?.chatUrl ? ' · chat linked' : ''}
          </Text>
          <Text
            style={[theme.typography.caption, { color: theme.colors.textSecondary, marginTop: 2 }]}
          >
            Accepted {task.acceptedAt ? shortDate(task.acceptedAt) : ''}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color={theme.colors.textTertiary} />
      </View>
    </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 24,
  },
  flat: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  body: {
    flex: 1,
  },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { relativeTime } from '../lib/time';
import { statusLabel, visualStateFor } from '../store/taskIdentity';
import { useTheme } from '../theme';
import type { Task, TaskMeta } from '../types';
import { Card } from './Card';
import { TaskStateDot, taskStateColors } from './TaskStateDot';

interface TaskRowProps {
  task: Task;
  meta?: TaskMeta;
  onPress: () => void;
  /** Shows the project name; off when the row is already nested under it. */
  showProject?: boolean;
  /** Draws the row inside a parent card: no border, hairline separator. */
  nested?: boolean;
  isLast?: boolean;
}

/**
 * Display title. Manual rename > title derived from the first prompt on
 * Windows > "Task N". The ordinal stays underneath whatever is shown.
 */
export function taskTitle(task: Task, meta?: TaskMeta): string {
  return meta?.customTitle?.trim() || task.autoTitle || task.title;
}

export function TaskRow({
  task,
  meta,
  onPress,
  showProject = false,
  nested = false,
  isLast = false,
}: TaskRowProps) {
  const theme = useTheme();
  const state = visualStateFor(task.status);
  const colors = taskStateColors(theme, state);
  const hasChat = Boolean(meta?.chatUrl);

  const body = (
    <View style={styles.row}>
      <View style={styles.dotColumn}>
        <TaskStateDot state={state} size={10} />
      </View>

      <View style={styles.body}>
        <Text style={[theme.typography.bodyStrong, { color: theme.colors.text }]} numberOfLines={1}>
          {taskTitle(task, meta)}
        </Text>
        <Text
          style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 2 }]}
          numberOfLines={1}
        >
          {task.agentName}
          {showProject ? ` · ${task.projectName}` : ''}
          {hasChat ? ' · chat linked' : ''}
          {task.origin === 'simulated' ? ' · simulated' : ''}
        </Text>
      </View>

      <View style={styles.trailing}>
        <Text style={[theme.typography.captionStrong, { color: colors.fg }]}>
          {statusLabel(task.status)}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 2 }]}>
          {relativeTime(task.updatedAt)}
        </Text>
      </View>

      <Ionicons name="chevron-forward" size={14} color={theme.colors.textTertiary} />
    </View>
  );

  if (nested) {
    return (
      <View
        style={[
          styles.nested,
          !isLast && {
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.separator,
          },
        ]}
      >
        <Card
          onPress={onPress}
          padded={false}
          style={styles.flat}
          accessibilityLabel={`${taskTitle(task, meta)}, ${statusLabel(task.status)}`}
        >
          {body}
        </Card>
      </View>
    );
  }

  return (
    <Card
      onPress={onPress}
      style={styles.card}
      accessibilityLabel={`${taskTitle(task, meta)}, ${statusLabel(task.status)}`}
    >
      {body}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 8,
  },
  nested: {
    paddingHorizontal: 4,
  },
  flat: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  dotColumn: {
    width: 14,
    alignItems: 'center',
  },
  body: {
    flex: 1,
  },
  trailing: {
    alignItems: 'flex-end',
  },
});

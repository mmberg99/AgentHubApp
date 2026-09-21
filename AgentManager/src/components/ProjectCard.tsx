import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ProjectGroup } from '../store/selectors';
import { useTheme } from '../theme';
import type { Task, TaskMeta, TaskVisualState } from '../types';
import { Card } from './Card';
import { TaskRow } from './TaskRow';
import { TaskStateDot, taskStateColors } from './TaskStateDot';

interface ProjectCardProps {
  group: ProjectGroup;
  meta: Record<string, TaskMeta>;
  onPressTask: (task: Task) => void;
}

function CountPill({ state, label, value }: { state: TaskVisualState; label: string; value: number }) {
  const theme = useTheme();
  const colors = taskStateColors(theme, state);
  const lit = value > 0;
  return (
    <View style={styles.pill}>
      <TaskStateDot state={state} size={7} />
      <Text
        style={[
          theme.typography.caption,
          { color: lit ? colors.fg : theme.colors.textTertiary, fontWeight: lit ? '600' : '400' },
        ]}
      >
        {label} ({value})
      </Text>
    </View>
  );
}

/**
 * One project: a header with the name and three counts, then its tasks
 * nested underneath. Easy to scan top-to-bottom on a phone.
 */
export function ProjectCard({ group, meta, onPressTask }: ProjectCardProps) {
  const theme = useTheme();

  return (
    <Card padded={false} style={styles.card}>
      <View style={[styles.header, { borderBottomColor: theme.colors.separator }]}>
        <Text style={[theme.typography.headline, { color: theme.colors.text }]} numberOfLines={1}>
          {group.project.name}
        </Text>
        <View style={styles.counts}>
          <CountPill state="running" label="Running" value={group.running} />
          {group.idle > 0 ? <CountPill state="idle" label="Idle" value={group.idle} /> : null}
          <CountPill state="finished" label="Finished" value={group.finished} />
          <CountPill state="action" label="Needs action" value={group.action} />
        </View>
      </View>

      {group.tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          meta={meta[task.id]}
          onPress={() => onPressTask(task)}
          nested
          isLast={index === group.tasks.length - 1}
        />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 12,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  counts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
});

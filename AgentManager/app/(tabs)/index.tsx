import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  Card,
  EmptyState,
  ProjectCard,
  Screen,
  SectionHeader,
  StatusSummaryCard,
} from '../../src/components';
import {
  activeProjectCount,
  activeTasks,
  groupTasksByProject,
  needsActionCount,
  runningTaskCount,
  useAgentStore,
} from '../../src/store';
import { useTheme } from '../../src/theme';
import type { Task } from '../../src/types';

/**
 * Home: three status cards, then every active project with its tasks.
 *
 * Every number here is computed from real task state. Nothing is seeded, so
 * a fresh install shows zeros and an empty state until the first event.
 */
export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { tasks, taskMeta } = useAgentStore();

  const active = useMemo(() => activeTasks(tasks), [tasks]);
  const groups = useMemo(() => groupTasksByProject(active), [active]);
  const running = useMemo(() => runningTaskCount(tasks), [tasks]);
  const projects = useMemo(() => activeProjectCount(tasks), [tasks]);
  const action = useMemo(() => needsActionCount(tasks), [tasks]);

  const openTask = (task: Task) => router.push(`/task/${encodeURIComponent(task.id)}`);

  // Launched from a notification tap while the app was closed: the worker
  // opens "/?task=<id>" (see public/sw.js). Open that task once it exists —
  // it may only arrive with the startup history sync — and only once.
  const { task: requestedTask } = useLocalSearchParams<{ task?: string }>();
  const routedTo = useRef<string | null>(null);
  useEffect(() => {
    const id = typeof requestedTask === 'string' ? requestedTask : null;
    if (!id || routedTo.current === id) return;
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id)) return;
    if (!tasks.some((t) => t.id === id)) return;
    routedTo.current = id;
    router.push(`/task/${encodeURIComponent(id)}`);
  }, [requestedTask, tasks, router]);

  const subtitle =
    action > 0
      ? `${action} ${action === 1 ? 'task needs' : 'tasks need'} you`
      : running > 0
        ? `${running} ${running === 1 ? 'agent is' : 'agents are'} working`
        : active.length > 0
          ? 'Finished work is waiting for your review'
          : 'No active work';

  return (
    <Screen title="AgentHub" subtitle={subtitle}>
      <View style={styles.summary}>
        <StatusSummaryCard label="Running agents" value={running} state="running" />
        <StatusSummaryCard label="Active projects" value={projects} state="finished" />
        <StatusSummaryCard
          label="Needs action"
          value={action}
          state="action"
          onPress={action > 0 ? () => router.push('/activity') : undefined}
        />
      </View>

      <View style={styles.section}>
        <SectionHeader title="Projects" count={groups.length} />

        {groups.length === 0 ? (
          <Card>
            <EmptyState
              icon="folder-open-outline"
              title="No active projects"
              description="When an agent starts working, its workspace appears here with its tasks underneath. Accepted work moves to Summary."
            />
          </Card>
        ) : (
          groups.map((group) => (
            <ProjectCard
              key={group.project.id}
              group={group}
              meta={taskMeta}
              onPressTask={openTask}
            />
          ))
        )}
      </View>

      <View style={{ height: theme.spacing.lg }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 28,
  },
  section: {
    marginBottom: 28,
  },
});

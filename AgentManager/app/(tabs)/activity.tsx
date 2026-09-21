import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  Card,
  EmptyState,
  EventRow,
  FilterBar,
  Screen,
  type FilterOption,
} from '../../src/components';
import { externalEvents, findAgent, useAgentStore } from '../../src/store';
import { useTheme } from '../../src/theme';

type Filter = 'all' | 'action' | 'unread';

/**
 * Notifications: only events that really arrived — by push, history sync or
 * the explicit simulate controls. Newest first. Nothing is seeded.
 *
 * Tapping a row opens the task it belongs to.
 */
export default function NotificationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { agents, events, markAllRead } = useAgentStore();
  const [filter, setFilter] = useState<Filter>('all');

  const feed = useMemo(() => externalEvents(events), [events]);
  const actionable = useMemo(() => feed.filter((e) => e.requiresAction), [feed]);
  const unread = useMemo(() => feed.filter((e) => !e.read), [feed]);

  const options = useMemo<FilterOption<Filter>[]>(
    () => [
      { value: 'all', label: 'All', count: feed.length },
      { value: 'action', label: 'Needs action', count: actionable.length },
      { value: 'unread', label: 'Unread', count: unread.length },
    ],
    [feed.length, actionable.length, unread.length],
  );

  const visible = filter === 'action' ? actionable : filter === 'unread' ? unread : feed;

  return (
    <Screen
      title="Notifications"
      subtitle={
        actionable.length > 0
          ? `${actionable.length} ${actionable.length === 1 ? 'item needs' : 'items need'} action`
          : feed.length > 0
            ? 'Everything is up to date'
            : 'No events yet'
      }
      headerRight={
        unread.length > 0 ? (
          <Pressable
            onPress={markAllRead}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingTop: 10 })}
          >
            <Text style={[theme.typography.captionStrong, { color: theme.colors.accent }]}>
              Mark all read
            </Text>
          </Pressable>
        ) : null
      }
    >
      <FilterBar options={options} value={filter} onChange={setFilter} />

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="notifications-off-outline"
            title={feed.length === 0 ? 'No notifications yet' : 'Nothing matches this filter'}
            description={
              feed.length === 0
                ? 'Events from your agents will appear here as they arrive.'
                : undefined
            }
          />
        </Card>
      ) : (
        <View>
          {visible.map((event) => {
            const agent = findAgent(agents, event.agentId);
            return (
              <EventRow
                key={event.id}
                event={event}
                agentName={agent?.name ?? 'Unknown agent'}
                onPress={
                  event.taskId
                    ? () => router.push(`/task/${encodeURIComponent(event.taskId as string)}`)
                    : undefined
                }
              />
            );
          })}
        </View>
      )}
    </Screen>
  );
}

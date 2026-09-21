import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { relativeTime } from '../lib/time';
import { providerLabels, useTheme } from '../theme';
import type { Agent } from '../types';
import { needsAttention } from '../types';
import { Avatar } from './Avatar';
import { Card } from './Card';
import { StatusPill } from './StatusPill';

interface AgentRowProps {
  agent: Agent;
  onPress: () => void;
  /** Adds the amber card treatment when the agent is blocking on the user. */
  highlightAttention?: boolean;
  /** Replaces the status chip with a quieter inline dot + label. */
  compact?: boolean;
}

export function AgentRow({
  agent,
  onPress,
  highlightAttention = false,
  compact = false,
}: AgentRowProps) {
  const theme = useTheme();
  const attention = highlightAttention && needsAttention(agent);

  return (
    <Card
      onPress={onPress}
      attention={attention}
      style={styles.card}
      accessibilityLabel={`${agent.name}, ${theme.status[agent.status].label}`}
    >
      <View style={styles.row}>
        <Avatar initials={agent.avatar} status={agent.status} />

        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text
              style={[theme.typography.headline, { color: theme.colors.text }]}
              numberOfLines={1}
            >
              {agent.name}
            </Text>
            {agent.unread > 0 ? (
              <View style={[styles.unreadDot, { backgroundColor: theme.colors.accent }]} />
            ) : null}
          </View>

          <Text
            style={[theme.typography.caption, { color: theme.colors.textTertiary }]}
            numberOfLines={1}
          >
            {providerLabels[agent.provider]} · {agent.account}
          </Text>

          {agent.currentTask ? (
            <Text
              style={[
                theme.typography.body,
                { color: theme.colors.textSecondary, marginTop: 6 },
              ]}
              numberOfLines={2}
            >
              {agent.currentTask}
            </Text>
          ) : (
            <Text
              style={[
                theme.typography.body,
                { color: theme.colors.textTertiary, marginTop: 6, fontStyle: 'italic' },
              ]}
            >
              No active task
            </Text>
          )}

          <View style={styles.footer}>
            {compact ? (
              <StatusPill status={agent.status} variant="inline" />
            ) : (
              <StatusPill status={agent.status} />
            )}
            <Text style={[theme.typography.caption, { color: theme.colors.textTertiary }]}>
              {relativeTime(agent.lastUpdated)}
            </Text>
          </View>
        </View>

        <Ionicons
          name="chevron-forward"
          size={16}
          color={theme.colors.textTertiary}
          style={styles.chevron}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  body: {
    flex: 1,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  chevron: {
    marginTop: 12,
  },
});

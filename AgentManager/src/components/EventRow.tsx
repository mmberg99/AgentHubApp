import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { eventHeadline, eventMeta } from '../lib/eventMeta';
import { relativeTime } from '../lib/time';
import { useTheme } from '../theme';
import type { AgentEvent } from '../types';
import { Card } from './Card';

interface EventRowProps {
  event: AgentEvent;
  agentName: string;
  onPress?: () => void;
  /** Shows the agent name + headline above the message. Used in the inbox. */
  showAgent?: boolean;
}

export function EventRow({ event, agentName, onPress, showAgent = true }: EventRowProps) {
  const theme = useTheme();
  const meta = eventMeta(event.type, theme);
  const isRemote = event.origin === 'remote';
  const isSimulated = event.origin === 'simulated';

  return (
    <Card
      onPress={onPress}
      attention={event.requiresAction}
      style={styles.card}
      accessibilityLabel={`${agentName} ${eventHeadline(event.type)}`}
    >
      <View style={styles.row}>
        <View
          style={[
            styles.iconWrap,
            {
              backgroundColor: event.requiresAction
                ? 'transparent'
                : theme.scheme === 'dark'
                  ? '#1D1D24'
                  : '#F3F3F6',
            },
          ]}
        >
          <Ionicons name={meta.icon} size={17} color={meta.color} />
        </View>

        <View style={styles.body}>
          {showAgent ? (
            <View style={styles.titleLine}>
              <Text
                style={[theme.typography.bodyStrong, { color: theme.colors.text }]}
                numberOfLines={1}
              >
                {agentName}
              </Text>
              <Text
                style={[theme.typography.caption, { color: theme.colors.textTertiary }]}
                numberOfLines={1}
              >
                {eventHeadline(event.type)}
              </Text>
            </View>
          ) : null}

          <Text
            style={[
              theme.typography.body,
              {
                color: showAgent ? theme.colors.textSecondary : theme.colors.text,
                marginTop: showAgent ? 3 : 0,
              },
            ]}
          >
            {event.message}
          </Text>

          <View style={styles.footer}>
            <Text style={[theme.typography.caption, { color: theme.colors.textTertiary }]}>
              {relativeTime(event.timestamp)}
            </Text>
            {isRemote ? (
              <View style={[styles.originTag, { borderColor: theme.colors.border }]}>
                <Ionicons name="desktop-outline" size={10} color={theme.colors.textTertiary} />
                <Text style={[theme.typography.micro, { color: theme.colors.textTertiary }]}>
                  WINDOWS
                </Text>
              </View>
            ) : null}
            {isSimulated ? (
              <View style={[styles.originTag, { borderColor: theme.colors.attentionBorder }]}>
                <Ionicons name="flask-outline" size={10} color={theme.colors.attention} />
                <Text style={[theme.typography.micro, { color: theme.colors.attention }]}>
                  SIMULATED
                </Text>
              </View>
            ) : null}
            {event.stale ? (
              // Arrived after a newer event; kept as history but not applied.
              <Text style={[theme.typography.micro, { color: theme.colors.textTertiary }]}>
                LATE
              </Text>
            ) : null}
            {event.requiresAction ? (
              <Text style={[theme.typography.micro, { color: theme.colors.attention }]}>
                {/* Remote events cannot be actioned here; there is no path back to the PC. */}
                {isRemote ? 'RESPOND ON PC' : 'ACTION NEEDED'}
              </Text>
            ) : null}
            {!event.read && !event.requiresAction ? (
              <View style={[styles.unread, { backgroundColor: theme.colors.accent }]} />
            ) : null}
          </View>
        </View>
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
    gap: 12,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  unread: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  originTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

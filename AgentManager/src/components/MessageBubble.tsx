import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { clockTime } from '../lib/time';
import { CollapsibleMessage } from './CollapsibleMessage';
import type { ConversationMessage, MessageSummary } from '../protocol';
import { useTheme } from '../theme';

/** One turn of a conversation: YOU or CLAUDE, time, text. */
export function MessageBubble({
  message,
  summary,
  isLast = false,
}: {
  message: ConversationMessage;
  summary?: MessageSummary | null;
  isLast?: boolean;
}) {
  const theme = useTheme();
  const mine = message.role === 'user';
  return (
    <View style={[styles.row, { marginBottom: isLast ? 0 : 10 }]}>
      <View
        style={[
          styles.bubble,
          mine
            ? { backgroundColor: theme.colors.accentSoft, borderColor: 'transparent' }
            : { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
        ]}
      >
        <View style={styles.meta}>
          <Text
            style={[
              theme.typography.captionStrong,
              { color: mine ? theme.colors.accent : theme.colors.textSecondary, letterSpacing: 0.6 },
            ]}
          >
            {mine ? 'YOU' : 'CLAUDE'}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textTertiary }]}>
            {clockTime(message.timestamp)}
          </Text>
        </View>
        {/* Long messages collapse to a scannable card; short ones show in
            full. Expanding always reveals the complete original text. */}
        <CollapsibleMessage
          text={message.text}
          role={mine ? 'user' : 'assistant'}
          summary={summary}
        />
        {message.truncated ? (
          <Text style={[theme.typography.caption, { color: theme.colors.attention, marginTop: 6 }]}>
            Cut at the sender's size limit; the full text was longer.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
  },
  bubble: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
});

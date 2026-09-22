import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { clockTime } from '../lib/time';
import { ExpandableMarkdown } from './Markdown';
import type { ConversationMessage } from '../protocol';
import { useTheme } from '../theme';

/**
 * Untrusted display text. Rendered through <Text> only: never parsed as HTML
 * or markup, whitespace and code blocks kept as typed. Long messages collapse
 * so a phone screen stays usable; nothing is hidden permanently.
 */
export function ExpandableText({
  text,
  limit = 700,
  color,
}: {
  text: string;
  limit?: number;
  color?: string;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const overflow = text.length > limit;
  const shown = expanded || !overflow ? text : `${text.slice(0, limit).trimEnd()}…`;
  return (
    <View>
      <Text
        selectable
        style={[theme.typography.body, styles.text, { color: color ?? theme.colors.text }]}
      >
        {shown}
      </Text>
      {overflow ? (
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          hitSlop={8}
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
        >
          <Text style={[theme.typography.captionStrong, { color: theme.colors.accent }]}>
            {expanded ? 'Show less' : `Show more (${text.length.toLocaleString()} characters)`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One turn of a conversation: YOU or CLAUDE, time, text. */
export function MessageBubble({ message, isLast = false }: { message: ConversationMessage; isLast?: boolean }) {
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
        {/* Claude's text is Markdown; the user's own prompt is shown as typed. */}
        {mine ? <ExpandableText text={message.text} /> : <ExpandableMarkdown text={message.text} />}
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
  text: {
    lineHeight: 21,
  },
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

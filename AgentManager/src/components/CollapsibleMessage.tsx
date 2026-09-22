import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { buildMessagePreview, type MessageRole } from '../lib/messagePreview';
import type { MessageSummary } from '../protocol';
import { useTheme } from '../theme';
import { Markdown } from './Markdown';

/**
 * One conversation message, collapsed to a scannable card until asked.
 *
 * A long message shows a title and a short body written on Windows by the
 * summariser, or, when no card was produced, derived locally instead — the
 * message's own points as bullets, or a concise paragraph when it is one idea
 * — plus an action that reveals the COMPLETE original text. Nothing is
 * rewritten or stored: the preview is computed from the text on screen, and
 * expanding renders the original through the existing Markdown renderer.
 *
 * A message short enough to read as it is renders in full with no action, so
 * "Run the tests." never hides behind a disclosure.
 *
 * Expansion is component state, per card, for this session only.
 */
export function CollapsibleMessage({
  text,
  role,
  /** The card written on Windows. Absent means fall back to the local one. */
  summary,
  /** 'bubble' sits inside a chat bubble; 'plain' is used by panels. */
  variant = 'bubble',
}: {
  text: string;
  role: MessageRole;
  summary?: MessageSummary | null;
  variant?: 'bubble' | 'plain';
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const local = useMemo(() => buildMessagePreview(text, role), [text, role]);

  // A card from Windows always wins, and always collapses: the summariser only
  // writes one for a message long enough to be worth collapsing.
  const preview = summary
    ? {
        title: summary.title,
        kind: summary.style,
        paragraph: summary.paragraph,
        bullets: summary.bullets,
        needsExpansion: true,
      }
    : local;
  /** Not shown to the user; it makes the two paths distinguishable in tests. */
  const source = summary ? 'ai' : 'local';

  const full =
    role === 'assistant' ? (
      <Markdown source={text} />
    ) : (
      <Text selectable style={[theme.typography.body, styles.userText, { color: theme.colors.text }]}>
        {text}
      </Text>
    );

  if (!preview.needsExpansion) return full;

  const action = expanded
    ? 'Show less'
    : role === 'assistant'
      ? 'Show full response'
      : 'Show full prompt';

  return (
    <View testID={`message-card-${source}`}>
      {preview.title ? (
        <Text
          style={[
            theme.typography.bodyStrong,
            styles.title,
            { color: theme.colors.text },
            variant === 'plain' ? { marginTop: 0 } : null,
          ]}
        >
          {preview.title}
        </Text>
      ) : null}

      {expanded ? (
        <View style={preview.title ? styles.expandedBody : null}>{full}</View>
      ) : preview.kind === 'bullets' ? (
        <View style={styles.bullets}>
          {preview.bullets.map((bullet, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={[theme.typography.caption, styles.dot, { color: theme.colors.textTertiary }]}>
                •
              </Text>
              <Text
                style={[theme.typography.caption, styles.bulletText, { color: theme.colors.textSecondary }]}
              >
                {bullet}
              </Text>
            </View>
          ))}
        </View>
      ) : preview.paragraph ? (
        <Text
          style={[theme.typography.caption, styles.paragraph, { color: theme.colors.textSecondary }]}
        >
          {preview.paragraph}
        </Text>
      ) : null}

      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={action}
        hitSlop={8}
        style={styles.action}
      >
        <Text style={[theme.typography.captionStrong, { color: theme.colors.accent }]}>{action}</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-forward'}
          size={13}
          color={theme.colors.accent}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    lineHeight: 21,
    marginBottom: 6,
  },
  paragraph: {
    lineHeight: 19,
  },
  bullets: {
    marginTop: 1,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 3,
  },
  dot: {
    width: 14,
    lineHeight: 19,
  },
  bulletText: {
    flex: 1,
    lineHeight: 19,
  },
  expandedBody: {
    marginTop: 2,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    marginTop: 9,
  },
  userText: {
    lineHeight: 21,
  },
});

import React, { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  parseMarkdownBlocks,
  safeHref,
  truncateMarkdown,
  type MarkdownBlock,
  type MarkdownSpan,
} from '../lib/markdown';
import { useTheme } from '../theme';

/**
 * Renders the Markdown subset in `lib/markdown.ts` with React Native
 * primitives.
 *
 * SECURITY. Nothing here produces HTML. Every piece of the source ends up as
 * the `children` of a <Text>, which React escapes, so a `<script>` tag, an
 * `onerror=` attribute or an <iframe> in Claude's output is displayed as the
 * literal characters the model wrote and can never execute. Links are opened
 * only when `safeHref` accepted the scheme (http, https, mailto); anything
 * else was already downgraded to plain text by the parser, and this component
 * refuses it a second time before calling `Linking.openURL`.
 *
 * LAYOUT. Long code lines scroll horizontally inside their own box rather than
 * widening the card, so the phone layout never gains a horizontal scrollbar.
 */

/** Theme-neutral fill that reads correctly on both light and dark cards. */
const CODE_FILL = 'rgba(127,127,127,0.13)';
const CODE_BORDER = 'rgba(127,127,127,0.22)';

const MONOSPACE = Platform.select({
  web: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  default: 'Courier',
});

const HEADING_SIZE: Record<number, number> = { 1: 20, 2: 18, 3: 17, 4: 16, 5: 15, 6: 15 };

function openLink(href: string): void {
  if (safeHref(href) === null) return;
  try {
    void Linking.openURL(href);
  } catch {
    /* a link that will not open must never crash the screen */
  }
}

function Spans({ spans, color }: { spans: MarkdownSpan[]; color?: string }) {
  const theme = useTheme();
  const base = color ?? theme.colors.text;

  return (
    <>
      {spans.map((span, index) => {
        const style = [
          span.bold ? styles.bold : null,
          span.italic ? styles.italic : null,
          span.strike ? styles.strike : null,
          span.code
            ? { fontFamily: MONOSPACE, backgroundColor: CODE_FILL, fontSize: 14 }
            : null,
          { color: span.href ? theme.colors.accent : base },
          span.href ? styles.link : null,
        ];
        if (span.href) {
          const href = span.href;
          return (
            <Text
              key={index}
              style={style}
              accessibilityRole="link"
              onPress={() => openLink(href)}
            >
              {span.text}
            </Text>
          );
        }
        return (
          <Text key={index} style={style}>
            {span.text}
          </Text>
        );
      })}
    </>
  );
}

function Block({ block, color }: { block: MarkdownBlock; color?: string }) {
  const theme = useTheme();
  const base = color ?? theme.colors.text;

  switch (block.kind) {
    case 'heading':
      return (
        <Text
          accessibilityRole="header"
          style={[
            styles.heading,
            { color: base, fontSize: HEADING_SIZE[block.level] ?? 16 },
          ]}
        >
          <Spans spans={block.spans} color={base} />
        </Text>
      );

    case 'paragraph':
      return (
        <Text selectable style={[theme.typography.body, styles.paragraph, { color: base }]}>
          <Spans spans={block.spans} color={base} />
        </Text>
      );

    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: theme.colors.borderStrong }]}>
          <Text
            selectable
            style={[theme.typography.body, styles.paragraph, { color: theme.colors.textSecondary }]}
          >
            <Spans spans={block.spans} color={theme.colors.textSecondary} />
          </Text>
        </View>
      );

    case 'rule':
      return <View style={[styles.rule, { backgroundColor: theme.colors.separator }]} />;

    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={[styles.listRow, { paddingLeft: item.indent * 14 }]}>
              <Text
                style={[theme.typography.body, styles.bullet, { color: theme.colors.textTertiary }]}
              >
                {block.ordered ? `${item.marker ?? index + 1}.` : '•'}
              </Text>
              <Text selectable style={[theme.typography.body, styles.listText, { color: base }]}>
                <Spans spans={item.spans} color={base} />
              </Text>
            </View>
          ))}
        </View>
      );

    case 'code':
      return (
        <View style={[styles.codeBox, { backgroundColor: CODE_FILL, borderColor: CODE_BORDER }]}>
          {block.language ? (
            <Text style={[theme.typography.caption, { color: theme.colors.textTertiary, marginBottom: 4 }]}>
              {block.language}
            </Text>
          ) : null}
          {/* Its own scroller: a long line never widens the card or the page. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text selectable style={[styles.codeText, { color: base }]}>
              {block.text}
            </Text>
          </ScrollView>
        </View>
      );

    default:
      return null;
  }
}

export function Markdown({ source, color }: { source: string; color?: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source]);
  if (blocks.length === 0) return null;
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} color={color} />
      ))}
    </View>
  );
}

/**
 * Markdown with the same collapse behaviour as `ExpandableText`: long output
 * is cut at a line boundary so a fence or list is not split mid-token, and the
 * full text is always one tap away. Nothing is hidden permanently.
 */
export function ExpandableMarkdown({
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
  const { text: shown, truncated } = useMemo(
    () => (expanded ? { text, truncated: false } : truncateMarkdown(text, limit)),
    [text, limit, expanded],
  );
  const overflows = text.length > limit;

  return (
    <View>
      <Markdown source={shown} color={color} />
      {overflows ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          hitSlop={8}
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
        >
          <Text style={[theme.typography.captionStrong, { color: theme.colors.accent }]}>
            {expanded ? 'Show less' : `Show more (${text.length.toLocaleString()} characters)`}
          </Text>
        </Pressable>
      ) : null}
      {truncated ? null : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  paragraph: {
    lineHeight: 21,
    marginBottom: 8,
  },
  heading: {
    fontWeight: '700',
    lineHeight: 24,
    marginTop: 4,
    marginBottom: 6,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  link: {
    textDecorationLine: 'underline',
  },
  list: {
    marginBottom: 8,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 3,
  },
  bullet: {
    minWidth: 20,
    lineHeight: 21,
  },
  listText: {
    flex: 1,
    lineHeight: 21,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: 10,
    marginBottom: 8,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 10,
  },
  codeBox: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
    width: '100%',
    overflow: 'hidden',
  },
  codeText: {
    fontFamily: MONOSPACE,
    fontSize: 13,
    lineHeight: 19,
  },
});

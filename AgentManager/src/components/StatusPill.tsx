import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';
import type { AgentStatus } from '../types';

interface StatusPillProps {
  status: AgentStatus;
  /** Compact variant drops the background and shows a dot plus label. */
  variant?: 'chip' | 'inline';
}

export function StatusPill({ status, variant = 'chip' }: StatusPillProps) {
  const theme = useTheme();
  const style = theme.status[status];

  if (variant === 'inline') {
    return (
      <View style={styles.inline}>
        <View style={[styles.dot, { backgroundColor: style.dot }]} />
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {style.label}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: style.bg, borderRadius: theme.radius.pill },
      ]}
    >
      <Text style={[theme.typography.micro, { color: style.fg }]}>
        {style.label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});

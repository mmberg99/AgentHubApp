import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '../theme';

interface StatTileProps {
  label: string;
  value: number;
  tone?: 'attention' | 'neutral' | 'positive';
  onPress?: () => void;
}

/** One number in the Home summary row. Deliberately quiet unless it matters. */
export function StatTile({ label, value, tone = 'neutral', onPress }: StatTileProps) {
  const theme = useTheme();

  const isAttention = tone === 'attention' && value > 0;
  const valueColor = isAttention
    ? theme.colors.attention
    : tone === 'positive'
      ? theme.colors.textSecondary
      : theme.colors.text;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${value} ${label}`}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: isAttention ? theme.colors.attentionSoft : theme.colors.card,
          borderColor: isAttention ? theme.colors.attentionBorder : theme.colors.border,
          borderRadius: theme.radius.lg,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.value, { color: valueColor }]}>{value}</Text>
      <Text
        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
        numberOfLines={2}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
  },
  value: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.8,
    marginBottom: 2,
  },
});

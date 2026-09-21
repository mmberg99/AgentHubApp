import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';
import type { TaskVisualState } from '../types';
import { TaskStateDot, taskStateColors } from './TaskStateDot';

interface StatusSummaryCardProps {
  label: string;
  value: number;
  state: TaskVisualState;
  onPress?: () => void;
}

/**
 * One of the three compact cards at the top of Home. The colour is a status
 * indicator — a dot, a tinted number, a hairline — never a solid block.
 */
export function StatusSummaryCard({ label, value, state, onPress }: StatusSummaryCardProps) {
  const theme = useTheme();
  const colors = taskStateColors(theme, state);
  const lit = value > 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${value} ${label}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: lit ? colors.soft : theme.colors.card,
          borderColor: lit ? colors.border : theme.colors.border,
          borderRadius: theme.radius.lg,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.top}>
        <TaskStateDot state={state} />
        <Text
          style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          numberOfLines={2}
        >
          {label}
        </Text>
      </View>
      <Text style={[styles.value, { color: lit ? colors.fg : theme.colors.text }]}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    minHeight: 78,
    justifyContent: 'space-between',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  value: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.8,
    marginTop: 6,
  },
});

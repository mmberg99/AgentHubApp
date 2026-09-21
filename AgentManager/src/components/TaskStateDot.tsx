import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, type Theme } from '../theme';
import type { TaskVisualState } from '../types';

/**
 * The product colours, resolved against the active palette.
 *
 *   running   green    positive
 *   idle      gray     neutral — paused on background work, not finished
 *   finished  yellow   attention (amber)
 *   action    red      negative
 *
 * Kept in one place so every card, count and dot agrees.
 */
export function taskStateColors(
  theme: Theme,
  state: TaskVisualState,
): { fg: string; soft: string; border: string } {
  switch (state) {
    case 'idle':
      return {
        fg: theme.colors.textTertiary,
        soft: theme.scheme === 'dark' ? 'rgba(156,156,168,0.12)' : 'rgba(107,107,117,0.09)',
        border: theme.scheme === 'dark' ? 'rgba(156,156,168,0.28)' : 'rgba(107,107,117,0.22)',
      };
    case 'running':
      return {
        fg: theme.colors.positive,
        soft: theme.scheme === 'dark' ? 'rgba(91,201,139,0.13)' : 'rgba(21,128,61,0.09)',
        border: theme.scheme === 'dark' ? 'rgba(91,201,139,0.30)' : 'rgba(21,128,61,0.24)',
      };
    case 'finished':
      return {
        fg: theme.colors.attention,
        soft: theme.colors.attentionSoft,
        border: theme.colors.attentionBorder,
      };
    case 'action':
      return {
        fg: theme.colors.negative,
        soft: theme.scheme === 'dark' ? 'rgba(240,117,107,0.13)' : 'rgba(185,28,28,0.09)',
        border: theme.scheme === 'dark' ? 'rgba(240,117,107,0.30)' : 'rgba(185,28,28,0.24)',
      };
  }
}

export function TaskStateDot({ state, size = 8 }: { state: TaskVisualState; size?: number }) {
  const theme = useTheme();
  const { fg } = taskStateColors(theme, state);
  return (
    <View
      style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: fg }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {},
});

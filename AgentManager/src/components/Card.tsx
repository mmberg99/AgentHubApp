import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  /** Draws the amber attention treatment instead of the neutral border. */
  attention?: boolean;
  padded?: boolean;
  accessibilityLabel?: string;
}

export function Card({
  children,
  onPress,
  style,
  attention = false,
  padded = true,
  accessibilityLabel,
}: CardProps) {
  const theme = useTheme();

  const base: ViewStyle = {
    backgroundColor: attention ? theme.colors.attentionSoft : theme.colors.card,
    borderRadius: theme.radius.lg,
    // Hairline keeps borders quiet on retina instead of drawing a hard 1px line.
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    borderColor: attention ? theme.colors.attentionBorder : theme.colors.border,
    padding: padded ? theme.spacing.lg : 0,
    overflow: 'hidden',
  };

  if (!onPress) {
    return <View style={[base, style]}>{children}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        base,
        pressed && {
          backgroundColor: attention ? theme.colors.attentionSoft : theme.colors.cardPressed,
          opacity: 0.92,
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

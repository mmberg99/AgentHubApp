import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  /** Stretches the button to fill its row. */
  fill?: boolean;
}

export function Button({
  label,
  onPress,
  variant = 'secondary',
  icon,
  disabled = false,
  loading = false,
  style,
  fill = false,
}: ButtonProps) {
  const theme = useTheme();

  const palette: Record<Variant, { bg: string; fg: string; border: string }> = {
    primary: {
      bg: theme.colors.accent,
      fg: '#FFFFFF',
      border: theme.colors.accent,
    },
    secondary: {
      bg: theme.colors.card,
      fg: theme.colors.text,
      border: theme.colors.borderStrong,
    },
    danger: {
      bg: theme.colors.card,
      fg: theme.colors.negative,
      border: theme.colors.border,
    },
    ghost: {
      bg: 'transparent',
      fg: theme.colors.accent,
      border: 'transparent',
    },
  };

  const tone = palette[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: tone.bg,
          borderColor: tone.border,
          borderRadius: theme.radius.md,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
          flex: fill ? 1 : undefined,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tone.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={16} color={tone.fg} /> : null}
          <Text style={[theme.typography.bodyStrong, { color: tone.fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
  },
});

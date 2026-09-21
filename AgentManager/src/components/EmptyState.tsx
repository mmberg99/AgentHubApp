import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../theme';

interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
  compact?: boolean;
}

export function EmptyState({
  icon = 'checkmark-circle-outline',
  title,
  description,
  compact = false,
}: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View style={[styles.wrap, { paddingVertical: compact ? 20 : 44 }]}>
      <Ionicons name={icon} size={compact ? 22 : 28} color={theme.colors.textTertiary} />
      <Text
        style={[
          theme.typography.bodyStrong,
          { color: theme.colors.textSecondary, marginTop: 10 },
        ]}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={[
            theme.typography.caption,
            { color: theme.colors.textTertiary, marginTop: 4, textAlign: 'center' },
          ]}
        >
          {description}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
});

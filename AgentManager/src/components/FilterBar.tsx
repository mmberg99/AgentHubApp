import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useTheme } from '../theme';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface FilterBarProps<T extends string> {
  options: FilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
}

export function FilterBar<T extends string>({
  options,
  value,
  onChange,
}: FilterBarProps<T>) {
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: selected ? theme.colors.text : theme.colors.card,
                borderColor: selected ? theme.colors.text : theme.colors.border,
                borderRadius: theme.radius.pill,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text
              style={[
                theme.typography.captionStrong,
                { color: selected ? theme.colors.bg : theme.colors.textSecondary },
              ]}
            >
              {option.label}
              {typeof option.count === 'number' ? `  ${option.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    marginBottom: 16,
    marginHorizontal: -16,
  },
  row: {
    gap: 8,
    paddingHorizontal: 16,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
  },
});

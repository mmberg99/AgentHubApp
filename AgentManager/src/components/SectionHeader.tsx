import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';

interface SectionHeaderProps {
  title: string;
  count?: number;
  /** Renders the title in the attention colour. */
  emphasis?: boolean;
  action?: React.ReactNode;
}

export function SectionHeader({ title, count, emphasis, action }: SectionHeaderProps) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <View style={styles.titleRow}>
        <Text
          style={[
            theme.typography.headline,
            { color: emphasis ? theme.colors.attention : theme.colors.text },
          ]}
        >
          {title}
        </Text>
        {typeof count === 'number' && count > 0 ? (
          <View
            style={[
              styles.count,
              {
                backgroundColor: emphasis
                  ? theme.colors.attentionSoft
                  : theme.scheme === 'dark'
                    ? '#22222A'
                    : '#EFEFF3',
              },
            ]}
          >
            <Text
              style={[
                theme.typography.micro,
                { color: emphasis ? theme.colors.attention : theme.colors.textSecondary },
              ]}
            >
              {count}
            </Text>
          </View>
        ) : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  count: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: 'center',
  },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';
import type { AgentStatus } from '../types';

interface AvatarProps {
  initials: string;
  status: AgentStatus;
  size?: number;
  /** Shows the small status dot in the corner. */
  showStatus?: boolean;
}

export function Avatar({ initials, status, size = 40, showStatus = true }: AvatarProps) {
  const theme = useTheme();
  const statusStyle = theme.status[status];

  return (
    <View>
      <View
        style={[
          styles.circle,
          {
            width: size,
            height: size,
            borderRadius: size / 3.2,
            backgroundColor: theme.scheme === 'dark' ? '#22222A' : '#F0F0F4',
          },
        ]}
      >
        <Text
          style={[
            theme.typography.captionStrong,
            { color: theme.colors.textSecondary, fontSize: size * 0.34 },
          ]}
        >
          {initials}
        </Text>
      </View>
      {showStatus ? (
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor: statusStyle.dot,
              borderColor: theme.colors.card,
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: size * 0.15,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    borderWidth: 2,
  },
});

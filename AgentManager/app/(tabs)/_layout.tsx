import React from 'react';
import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { needsActionCount, useAgentStore } from '../../src/store';
import { useTheme } from '../../src/theme';

/**
 * Bottom navigation: Home · Notifications · Summary · Settings.
 *
 * The former Agents tab is hidden (`href: null`) rather than deleted: its
 * screen and the agent detail route stay in the tree until the project/task
 * design is verified, but they are no longer reachable from the tab bar.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const { tasks } = useAgentStore();
  const pending = needsActionCount(tasks);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.colors.tabBar,
          borderTopColor: theme.colors.separator,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        // Red, matching the needs-action language on cards.
        tabBarBadgeStyle: {
          backgroundColor: theme.colors.negative,
          color: '#FFFFFF',
          fontSize: 11,
          fontWeight: '700',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="summary"
        options={{
          title: 'Summary',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="checkmark-done-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Kept, hidden. See the note above. */}
      <Tabs.Screen name="agents" options={{ href: null }} />
    </Tabs>
  );
}

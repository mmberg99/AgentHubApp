import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  Card,
  PushNotificationsSection,
  Screen,
  SectionHeader,
  WindowsNotificationsSection,
} from '../../src/components';
import { providerRegistry } from '../../src/providers';
import { useAgentStore } from '../../src/store';
import { providerLabels, useTheme, useThemePreference, type ThemePreference } from '../../src/theme';
import type { ProviderId } from '../../src/types';

function ThemeSelector() {
  const theme = useTheme();
  const { preference, setPreference } = useThemePreference();
  const options: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  return (
    <View
      style={[
        styles.segment,
        { backgroundColor: theme.scheme === 'dark' ? '#1C1C22' : '#EFEFF3' },
      ]}
    >
      {options.map((option) => {
        const selected = option.value === preference;
        return (
          <Pressable
            key={option.value}
            onPress={() => setPreference(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
              styles.segmentItem,
              selected && {
                backgroundColor: theme.colors.card,
                borderRadius: theme.radius.sm,
              },
            ]}
          >
            <Text
              style={[
                theme.typography.captionStrong,
                { color: selected ? theme.colors.text : theme.colors.textSecondary },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function SettingsScreen() {
  const theme = useTheme();
  const { agents } = useAgentStore();

  const providerIds = Object.keys(providerRegistry) as ProviderId[];

  return (
    <Screen title="Settings" subtitle="Events arrive from your Windows PC">
      <View style={styles.section}>
        <SectionHeader title="Appearance" />
        <Card padded={false} style={styles.appearanceCard}>
          <ThemeSelector />
        </Card>
      </View>

      <PushNotificationsSection />

      <WindowsNotificationsSection />

      <View style={styles.section}>
        <SectionHeader title="Providers" />
        <Card padded={false}>
          {providerIds.map((id, index) => {
            const adapter = providerRegistry[id];
            return (
              <View
                key={id}
                style={[
                  styles.row,
                  {
                    borderBottomWidth:
                      index === providerIds.length - 1 ? 0 : StyleSheet.hairlineWidth,
                    borderBottomColor: theme.colors.separator,
                  },
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[theme.typography.body, { color: theme.colors.text }]}>
                    {providerLabels[id]}
                  </Text>
                  <Text
                    style={[
                      theme.typography.caption,
                      { color: theme.colors.textTertiary, marginTop: 1 },
                    ]}
                  >
                    {agents.filter((a) => a.provider === id).length} agents
                  </Text>
                </View>
                <Text
                  style={[
                    theme.typography.caption,
                    { color: adapter.connected ? theme.colors.positive : theme.colors.textTertiary },
                  ]}
                >
                  {adapter.connected ? 'Connected' : 'Not connected'}
                </Text>
              </View>
            );
          })}
        </Card>
      </View>

      <Card style={styles.about}>
        <View style={styles.aboutRow}>
          <Ionicons name="information-circle-outline" size={18} color={theme.colors.textTertiary} />
          <Text
            style={[
              theme.typography.caption,
              { color: theme.colors.textSecondary, flex: 1, lineHeight: 18 },
            ]}
          >
            AgentHub shows only real events from your agents. No demo data is seeded, no
            backend or provider API is contacted, and accepted work, chat links and drafts
            are stored only on this device.
          </Text>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
  },
  appearanceCard: {
    padding: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  rowIcon: {
    width: 22,
  },
  rowText: {
    flex: 1,
  },
  segment: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
  },
  about: {
    marginBottom: 20,
  },
  aboutRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
});

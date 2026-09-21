import React from 'react';
import { ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

interface ScreenProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Renders children in a plain View instead of a ScrollView. */
  scroll?: boolean;
  contentStyle?: ViewStyle;
  headerRight?: React.ReactNode;
}

/**
 * Shared page chrome: safe-area padding, large title, and consistent gutters.
 * Every tab uses this so spacing never drifts between screens.
 */
export function Screen({
  title,
  subtitle,
  children,
  scroll = true,
  contentStyle,
  headerRight,
}: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const header =
    title != null ? (
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text
            style={[theme.typography.largeTitle, { color: theme.colors.text }]}
            accessibilityRole="header"
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[
                theme.typography.callout,
                { color: theme.colors.textSecondary, marginTop: 2 },
              ]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {headerRight}
      </View>
    ) : null;

  const padding = {
    paddingTop: insets.top + theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    // Clears the floating tab bar.
    paddingBottom: insets.bottom + 92,
  };

  if (!scroll) {
    return (
      <View style={[{ flex: 1, backgroundColor: theme.colors.bgGrouped }, padding, contentStyle]}>
        {header}
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bgGrouped }}
      contentContainerStyle={[padding, contentStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  headerText: {
    flex: 1,
  },
});

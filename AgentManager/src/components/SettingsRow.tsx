import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../theme';

type IconName = keyof typeof Ionicons.glyphMap;

interface BaseRowProps {
  icon?: IconName;
  label: string;
  description?: string;
  isLast?: boolean;
}

export interface ActionRowProps extends BaseRowProps {
  tint?: string;
  onPress: () => void;
}

/** Tappable settings row with a chevron. */
export function ActionRow({
  icon,
  label,
  description,
  tint,
  onPress,
  isLast,
}: ActionRowProps) {
  const theme = useTheme();
  const color = tint ?? theme.colors.text;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.separator,
          backgroundColor: pressed ? theme.colors.cardPressed : 'transparent',
        },
      ]}
    >
      {icon ? <Ionicons name={icon} size={19} color={color} style={styles.icon} /> : null}
      <View style={styles.text}>
        <Text style={[theme.typography.body, { color }]}>{label}</Text>
        {description ? (
          <Text
            style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 1 }]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.colors.textTertiary} />
    </Pressable>
  );
}

export interface InfoRowProps extends BaseRowProps {
  value: string;
  /** Colour for the value text; defaults to secondary. */
  valueTone?: string;
  /** Small uppercase tag shown next to the value, e.g. "SIMULATED". */
  tag?: string;
}

/** Read-only settings row showing a label and its current value. */
export function InfoRow({
  icon,
  label,
  description,
  value,
  valueTone,
  tag,
  isLast,
}: InfoRowProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.row,
        {
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.separator,
        },
      ]}
    >
      {icon ? (
        <Ionicons name={icon} size={19} color={theme.colors.textSecondary} style={styles.icon} />
      ) : null}
      <View style={styles.text}>
        <Text style={[theme.typography.body, { color: theme.colors.text }]}>{label}</Text>
        {description ? (
          <Text
            style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 1 }]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <View style={styles.valueWrap}>
        {tag ? (
          <View style={[styles.tag, { backgroundColor: theme.colors.attentionSoft }]}>
            <Text style={[theme.typography.micro, { color: theme.colors.attention }]}>{tag}</Text>
          </View>
        ) : null}
        <Text
          style={[
            theme.typography.caption,
            { color: valueTone ?? theme.colors.textSecondary, textAlign: 'right' },
          ]}
          numberOfLines={2}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

export interface ToggleRowProps extends BaseRowProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
}

/** Settings row with a native switch. */
export function ToggleRow({
  icon,
  label,
  description,
  value,
  onValueChange,
  isLast,
}: ToggleRowProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.row,
        {
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.separator,
        },
      ]}
    >
      {icon ? (
        <Ionicons name={icon} size={19} color={theme.colors.text} style={styles.icon} />
      ) : null}
      <View style={styles.text}>
        <Text style={[theme.typography.body, { color: theme.colors.text }]}>{label}</Text>
        {description ? (
          <Text
            style={[theme.typography.caption, { color: theme.colors.textTertiary, marginTop: 1 }]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        trackColor={{ true: theme.colors.accent, false: undefined }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  icon: {
    width: 22,
  },
  text: {
    flex: 1,
  },
  valueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '46%',
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
});

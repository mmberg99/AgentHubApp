import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useNotificationService, useNotificationStatus } from '../services/notifications';
import { useTheme } from '../theme';
import { Button } from './Button';
import { Card } from './Card';
import { SectionHeader } from './SectionHeader';
import { InfoRow } from './SettingsRow';

/**
 * Web Push status and the one control that turns it on.
 *
 * PERMISSION IS NEVER REQUESTED AUTOMATICALLY. WebKit only honours
 * `Notification.requestPermission()` inside a user gesture, and prompting
 * unasked is hostile anyway. The sole caller is the button below, in the
 * handler for a direct tap.
 *
 * The rows report the real transport state — if something is not working, this
 * screen says so rather than implying success.
 */

type Phase = 'idle' | 'registering' | 'failed';

export function PushNotificationsSection() {
  const theme = useTheme();
  const service = useNotificationService();
  const status = useNotificationStatus();
  const [phase, setPhase] = useState<Phase>('idle');
  const [detail, setDetail] = useState<string | null>(null);

  const isWeb = Platform.OS === 'web';
  const registered = status.registration.registered;
  const permission = status.permission;

  /**
   * The full enable flow, all inside one tap:
   * service worker ready -> permission -> PushManager.subscribe -> register
   * with the relay -> store the returned capability token.
   */
  const onEnable = useCallback(async () => {
    setPhase('registering');
    setDetail(null);

    const granted = await service.requestPermissions();
    if (granted !== 'granted') {
      setPhase('idle');
      setDetail(
        granted === 'denied'
          ? 'iOS denied notification permission. Enable it in Settings > Notifications > AgentHub.'
          : 'Notification permission was dismissed.',
      );
      return;
    }

    const result = await service.register();
    if (!result.registered) {
      setPhase('failed');
      return;
    }

    setPhase('idle');
    setDetail(null);
  }, [service]);

  /* ------------------------------------------------------------ rendering */

  let statusLabel = 'Not enabled';
  let statusTone = theme.colors.textTertiary;

  if (!isWeb) {
    statusLabel = 'Web only';
  } else if (phase === 'registering') {
    statusLabel = 'Registering…';
    statusTone = theme.colors.textSecondary;
  } else if (permission === 'denied') {
    statusLabel = 'Permission denied';
    statusTone = theme.colors.negative;
  } else if (phase === 'failed') {
    statusLabel = 'Registration failed';
    statusTone = theme.colors.negative;
  } else if (registered) {
    statusLabel = 'Enabled';
    statusTone = theme.colors.positive;
  }

  const permissionLabel =
    permission === 'granted'
      ? 'Granted'
      : permission === 'denied'
        ? 'Denied'
        : 'Not requested';

  const showButton = isWeb && !registered && permission !== 'denied';

  return (
    <View style={styles.section}>
      <SectionHeader title="Push Notifications" />
      <Text
        style={[
          theme.typography.caption,
          { color: theme.colors.textTertiary, marginBottom: 10, lineHeight: 18 },
        ]}
      >
        Delivers agent events to this device when AgentHub is closed. Events travel
        from your Windows PC through Apple&apos;s push service — no Mac required.
      </Text>

      <Card padded={false}>
        <InfoRow
          icon={registered ? 'cloud-done-outline' : 'cloud-offline-outline'}
          label="Status"
          value={statusLabel}
          valueTone={statusTone}
        />
        <InfoRow
          icon="lock-open-outline"
          label="Permission"
          description={
            permission === 'denied'
              ? 'Re-enable in iOS Settings > Notifications > AgentHub'
              : 'iOS notification permission'
          }
          value={permissionLabel}
          valueTone={
            permission === 'granted'
              ? theme.colors.positive
              : theme.colors.textTertiary
          }
        />
        <InfoRow
          icon="phone-portrait-outline"
          label="Device registration"
          description={
            registered
              ? 'This device is subscribed with the relay'
              : 'No push subscription exists on this device'
          }
          value={registered ? 'Registered' : 'Not registered'}
          valueTone={
            registered ? theme.colors.positive : theme.colors.textTertiary
          }
          isLast={!registered}
        />
        {registered ? (
          <InfoRow
            icon="sync-outline"
            label="Missed events"
            description="Fetched from the relay when AgentHub opens"
            value={status.connectionState === 'connected' ? 'In sync' : 'Relay unreachable'}
            valueTone={
              status.connectionState === 'connected'
                ? theme.colors.positive
                : theme.colors.textTertiary
            }
            isLast
          />
        ) : null}
      </Card>

      {showButton ? (
        <View style={styles.action}>
          <Button
            label={phase === 'registering' ? 'Registering…' : 'Enable notifications'}
            onPress={onEnable}
            disabled={phase === 'registering'}
          />
        </View>
      ) : null}

      {detail ?? status.lastError ? (
        <Card style={styles.notice}>
          <View style={styles.noticeRow}>
            <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textTertiary} />
            <Text
              style={[
                theme.typography.caption,
                { color: theme.colors.textSecondary, flex: 1, lineHeight: 18 },
              ]}
            >
              {detail ?? status.lastError}
            </Text>
          </View>
        </Card>
      ) : null}

      {registered ? null : (
        <Card style={styles.notice}>
          <View style={styles.noticeRow}>
            <Ionicons
              name="information-circle-outline"
              size={16}
              color={theme.colors.textTertiary}
            />
            <Text
              style={[
                theme.typography.caption,
                { color: theme.colors.textSecondary, flex: 1, lineHeight: 18 },
              ]}
            >
              Add AgentHub to your Home Screen first — iOS only allows web
              notifications for installed apps. Then tap Enable notifications.
            </Text>
          </View>
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
  },
  action: {
    marginTop: 12,
  },
  notice: {
    marginTop: 10,
  },
  noticeRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
});

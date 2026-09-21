import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { relativeTime } from '../lib/time';
import { useTheme } from '../theme';
import type { ApprovalRequest } from '../types';
import { Button } from './Button';
import { Card } from './Card';

interface ApprovalCardProps {
  request: ApprovalRequest;
  onApprove: () => void;
  onReject: () => void;
  /** Shown above the title when the card appears outside the agent detail. */
  agentName?: string;
}

/**
 * The single most important surface in the app: a decision the user owes an
 * agent. Kept visually distinct but calm — amber, not red.
 */
export function ApprovalCard({
  request,
  onApprove,
  onReject,
  agentName,
}: ApprovalCardProps) {
  const theme = useTheme();

  if (request.status !== 'pending') {
    const approved = request.status === 'approved';
    return (
      <Card style={styles.card}>
        <View style={styles.resolvedRow}>
          <Ionicons
            name={approved ? 'checkmark-circle' : 'close-circle'}
            size={18}
            color={approved ? theme.colors.positive : theme.colors.textTertiary}
          />
          <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
            {request.title} — {approved ? 'approved' : 'rejected'}
            {request.resolvedAt ? ` ${relativeTime(request.resolvedAt)} ago` : ''}
          </Text>
        </View>
      </Card>
    );
  }

  return (
    <Card attention style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons
          name="shield-checkmark"
          size={16}
          color={theme.colors.attention}
        />
        <Text style={[theme.typography.micro, { color: theme.colors.attention }]}>
          APPROVAL REQUIRED
        </Text>
        <Text
          style={[
            theme.typography.caption,
            { color: theme.colors.textTertiary, marginLeft: 'auto' },
          ]}
        >
          {relativeTime(request.createdAt)}
        </Text>
      </View>

      {agentName ? (
        <Text
          style={[
            theme.typography.caption,
            { color: theme.colors.textSecondary, marginTop: 10 },
          ]}
        >
          {agentName}
        </Text>
      ) : null}

      <Text
        style={[
          theme.typography.headline,
          { color: theme.colors.text, marginTop: agentName ? 2 : 10 },
        ]}
      >
        {request.title}
      </Text>

      <Text
        style={[
          theme.typography.body,
          { color: theme.colors.textSecondary, marginTop: 6, lineHeight: 21 },
        ]}
      >
        {request.description}
      </Text>

      <View style={styles.actions}>
        <Button label="Reject" variant="danger" icon="close" onPress={onReject} fill />
        <Button label="Approve" variant="primary" icon="checkmark" onPress={onApprove} fill />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  resolvedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});

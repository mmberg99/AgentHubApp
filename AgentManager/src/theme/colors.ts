import type { AgentStatus, ProviderId } from '../types';

export interface Palette {
  /** Screen background. */
  bg: string;
  /** Grouped background behind cards. */
  bgGrouped: string;
  card: string;
  cardPressed: string;
  border: string;
  borderStrong: string;
  separator: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentSoft: string;
  tabBar: string;
  /** Used for the single strongest attention affordance. */
  attention: string;
  attentionSoft: string;
  attentionBorder: string;
  positive: string;
  negative: string;
  overlay: string;
}

export const lightPalette: Palette = {
  bg: '#FFFFFF',
  bgGrouped: '#F6F6F8',
  card: '#FFFFFF',
  cardPressed: '#F1F1F4',
  border: '#E6E6EA',
  borderStrong: '#D6D6DC',
  separator: '#ECECF0',
  text: '#16161A',
  textSecondary: '#6B6B75',
  textTertiary: '#9A9AA4',
  accent: '#4F46E5',
  accentSoft: 'rgba(79,70,229,0.10)',
  tabBar: 'rgba(255,255,255,0.94)',
  attention: '#B45309',
  attentionSoft: 'rgba(180,83,9,0.09)',
  attentionBorder: 'rgba(180,83,9,0.24)',
  positive: '#15803D',
  negative: '#B91C1C',
  overlay: 'rgba(0,0,0,0.35)',
};

export const darkPalette: Palette = {
  bg: '#0C0C0F',
  bgGrouped: '#0C0C0F',
  card: '#15151A',
  cardPressed: '#1D1D23',
  border: '#26262E',
  borderStrong: '#33333D',
  separator: '#1F1F26',
  text: '#F4F4F7',
  textSecondary: '#9C9CA8',
  textTertiary: '#6E6E7A',
  accent: '#8B85F5',
  accentSoft: 'rgba(139,133,245,0.14)',
  tabBar: 'rgba(12,12,15,0.94)',
  attention: '#E3A857',
  attentionSoft: 'rgba(227,168,87,0.12)',
  attentionBorder: 'rgba(227,168,87,0.28)',
  positive: '#5BC98B',
  negative: '#F0756B',
  overlay: 'rgba(0,0,0,0.55)',
};

export interface StatusStyle {
  label: string;
  /** Text/icon colour. */
  fg: string;
  /** Low-contrast chip background. */
  bg: string;
  /** Small dot shown in lists. */
  dot: string;
}

type StatusMap = Record<AgentStatus, StatusStyle>;

export const lightStatus: StatusMap = {
  needs_approval: {
    label: 'Needs Approval',
    fg: '#B45309',
    bg: 'rgba(180,83,9,0.10)',
    dot: '#D97706',
  },
  needs_input: {
    label: 'Needs Input',
    fg: '#6D28D9',
    bg: 'rgba(109,40,217,0.09)',
    dot: '#7C3AED',
  },
  running: {
    label: 'Running',
    fg: '#1D4ED8',
    bg: 'rgba(29,78,216,0.09)',
    dot: '#2563EB',
  },
  completed: {
    label: 'Completed',
    fg: '#15803D',
    bg: 'rgba(21,128,61,0.09)',
    dot: '#16A34A',
  },
  idle: {
    label: 'Idle',
    fg: '#6B6B75',
    bg: 'rgba(107,107,117,0.09)',
    dot: '#9A9AA4',
  },
  failed: {
    label: 'Failed',
    fg: '#B91C1C',
    bg: 'rgba(185,28,28,0.09)',
    dot: '#DC2626',
  },
};

export const darkStatus: StatusMap = {
  needs_approval: {
    label: 'Needs Approval',
    fg: '#E3A857',
    bg: 'rgba(227,168,87,0.14)',
    dot: '#E3A857',
  },
  needs_input: {
    label: 'Needs Input',
    fg: '#B49BF5',
    bg: 'rgba(180,155,245,0.14)',
    dot: '#B49BF5',
  },
  running: {
    label: 'Running',
    fg: '#7BA6F7',
    bg: 'rgba(123,166,247,0.14)',
    dot: '#7BA6F7',
  },
  completed: {
    label: 'Completed',
    fg: '#5BC98B',
    bg: 'rgba(91,201,139,0.13)',
    dot: '#5BC98B',
  },
  idle: {
    label: 'Idle',
    fg: '#9C9CA8',
    bg: 'rgba(156,156,168,0.12)',
    dot: '#6E6E7A',
  },
  failed: {
    label: 'Failed',
    fg: '#F0756B',
    bg: 'rgba(240,117,107,0.13)',
    dot: '#F0756B',
  },
};

/** Provider labels live here so no screen hardcodes a vendor name. */
export const providerLabels: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Gemini',
  custom: 'Custom',
};

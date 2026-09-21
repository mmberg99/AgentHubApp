import React, { createContext, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import {
  darkPalette,
  darkStatus,
  lightPalette,
  lightStatus,
  type Palette,
  type StatusStyle,
} from './colors';
import { radius, spacing, typography } from './tokens';
import type { AgentStatus } from '../types';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Theme {
  scheme: 'light' | 'dark';
  colors: Palette;
  status: Record<AgentStatus, StatusStyle>;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreference] = useState<ThemePreference>('system');

  const value = useMemo<ThemeContextValue>(() => {
    const resolved: 'light' | 'dark' =
      preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

    const theme: Theme = {
      scheme: resolved,
      colors: resolved === 'dark' ? darkPalette : lightPalette,
      status: resolved === 'dark' ? darkStatus : lightStatus,
      spacing,
      radius,
      typography,
    };

    return { theme, preference, setPreference };
  }, [preference, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx.theme;
}

export function useThemePreference() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemePreference must be used inside ThemeProvider');
  return { preference: ctx.preference, setPreference: ctx.setPreference };
}

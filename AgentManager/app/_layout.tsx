import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Stack, router } from 'expo-router';
import * as SystemUI from 'expo-system-ui';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ConversationSync } from '../src/services/conversation';
import { NotificationBridge } from '../src/services/notifications';
import { registerServiceWorker } from '../src/services/pwa';
import { AgentStoreProvider } from '../src/store';
import { ThemeProvider, useTheme } from '../src/theme';

/**
 * Inner shell: lives below ThemeProvider so it can read the resolved palette
 * and apply it to the native stack, status bar and root window background.
 */
function ThemedShell() {
  const theme = useTheme();

  useEffect(() => {
    // Web only, and a no-op on native. Failures are swallowed by design so a
    // browser without service worker support still runs the app.
    void registerServiceWorker();
  }, []);

  useEffect(() => {
    // Prevents a white flash behind the app when in dark mode.
    void SystemUI.setBackgroundColorAsync(theme.colors.bgGrouped);
  }, [theme.colors.bgGrouped]);

  useEffect(() => {
    // A notification tapped while the app is already open: the worker tells
    // us which task (the PARENT task, for a subagent's notification) and we
    // navigate to it. Only an opaque task id is read; nothing else in the
    // message is trusted or used.
    if (Platform.OS !== 'web') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; data?: { taskId?: unknown } } | null;
      if (!data || data.type !== 'agenthub:notification-click') return;
      const taskId = data.data?.taskId;
      if (typeof taskId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(taskId)) return;
      router.push(`/task/${encodeURIComponent(taskId)}`);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.bgGrouped },
          headerShadowVisible: false,
          headerTintColor: theme.colors.accent,
          headerTitleStyle: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
          contentStyle: { backgroundColor: theme.colors.bgGrouped },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="task/[id]"
          options={{ title: '', headerBackTitle: 'Back' }}
        />
        {/* Legacy agent detail. Unreachable from the new navigation; kept
            until the project/task design is verified. */}
        <Stack.Screen
          name="agent/[id]"
          options={{ title: '', headerBackTitle: 'Back' }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AgentStoreProvider>
            {/* Connects inbound agent events to app state. Renders nothing. */}
            <NotificationBridge />
            {/* Keeps task titles in step with the conversation store on Windows. */}
            <ConversationSync />
            <ThemedShell />
          </AgentStoreProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { useAgentStore } from '../../store';
import { fetchConversationSummaries, fetchTaskConversation } from './conversationClient';

/**
 * Keeps task titles in step with Windows.
 *
 * Renders nothing. Fetches the conversation summaries (titles + counts, never
 * text) on mount, on resume, and shortly after any new agent event arrives, and
 * hands them to the store, which applies each task's derived title once. The
 * full text of a conversation is fetched only by the task screen that shows it
 * (see `useTaskConversation`).
 */
export function ConversationSync() {
  const { events, tasks, applyConversationSummaries } = useAgentStore();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const summaries = await fetchConversationSummaries();
      if (!cancelled && summaries) applyConversationSummaries(summaries);
    };
    if (timer.current) clearTimeout(timer.current);
    // Debounced: a burst of replayed events becomes one request.
    timer.current = setTimeout(() => void run(), 800);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // Re-run when the set of known events or tasks changes.
  }, [events.length, tasks.length, applyConversationSummaries]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void fetchConversationSummaries().then((s) => {
        if (s) applyConversationSummaries(s);
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [applyConversationSummaries]);

  return null;
}

/**
 * Loads one task's full conversation into the store: on mount and whenever the
 * task's activity changes (`refreshKey`, typically `task.updatedAt`).
 */
export function useTaskConversation(taskId: string, refreshKey: string | undefined): void {
  const { setConversation } = useAgentStore();
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void fetchTaskConversation(taskId).then((conv) => {
        if (!cancelled && conv) setConversation(conv);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [taskId, refreshKey, setConversation]);
}

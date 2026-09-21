import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  AgentRow,
  Card,
  EmptyState,
  FilterBar,
  Screen,
  type FilterOption,
} from '../../src/components';
import { useAgentStore } from '../../src/store';
import type { Agent } from '../../src/types';
import { needsAttention } from '../../src/types';

type Filter = 'all' | 'attention' | 'running' | 'completed';

const MATCHERS: Record<Filter, (agent: Agent) => boolean> = {
  all: () => true,
  attention: needsAttention,
  running: (a) => a.status === 'running',
  completed: (a) => a.status === 'completed',
};

export default function AgentsScreen() {
  const router = useRouter();
  const { agents } = useAgentStore();
  const [filter, setFilter] = useState<Filter>('all');

  const options = useMemo<FilterOption<Filter>[]>(
    () => [
      { value: 'all', label: 'All', count: agents.length },
      { value: 'attention', label: 'Attention', count: agents.filter(MATCHERS.attention).length },
      { value: 'running', label: 'Running', count: agents.filter(MATCHERS.running).length },
      { value: 'completed', label: 'Completed', count: agents.filter(MATCHERS.completed).length },
    ],
    [agents],
  );

  const visible = useMemo(() => {
    const matcher = MATCHERS[filter];
    // Attention first regardless of filter, then most recently updated.
    return agents
      .filter(matcher)
      .slice()
      .sort((a, b) => {
        const attentionDelta = Number(needsAttention(b)) - Number(needsAttention(a));
        if (attentionDelta !== 0) return attentionDelta;
        return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
      });
  }, [agents, filter]);

  return (
    <Screen title="Agents" subtitle={`${agents.length} agents across 4 providers`}>
      <FilterBar options={options} value={filter} onChange={setFilter} />

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="funnel-outline"
            title="No agents in this view"
            description="Try a different filter."
          />
        </Card>
      ) : (
        <View>
          {visible.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              highlightAttention
              onPress={() => router.push(`/agent/${agent.id}`)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

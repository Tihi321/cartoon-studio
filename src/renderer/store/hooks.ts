import { useMemo } from 'react'
import { useStore } from 'zustand'
import { ctsStore } from './store'
import type { AgentView, CtsStore } from './store'

export function useCts<T>(selector: (s: CtsStore) => T): T {
  return useStore(ctsStore, selector)
}

/** All agents in engine order. */
export function useAgentList(): AgentView[] {
  const agents = useCts((s) => s.agents)
  const order = useCts((s) => s.agentOrder)
  return useMemo(() => order.map((id) => agents[id]).filter((a): a is AgentView => !!a), [agents, order])
}

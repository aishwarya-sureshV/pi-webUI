import type { AgentBackend } from './api'

export const BACKENDS: AgentBackend[] = ['pi', 'claude', 'grok']

export function parseBackend(value: string | null | undefined): AgentBackend {
  return value === 'claude' || value === 'grok' ? value : 'pi'
}

export function backendFromSearch(search = typeof window === 'undefined' ? '' : window.location.search): AgentBackend {
  return parseBackend(new URLSearchParams(search).get('backend'))
}

export function backendSearch(backend: AgentBackend, search = typeof window === 'undefined' ? '' : window.location.search): string {
  const params = new URLSearchParams(search)
  if (backend === 'pi') params.delete('backend')
  else params.set('backend', backend)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function backendLabel(backend: AgentBackend | undefined, variant: 'short' | 'long' = 'short'): string {
  if (backend === 'claude') return variant === 'long' ? 'Claude Code' : 'Claude'
  if (backend === 'grok') return 'Grok'
  return variant === 'long' ? 'pi' : 'Pi'
}

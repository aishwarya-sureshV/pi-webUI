import type { ModelInfo } from './api'

export const GROK_DEFAULT_MODEL_ID = 'grok-4.6'
export const GROK_DEFAULT_EFFORT = 'high'
export const GROK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh']

export function formatGrokModelName(value: string | undefined): string {
  const stripped = String(value || '').trim()
  if (!stripped) return 'Grok'
  return stripped.replace(/^grok[\s_-]+/i, 'Grok ').replace(/\s+/g, ' ')
}

export const GROK_MODELS: ModelInfo[] = ['grok-4.6', 'grok-4.5'].map((id) => ({
  provider: 'xai',
  id,
  name: formatGrokModelName(id),
}))

export function grokModelInfo(modelId: string | undefined): ModelInfo | null {
  const raw = String(modelId || '').trim()
  if (!raw) return null
  const known = GROK_MODELS.find((model) => model.id === raw || raw.startsWith(`${model.id}-`))
  if (known) return { ...known }
  return { provider: 'xai', id: raw, name: formatGrokModelName(raw) }
}

export const GROK_DEFAULT_MODEL: ModelInfo = grokModelInfo(GROK_DEFAULT_MODEL_ID)!

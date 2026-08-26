/**
 * Turns the first user prompt into the short session label used by Claude and
 * Codex-style conversation lists. Explicit session names are passed through by
 * callers; this helper is intentionally only for prompt-derived labels.
 */
export function isLocalCommandText(value: string | undefined): boolean {
  return /<local-command-caveat>|<command-name>|<command-message>|<command-args>/.test(value || '')
}

export function contextualSessionTitle(value: string | undefined, fallback: string): string {
  const source = (value || fallback)
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const normalized = source.toLowerCase().replace(/\bpoiting\b/g, 'pointing')
  if (normalized.includes('codex') && normalized.includes('ollama')) {
    if (/revert|restore|switch|back to codex/.test(normalized)) return 'Restore Codex models from Ollama'
    return 'Codex and Ollama model configuration'
  }
  if (normalized.includes('grok') && normalized.includes('pi') && /different|compare|versus|vs\.?\b/.test(normalized)) {
    return 'Compare Grok models inside Pi'
  }

  let title = source.replace(/\bpoiting\b/gi, 'pointing')
  title = title.split(/(?:[.!?](?:\s|$)|\n)/, 1)[0]?.trim() || fallback
  title = title
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|i (?:want|need) (?:you )?to\s+|my\s+)/i, '')
    .replace(/\bis currently\b/i, 'currently')
    .replace(/\bjust (?:tell|show|explain)(?: me)?\b.*$/i, '')
    .trim()
  title = title
    .replace(/\bcodex\b/gi, 'Codex')
    .replace(/\bollama\b/gi, 'Ollama')
    .replace(/\bclaude\b/gi, 'Claude')
    .replace(/\bgrok\b/gi, 'Grok')
    .replace(/\bpi\b/gi, 'Pi')
  if (!title) title = fallback
  title = title.charAt(0).toUpperCase() + title.slice(1)
  if (title.length <= 68) return title
  const shortened = title.slice(0, 68).replace(/\s+\S*$/, '').trim()
  return `${shortened || title.slice(0, 68).trim()}…`
}

/**
 * Saved-session records keep both the stored name and the first prompt. A
 * stored name equal to that prompt is Pi's default, so it should be rendered
 * as a concise prompt-derived title; explicit /name titles stay untouched.
 */
export function savedSessionTitle(name: string, firstPrompt: string | undefined): string {
  if (isLocalCommandText(name) || isLocalCommandText(firstPrompt)) {
    return contextualSessionTitle(firstPrompt, 'Untitled session')
  }
  if (firstPrompt && name.trim() === firstPrompt.trim()) return contextualSessionTitle(firstPrompt, name)
  return name || firstPrompt || 'Untitled session'
}

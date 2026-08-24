import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type PiCatalogResponse } from '../lib/api'
import type { WorkbenchView } from '../lib/navigation'
import { IconCube, IconExtension, IconRefresh, IconSearch, IconSettings } from './icons'

const EMPTY_CATALOG: PiCatalogResponse = { ok: true, skills: [], extensions: [], settings: {} }

export function WorkbenchPage({
  view,
  theme,
  onThemeChange,
}: {
  view: Exclude<WorkbenchView, 'sessions'>
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
}) {
  const [catalog, setCatalog] = useState<PiCatalogResponse>(EMPTY_CATALOG)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const refresh = () => {
    setLoading(true)
    void api.catalog().then((result) => {
      setCatalog(result)
      setLoading(false)
    })
  }

  useEffect(refresh, [])
  useEffect(() => setQuery(''), [view])

  const normalizedQuery = query.trim().toLowerCase()
  const skills = useMemo(
    () => catalog.skills.filter((item) => !normalizedQuery || `${item.name} ${item.description}`.toLowerCase().includes(normalizedQuery)),
    [catalog.skills, normalizedQuery],
  )
  const extensions = useMemo(
    () => catalog.extensions.filter((item) => !normalizedQuery || `${item.name} ${item.description} ${item.spec}`.toLowerCase().includes(normalizedQuery)),
    [catalog.extensions, normalizedQuery],
  )

  const title = view === 'skills' ? 'Skills' : view === 'extensions' ? 'Extensions' : 'Settings'
  const description = view === 'skills'
    ? 'Specialized instructions available to your local Pi agent.'
    : view === 'extensions'
      ? 'Packages and local extensions loaded by Pi.'
      : 'Workbench appearance and your current Pi defaults.'

  return (
    <div className="resource-page">
      <header className="resource-page__header">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button type="button" className="resource-page__refresh" onClick={refresh} disabled={loading}>
          <IconRefresh /> Refresh
        </button>
      </header>

      {!catalog.ok && <div className="resource-page__error" role="alert">{catalog.error ?? 'Pi resources could not be loaded.'}</div>}

      {view !== 'settings' && (
        <label className="resource-page__search">
          <IconSearch />
          <input
            type="search"
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${title.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}

      <div className="resource-page__content" aria-busy={loading}>
        {loading && <div className="resource-page__empty">Loading {title.toLowerCase()}…</div>}
        {!loading && view === 'skills' && (
          <ResourceList
            items={skills.map((skill) => ({
              key: skill.path,
              icon: <IconCube size={18} />,
              title: skill.name,
              description: skill.description,
              metadata: skill.path,
            }))}
            empty={normalizedQuery ? 'No skills match this search.' : 'No local Pi skills are installed.'}
          />
        )}
        {!loading && view === 'extensions' && (
          <ResourceList
            items={extensions.map((extension) => ({
              key: `${extension.source}:${extension.path}`,
              icon: <IconExtension size={18} />,
              title: extension.name,
              description: extension.description,
              badge: [extension.source, extension.version].filter(Boolean).join(' · '),
              metadata: extension.spec,
            }))}
            empty={normalizedQuery ? 'No extensions match this search.' : 'No Pi extensions are installed.'}
          />
        )}
        {!loading && view === 'settings' && (
          <SettingsView catalog={catalog} theme={theme} onThemeChange={onThemeChange} />
        )}
      </div>
    </div>
  )
}

function ResourceList({
  items,
  empty,
}: {
  items: Array<{ key: string; icon: ReactNode; title: string; description: string; badge?: string; metadata: string }>
  empty: string
}) {
  if (items.length === 0) return <div className="resource-page__empty">{empty}</div>
  return (
    <div className="resource-grid">
      {items.map((item) => (
        <article className="resource-card" key={item.key}>
          <span className="resource-card__icon">{item.icon}</span>
          <div className="resource-card__body">
            <div className="resource-card__title">
              <strong>{item.title}</strong>
              {item.badge && <span>{item.badge}</span>}
            </div>
            <p>{item.description}</p>
            <code title={item.metadata}>{item.metadata}</code>
          </div>
        </article>
      ))}
    </div>
  )
}

function SettingsView({
  catalog,
  theme,
  onThemeChange,
}: {
  catalog: PiCatalogResponse
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
}) {
  const settings = catalog.settings
  const rows = [
    ['Default provider', settings.defaultProvider || 'Not set'],
    ['Default model', settings.defaultModel || 'Not set'],
    ['Default effort', settings.defaultThinkingLevel || 'off'],
    ['Pi terminal theme', settings.theme || 'Default'],
    ['Installed terminal themes', String(settings.themeCount ?? 0)],
    ['Thinking blocks', settings.hideThinkingBlock ? 'Hidden' : 'Visible'],
    ['Startup', settings.quietStartup ? 'Quiet' : 'Standard'],
  ]
  return (
    <div className="settings-stack">
      <section className="settings-card">
        <div className="settings-card__heading"><IconSettings /><div><strong>Workbench appearance</strong><span>Choose how Pi Workbench looks.</span></div></div>
        <div className="settings-card__theme" role="group" aria-label="Workbench appearance">
          <button type="button" className={theme === 'light' ? 'is-active' : ''} aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>Light</button>
          <button type="button" className={theme === 'dark' ? 'is-active' : ''} aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>Dark</button>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-card__heading"><IconCube /><div><strong>Pi defaults</strong><span>Read from your local Pi settings.</span></div></div>
        <dl className="settings-card__rows">
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {settings.path && <code className="settings-card__path">{settings.path}</code>}
      </section>
    </div>
  )
}

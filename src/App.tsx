import { useEffect, useState } from 'react'
import { StoreProvider, useStore } from './lib/store'
import { Sidebar } from './components/Sidebar'
import { Conversation } from './components/Conversation'
import { DetailsPanel } from './components/DetailsPanel'
import { WorkbenchPage } from './components/WorkbenchPage'
import { FishLogo } from './components/icons'
import type { WorkbenchView } from './lib/navigation'
import './styles/app.css'
import './styles/conversation.css'

function Frame() {
  const { active, detailsOpen } = useStore()
  const [view, setView] = useState<WorkbenchView>('sessions')
  const detailsVisible = view === 'sessions' && detailsOpen && active !== undefined
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('pi-web.sidebar') === 'collapsed')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('pi-web.theme.v2') === 'dark' ? 'dark' : 'light')

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
    localStorage.setItem('pi-web.theme.v2', theme)
  }, [theme])

  const toggleSidebar = () => setSidebarCollapsed((collapsed) => {
    localStorage.setItem('pi-web.sidebar', collapsed ? 'expanded' : 'collapsed')
    return !collapsed
  })

  return (
    <div
      className="app-frame"
      style={{ gridTemplateColumns: `${sidebarCollapsed ? 56 : 264}px minmax(0, 1fr) ${detailsVisible ? 300 : 0}px` }}
    >
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        theme={theme}
        onThemeToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        view={view}
        onViewChange={setView}
      />
      <main className="center">
        {view === 'sessions'
          ? (active ? <Conversation key={active.key} tab={active} /> : <EmptyCenter />)
          : <WorkbenchPage view={view} theme={theme} onThemeChange={setTheme} />}
      </main>
      <div className="details" hidden={!detailsVisible}>
        {detailsVisible && <DetailsPanel />}
      </div>
    </div>
  )
}

function EmptyCenter() {
  return (
    <div className="conversation">
      <div className="hero">
        <div className="hero__glow" />
        <div className="hero__stack">
          <div className="hero__headline">
            <span className="hero__fish"><FishLogo size={34} /></span>
            <span className="hero__title">Into the Unknown</span>
            <span className="hero__badge">Preview</span>
          </div>
          <div className="hero__opening">Opening your workspace…</div>
        </div>
      </div>
    </div>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Frame />
    </StoreProvider>
  )
}

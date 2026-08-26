import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { StoreProvider, useStore } from './lib/store'
import { Sidebar } from './components/Sidebar'
import { Conversation } from './components/Conversation'
import { WorkbenchPage } from './components/WorkbenchPage'
import { TerminalPage } from './components/TerminalPage'
import { FishLogo } from './components/icons'
import type { WorkbenchView } from './lib/navigation'
import './styles/app.css'
import './styles/conversation.css'

function Frame() {
  const { tabs, active, activeKey, setActiveKey, closeConversation } = useStore()
  const [view, setView] = useState<WorkbenchView>('sessions')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('pi-web.sidebar') === 'collapsed')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem('pi-web.sidebar-width'))
    return Number.isFinite(stored) ? Math.min(480, Math.max(200, stored)) : 264
  })
  const [splitSessions, setSplitSessions] = useState(() => localStorage.getItem('pi-web.session-layout') === 'split')
  const [splitSessionKeys, setSplitSessionKeys] = useState<string[]>([])
  const [paneWidths, setPaneWidths] = useState<Record<string, number>>({})
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('pi-web.theme.v2') === 'dark' ? 'dark' : 'light')

  useEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
    localStorage.setItem('pi-web.theme.v2', theme)
  }, [theme])

  const toggleSidebar = () => setSidebarCollapsed((collapsed) => {
    localStorage.setItem('pi-web.sidebar', collapsed ? 'expanded' : 'collapsed')
    return !collapsed
  })

  const toggleSplitSessions = () => {
    if (splitSessions) {
      focusSession(activeKey)
      return
    }
    localStorage.setItem('pi-web.session-layout', 'split')
    setSplitSessionKeys(tabs.map((tab) => tab.key))
    setSplitSessions(true)
  }

  const focusSession = (key: string) => {
    localStorage.setItem('pi-web.session-layout', 'focus')
    if (key) setActiveKey(key)
    setSplitSessions(false)
    setSplitSessionKeys([])
    for (const tab of tabs) {
      if (tab.key !== key) closeConversation(tab.key)
    }
  }

  const splitWithSession = (key: string) => {
    localStorage.setItem('pi-web.session-layout', 'split')
    setSplitSessionKeys((current) => {
      const base = current.length > 0 ? current : [activeKey]
      return [...new Set([...base, key])].filter(Boolean)
    })
    setSplitSessions(true)
  }

  const visibleTabs = splitSessions
    ? tabs.filter((tab) => splitSessionKeys.length === 0 || splitSessionKeys.includes(tab.key))
    : (active ? [active] : [])

  const persistSidebarWidth = (width: number) => {
    const next = Math.min(480, Math.max(200, width))
    setSidebarWidth(next)
    localStorage.setItem('pi-web.sidebar-width', String(next))
    return next
  }

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = sidebarWidth
    const onMove = (moveEvent: PointerEvent) => {
      persistSidebarWidth(startWidth + moveEvent.clientX - startX)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-sidebar')
    }
    document.body.classList.add('is-resizing-sidebar')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    persistSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 24 : -24))
  }

  const startPaneResize = (event: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    const pane = event.currentTarget.previousElementSibling as HTMLElement | null
    if (!pane) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = pane.getBoundingClientRect().width
    const onMove = (moveEvent: PointerEvent) => {
      setPaneWidths((current) => ({ ...current, [key]: Math.max(420, startWidth + moveEvent.clientX - startX) }))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-sessions')
    }
    document.body.classList.add('is-resizing-sessions')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const resizePaneWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const pane = event.currentTarget.previousElementSibling as HTMLElement | null
    if (!pane) return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 48 : -48
    setPaneWidths((current) => ({ ...current, [key]: Math.max(420, (current[key] ?? pane.getBoundingClientRect().width) + delta) }))
  }

  return (
    <div
      className="app-frame"
      style={{
        gridTemplateColumns: `${sidebarCollapsed ? 56 : sidebarWidth}px minmax(0, 1fr)`,
        ['--pw-sidebar-width' as string]: `${sidebarCollapsed ? 56 : sidebarWidth}px`,
      }}
    >
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        theme={theme}
        onThemeToggle={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        view={view}
        onViewChange={setView}
        splitSessions={splitSessions}
        onSplitSessionsToggle={toggleSplitSessions}
        onSessionFocus={focusSession}
        onSessionSplit={splitWithSession}
        openTabKeys={visibleTabs.map((tab) => tab.key)}
        onResizePointerDown={startSidebarResize}
        onResizeKeyDown={resizeSidebarWithKeyboard}
      />
      <main className="center">
        {view === 'sessions'
          ? (
              <>
                {visibleTabs.length > 0 ? (
                  <div className={`session-grid${visibleTabs.length > 1 ? ' is-split' : ''}`}>
                    {visibleTabs.map((tab, index) => (
                      <div className="session-pane-slot" key={tab.key}>
                        <section
                          className={`session-pane${tab.key === activeKey ? ' is-active' : ''}`}
                          aria-label={`Session ${tab.label}`}
                          style={paneWidths[tab.key] ? { flexBasis: `${paneWidths[tab.key]}px`, width: `${paneWidths[tab.key]}px` } : undefined}
                          onPointerDownCapture={() => setActiveKey(tab.key)}
                        >
                          <Conversation
                            tab={tab}
                            split={visibleTabs.length > 1}
                            paneIndex={index}
                            paneCount={visibleTabs.length}
                            onClose={visibleTabs.length > 1 ? () => closeConversation(tab.key) : undefined}
                          />
                        </section>
                        {index < visibleTabs.length - 1 && (
                          <button
                            type="button"
                            className="session-resizer"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={`Resize ${tab.label}`}
                            title="Drag to resize session"
                            onPointerDown={(event) => startPaneResize(event, tab.key)}
                            onKeyDown={(event) => resizePaneWithKeyboard(event, tab.key)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : <EmptyCenter />}
              </>
            )
          : view === 'terminal'
            ? <TerminalPage cwd={active?.cwd} theme={theme} />
            : <WorkbenchPage view={view} theme={theme} onThemeChange={setTheme} />}
      </main>
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
            <span className="hero__title">Onwards & Upwards</span>
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

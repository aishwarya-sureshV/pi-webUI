import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import type { WorkbenchView } from '../lib/navigation'
import { formatRelativeTime } from '../lib/time'
import {
  FishLogo,
  IconArchive,
  IconCube,
  IconDots,
  IconExtension,
  IconFolder,
  IconMoon,
  IconNewChat,
  IconPanel,
  IconRestore,
  IconSettings,
  IconSun,
  IconTrash,
} from './icons'

function workspaceLabel(cwd: string): string {
  if (/^\/Users\/[^/]+\/?$/.test(cwd)) return 'Home'
  return cwd.split('/').filter(Boolean).at(-1) || cwd || 'Other'
}

export function Sidebar({
  collapsed,
  onToggle,
  theme,
  onThemeToggle,
  view,
  onViewChange,
}: {
  collapsed: boolean
  onToggle: () => void
  theme: 'light' | 'dark'
  onThemeToggle: () => void
  view: WorkbenchView
  onViewChange: (view: WorkbenchView) => void
}) {
  const [sessionView, setSessionView] = useState<'recent' | 'archived'>('recent')
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null)
  const [openWorkspaceMenu, setOpenWorkspaceMenu] = useState<string | null>(null)
  const [sessionMenuOpensUp, setSessionMenuOpensUp] = useState(false)
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<ReadonlySet<string>>(new Set())
  const initializedWorkspaceGroups = useRef(false)
  const {
    tabs,
    activeKey,
    setActiveKey,
    closeConversation,
    openDefaultConversation,
    openConversation,
    resumeConversation,
    resumeSessions,
    archivedSessions,
    archiveSession,
    restoreSession,
    deleteSession,
  } = useStore()

  const savedSessions = sessionView === 'archived' ? archivedSessions : resumeSessions
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, typeof savedSessions>()
    for (const session of savedSessions.slice(0, 60)) {
      const key = session.cwd || 'Other'
      groups.set(key, [...(groups.get(key) ?? []), session])
    }
    return [...groups.entries()].map(([cwd, sessions]) => ({ cwd, label: workspaceLabel(cwd), sessions }))
  }, [savedSessions])

  useEffect(() => {
    if (initializedWorkspaceGroups.current || workspaceGroups.length === 0) return
    initializedWorkspaceGroups.current = true
    const openWorkspaces = new Set(tabs.map((tab) => tab.cwd))
    setCollapsedWorkspaces(new Set(workspaceGroups.filter((group) => !openWorkspaces.has(group.cwd)).map((group) => group.cwd)))
  }, [tabs, workspaceGroups])

  useEffect(() => {
    if (!openSessionMenu && !openWorkspaceMenu) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.sidebar__floating-menu')) {
        setOpenSessionMenu(null)
        setOpenWorkspaceMenu(null)
      }
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenSessionMenu(null)
        setOpenWorkspaceMenu(null)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openSessionMenu, openWorkspaceMenu])

  const startFresh = (cwd?: string) => {
    onViewChange('sessions')
    if (cwd) openConversation(cwd)
    else void openDefaultConversation()
  }

  const handleArchive = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null)
    const result = await archiveSession(session)
    if (!result.ok) window.alert(result.error ?? 'The session could not be archived.')
  }

  const handleRestore = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null)
    const result = await restoreSession(session)
    if (!result.ok) window.alert(result.error ?? 'The session could not be restored.')
  }

  const handleDelete = async (session: (typeof savedSessions)[number]) => {
    setOpenSessionMenu(null)
    const confirmed = window.confirm(
      `Permanently delete “${session.name}”?\n\nThis removes the saved Pi session and cannot be undone.`,
    )
    if (!confirmed) return
    const result = await deleteSession(session)
    if (!result.ok) window.alert(result.error ?? 'The session could not be deleted.')
  }

  const toggleWorkspace = (cwd: string) => {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }

  const chooseView = (next: WorkbenchView) => {
    onViewChange(next)
    setOpenSessionMenu(null)
    setOpenWorkspaceMenu(null)
  }

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar__brand-row">
        {!collapsed && (
          <button type="button" className="sidebar__brand" onClick={() => startFresh()} aria-label="New session">
            <FishLogo size={25} />
            <span>pi</span>
            <em>WORKBENCH</em>
          </button>
        )}
        <button type="button" className="sidebar__icon-btn sidebar__toggle" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed && <span className="sidebar__rail-fish"><FishLogo size={24} /></span>}
          <span className="sidebar__panel-icon"><IconPanel size={collapsed ? 18 : 16} /></span>
        </button>
      </div>

      <button type="button" className="sidebar__new" onClick={() => startFresh()} aria-label="New session">
        <IconNewChat size={collapsed ? 18 : 15} />
        {!collapsed && <span>New session</span>}
      </button>

      <nav className="sidebar__nav" aria-label="Workbench">
        <SidebarNavButton collapsed={collapsed} active={view === 'sessions'} label="Sessions" onClick={() => chooseView('sessions')} icon={<IconFolder size={18} />} />
        <SidebarNavButton collapsed={collapsed} active={view === 'skills'} label="Skills" onClick={() => chooseView('skills')} icon={<IconCube size={18} />} />
        <SidebarNavButton collapsed={collapsed} active={view === 'extensions'} label="Extensions" onClick={() => chooseView('extensions')} icon={<IconExtension size={18} />} />
        <SidebarNavButton collapsed={collapsed} active={view === 'settings'} label="Settings" onClick={() => chooseView('settings')} icon={<IconSettings size={18} />} />
      </nav>

      {!collapsed && (
        <div className="sidebar__section">
          {tabs.length > 0 && <div className="sidebar__heading">Open</div>}
          {tabs.map((tab) => (
            <div className="sidebar__item-row" key={tab.key}>
              <button
                type="button"
                className={`sidebar__item${tab.key === activeKey && view === 'sessions' ? ' is-active' : ''}`}
                onClick={() => { setActiveKey(tab.key); chooseView('sessions') }}
                title={tab.cwd}
              >
                <span className="sidebar__item-label">{tab.label}</span>
              </button>
              <button type="button" className="sidebar__item-close" aria-label={`Close ${tab.label}`} onClick={() => closeConversation(tab.key)}>×</button>
            </div>
          ))}

          <div className="sidebar__saved-head">
            <span className="sidebar__heading">Sessions</span>
            <div className="sidebar__saved-switch" aria-label="Saved session view">
              <button type="button" className={sessionView === 'recent' ? 'is-active' : ''} aria-pressed={sessionView === 'recent'} onClick={() => { setSessionView('recent'); setOpenSessionMenu(null) }}>Recent</button>
              <button type="button" className={sessionView === 'archived' ? 'is-active' : ''} aria-pressed={sessionView === 'archived'} onClick={() => { setSessionView('archived'); setOpenSessionMenu(null) }}>Archived</button>
            </div>
          </div>

          {workspaceGroups.map((group) => {
            const groupCollapsed = collapsedWorkspaces.has(group.cwd)
            return (
              <section className="sidebar__workspace" key={group.cwd}>
                <div className="sidebar__workspace-head">
                  <button type="button" className="sidebar__workspace-toggle" aria-expanded={!groupCollapsed} onClick={() => toggleWorkspace(group.cwd)} title={group.cwd}>
                    <span className={`sidebar__workspace-chevron${groupCollapsed ? ' is-collapsed' : ''}`}>⌄</span>
                    <IconFolder size={15} />
                    <span>{group.label}</span>
                    <em>{group.sessions.length}</em>
                  </button>
                  <div className="sidebar__workspace-menu sidebar__floating-menu">
                    <button
                      type="button"
                      className="sidebar__workspace-actions"
                      aria-label={`Actions for workspace ${group.label}`}
                      aria-expanded={openWorkspaceMenu === group.cwd}
                      onClick={(event) => {
                        event.stopPropagation()
                        setOpenSessionMenu(null)
                        setOpenWorkspaceMenu((current) => current === group.cwd ? null : group.cwd)
                      }}
                    ><IconDots /></button>
                    {openWorkspaceMenu === group.cwd && (
                      <div className="sidebar__session-popover sidebar__workspace-popover">
                        <button type="button" onClick={() => { setOpenWorkspaceMenu(null); startFresh(group.cwd) }}><IconNewChat /> New session here</button>
                        <button type="button" onClick={() => { setOpenWorkspaceMenu(null); toggleWorkspace(group.cwd) }}><IconFolder /> {groupCollapsed ? 'Expand workspace' : 'Collapse workspace'}</button>
                      </div>
                    )}
                  </div>
                </div>

                {!groupCollapsed && group.sessions.map((session) => {
                  const isOpen = tabs.some((tab) => tab.sessionPath === session.path || tab.timeline.state?.sessionFile === session.path)
                  return (
                    <div className="sidebar__saved-row" key={session.path}>
                      <button
                        type="button"
                        className={`sidebar__item${isOpen ? ' is-active-session' : ''}`}
                        title={session.path}
                        onClick={() => { resumeConversation(session); chooseView('sessions') }}
                      >
                        <span className="sidebar__item-label">{session.name}</span>
                        <span className="sidebar__item-meta">{formatRelativeTime(session.modifiedAt)}</span>
                      </button>
                      <div className="sidebar__session-menu sidebar__floating-menu">
                        <button
                          type="button"
                          className="sidebar__session-trigger"
                          aria-label={`Actions for ${session.name}`}
                          aria-expanded={openSessionMenu === session.path}
                          onClick={(event) => {
                            event.stopPropagation()
                            const rect = event.currentTarget.getBoundingClientRect()
                            setSessionMenuOpensUp(window.innerHeight - rect.bottom < 116)
                            setOpenWorkspaceMenu(null)
                            setOpenSessionMenu((current) => current === session.path ? null : session.path)
                          }}
                        ><IconDots /></button>
                        {openSessionMenu === session.path && (
                          <div className={`sidebar__session-popover${sessionMenuOpensUp ? ' is-upwards' : ''}`}>
                            {sessionView === 'recent'
                              ? <button type="button" onClick={() => void handleArchive(session)}><IconArchive /> Archive</button>
                              : <button type="button" onClick={() => void handleRestore(session)}><IconRestore /> Restore</button>}
                            <button type="button" className="is-danger" onClick={() => void handleDelete(session)}><IconTrash /> Delete permanently</button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </section>
            )
          })}

          {savedSessions.length === 0 && <div className="sidebar__empty">{sessionView === 'archived' ? 'No archived sessions.' : 'No saved sessions yet.'}</div>}
        </div>
      )}

      <button type="button" className="sidebar__footer" onClick={onThemeToggle} aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}>
        {theme === 'dark' ? <IconSun /> : <IconMoon />}
        {!collapsed && <span>{theme === 'dark' ? 'Light appearance' : 'Dark appearance'}</span>}
      </button>
    </aside>
  )
}

function SidebarNavButton({
  collapsed,
  active,
  label,
  icon,
  onClick,
}: {
  collapsed: boolean
  active: boolean
  label: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" className={`sidebar__nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} aria-label={label} onClick={onClick}>
      {icon}
      {!collapsed && <span>{label}</span>}
    </button>
  )
}

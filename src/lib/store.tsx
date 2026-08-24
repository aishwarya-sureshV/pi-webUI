/**
 * App state: manages open conversation tabs, each bound to a Timeline that
 * consumes the shared SSE event stream keyed by sessionKey.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  api,
  subscribeEvents,
  type AgentEvent,
  type ResumeSession,
  type SessionMutationResponse,
} from './api'
import { Timeline, type TimelineItem } from './timeline'

export interface ConversationTab {
  key: string
  label: string
  cwd: string
  sessionPath?: string
  timeline: Timeline
}

interface StoreValue {
  tabs: ConversationTab[]
  activeKey: string
  active: ConversationTab | undefined
  resumeSessions: ResumeSession[]
  archivedSessions: ResumeSession[]
  detailsOpen: boolean
  openConversation: (cwd: string, label?: string) => string
  openDefaultConversation: () => Promise<string>
  resumeConversation: (session: ResumeSession) => string
  closeConversation: (key: string) => void
  setActiveKey: (key: string) => void
  setConversationSessionPath: (key: string, path?: string) => void
  setConversationWorkspace: (key: string, cwd: string) => void
  archiveSession: (session: ResumeSession) => Promise<SessionMutationResponse>
  restoreSession: (session: ResumeSession) => Promise<SessionMutationResponse>
  deleteSession: (session: ResumeSession) => Promise<SessionMutationResponse>
  toggleDetails: () => void
  refreshSessions: () => void
}

const StoreContext = createContext<StoreValue | null>(null)
const timelines = new Map<string, Timeline>()
const pageSessionId = crypto.randomUUID()
let counter = 1

function timelineFor(key: string): Timeline {
  let timeline = timelines.get(key)
  if (!timeline) {
    timeline = new Timeline(key)
    timelines.set(key, timeline)
  }
  return timeline
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<ConversationTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [resumeSessions, setResumeSessions] = useState<ResumeSession[]>([])
  const [archivedSessions, setArchivedSessions] = useState<ResumeSession[]>([])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const defaultCwd = useRef('')
  const didOpenInitialSession = useRef(false)
  const tabsRef = useRef<ConversationTab[]>([])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    const stopPageSessions = () => {
      for (const tab of tabsRef.current) {
        navigator.sendBeacon(`/api/${encodeURIComponent(tab.key)}/stop`, '{}')
      }
    }
    window.addEventListener('pagehide', stopPageSessions)
    return () => window.removeEventListener('pagehide', stopPageSessions)
  }, [])

  const refreshSessions = useCallback(() => {
    void Promise.all([api.sessions('recent'), api.sessions('archived')]).then(([recent, archived]) => {
      if (recent.ok) setResumeSessions(recent.sessions)
      if (archived.ok) setArchivedSessions(archived.sessions)
    })
  }, [])

  useEffect(() => {
    refreshSessions()
    const unsubscribe = subscribeEvents((event: AgentEvent) => {
      const key = event.sessionKey
      if (!key) return
      timelines.get(key)?.handle(event)
      if (event.type === 'agent_settled') refreshSessions()
    })
    return unsubscribe
  }, [refreshSessions])

  const createConversationTab = useCallback((cwd: string, label?: string, sessionPath?: string): ConversationTab => {
    // Include a page-scoped UUID so separate browser windows never bind to the
    // same Pi RPC process (each page's local counter otherwise starts at 1).
    const key = `conv-${pageSessionId}-${counter++}`
    const tab: ConversationTab = {
      key,
      label: label ?? cwd.split('/').filter(Boolean).at(-1) ?? cwd,
      cwd,
      sessionPath,
      timeline: timelineFor(key),
    }
    setTabs((current) => [...current, tab])
    setActiveKey(key)
    return tab
  }, [])

  const openConversation = useCallback((cwd: string, label?: string): string => {
    const tab = createConversationTab(cwd, label)
    void api.start(tab.key, cwd).then((result) => {
      if (result.ok && result.state) tab.timeline.setState(result.state)
      else if (!result.ok) tab.timeline.appendNotice(result.error ?? 'Pi could not be started', 'error')
    })
    return tab.key
  }, [createConversationTab])

  const openDefaultConversation = useCallback(async (): Promise<string> => {
    let cwd = defaultCwd.current
    if (!cwd) {
      const requestedCwd = new URLSearchParams(window.location.search).get('cwd')?.trim()
      if (requestedCwd) {
        cwd = requestedCwd
      } else {
        const result = await api.health()
        cwd = result.cwd || '.'
      }
      defaultCwd.current = cwd
    }
    return openConversation(cwd)
  }, [openConversation])

  useEffect(() => {
    if (didOpenInitialSession.current) return
    didOpenInitialSession.current = true
    void openDefaultConversation()
  }, [openDefaultConversation])

  const resumeConversation = useCallback((session: ResumeSession): string => {
    const existing = tabs.find(
      (tab) => tab.sessionPath === session.path || tab.timeline.state?.sessionFile === session.path,
    )
    if (existing) {
      setActiveKey(existing.key)
      return existing.key
    }

    const tab = createConversationTab(session.cwd, session.name, session.path)
    const timeline = tab.timeline
    timeline.appendNotice('Loading previous session…', 'info')
    void api.start(tab.key, session.cwd).then(async (startResult) => {
      if (!startResult.ok) {
        timeline.reset(null)
        timeline.appendNotice(startResult.error ?? 'Pi could not be started', 'error')
        return
      }
      const result = await api.resume(tab.key, session.path)
      if (result.ok && result.state && Array.isArray(result.messages)) {
        timeline.hydrate(result.messages, result.state)
        setTabs((current) => current.map((candidate) =>
          candidate.key === tab.key
            ? { ...candidate, sessionPath: result.state?.sessionFile ?? session.path }
            : candidate,
        ))
        refreshSessions()
      } else {
        timeline.reset(startResult.state ?? null)
        timeline.appendNotice(result.error ?? 'Could not resume the Pi session', 'error')
      }
    })
    return tab.key
  }, [createConversationTab, refreshSessions, tabs])

  const closeConversation = useCallback((key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key)
      setActiveKey((active) => (active === key ? (next.at(-1)?.key ?? '') : active))
      return next
    })
    timelines.delete(key)
    void api.stop(key)
  }, [])

  const archiveSession = useCallback(async (session: ResumeSession): Promise<SessionMutationResponse> => {
    const result = await api.archiveSession(session.path)
    if (result.ok) refreshSessions()
    return result
  }, [refreshSessions])

  const restoreSession = useCallback(async (session: ResumeSession): Promise<SessionMutationResponse> => {
    const result = await api.restoreSession(session.path)
    if (result.ok) refreshSessions()
    return result
  }, [refreshSessions])

  const deleteSession = useCallback(async (session: ResumeSession): Promise<SessionMutationResponse> => {
    const matchingTabs = tabs.filter(
      (tab) => tab.sessionPath === session.path || tab.timeline.state?.sessionFile === session.path,
    )
    await Promise.all(matchingTabs.map((tab) => api.stop(tab.key)))
    const result = await api.deleteSession(session.path)
    if (!result.ok) return result

    const removedKeys = new Set(matchingTabs.map((tab) => tab.key))
    setTabs((current) => {
      const next = current.filter((tab) => !removedKeys.has(tab.key))
      setActiveKey((currentActive) => removedKeys.has(currentActive) ? (next.at(-1)?.key ?? '') : currentActive)
      return next
    })
    for (const tab of matchingTabs) timelines.delete(tab.key)
    refreshSessions()
    return result
  }, [refreshSessions, tabs])

  const active = useMemo(() => tabs.find((tab) => tab.key === activeKey), [tabs, activeKey])

  const setConversationSessionPath = useCallback((key: string, path?: string) => {
    setTabs((current) => current.map((tab) =>
      tab.key === key && (tab.sessionPath !== path || path === undefined)
        ? {
            ...tab,
            sessionPath: path,
            ...(path === undefined
              ? { label: tab.cwd.split('/').filter(Boolean).at(-1) ?? tab.cwd }
              : {}),
          }
        : tab,
    ))
  }, [])

  const setConversationWorkspace = useCallback((key: string, cwd: string) => {
    setTabs((current) => current.map((tab) =>
      tab.key === key
        ? {
            ...tab,
            cwd,
            label: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
            sessionPath: undefined,
          }
        : tab,
    ))
  }, [])

  const value: StoreValue = {
    tabs,
    activeKey,
    active,
    resumeSessions,
    archivedSessions,
    detailsOpen,
    openConversation,
    openDefaultConversation,
    resumeConversation,
    closeConversation,
    setActiveKey,
    setConversationSessionPath,
    setConversationWorkspace,
    archiveSession,
    restoreSession,
    deleteSession,
    toggleDetails: () => setDetailsOpen((open) => !open),
    refreshSessions,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used under StoreProvider')
  return ctx
}

/** Re-render the calling component whenever the timeline changes. */
export function useTimeline(timeline: Timeline | undefined) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!timeline) return
    return timeline.subscribe(() => setTick((t) => t + 1))
  }, [timeline])
  return timeline
}

export type { TimelineItem }

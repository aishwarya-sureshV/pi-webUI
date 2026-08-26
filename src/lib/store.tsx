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
  type AgentBackend,
  type ModelInfo,
  type ResumeSession,
  type SessionMutationResponse,
} from './api'
import { Timeline, type TimelineItem } from './timeline'
import { savedSessionTitle } from './sessionTitle'
import { CLAUDE_DEFAULT_EFFORT, CLAUDE_DEFAULT_MODEL, claudeModelInfo } from './claudeModels'

export interface ConversationTab {
  key: string
  label: string
  cwd: string
  sessionPath?: string
  backend: AgentBackend
  /** Created from New session (as opposed to opening saved history). */
  isFresh: boolean
  timeline: Timeline
}

interface StoreValue {
  tabs: ConversationTab[]
  activeKey: string
  active: ConversationTab | undefined
  resumeSessions: ResumeSession[]
  archivedSessions: ResumeSession[]
  openConversation: (cwd: string, label?: string, backend?: AgentBackend) => string
  openDefaultConversation: () => Promise<string>
  resumeConversation: (session: ResumeSession) => string
  closeConversation: (key: string) => void
  setActiveKey: (key: string) => void
  setConversationSessionPath: (key: string, path?: string) => void
  setConversationLabel: (key: string, label: string) => void
  setConversationWorkspace: (key: string, cwd: string) => void
  archiveSession: (session: ResumeSession) => Promise<SessionMutationResponse>
  restoreSession: (session: ResumeSession) => Promise<SessionMutationResponse>
  deleteSession: (session: ResumeSession) => Promise<SessionMutationResponse>
  refreshSessions: () => void
  setPreferredModel: (backend: AgentBackend, cwd: string, model: ModelInfo | null) => void
}

const StoreContext = createContext<StoreValue | null>(null)
const timelines = new Map<string, Timeline>()
const pageSessionId = crypto.randomUUID()
let counter = 1

interface PersistedOpenSession {
  cwd: string
  label: string
  backend: AgentBackend
  sessionPath?: string
  model?: ModelInfo | null
  thinkingLevel?: string
  active?: boolean
}

function openSessionsStorageKey(backend: AgentBackend): string {
  return `pi-web.open-sessions.v1.${backend}`
}

function readOpenSessions(backend: AgentBackend): PersistedOpenSession[] {
  try {
    const value = JSON.parse(localStorage.getItem(openSessionsStorageKey(backend)) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is PersistedOpenSession =>
      entry
      && typeof entry === 'object'
      && typeof entry.cwd === 'string'
      && typeof entry.label === 'string'
      && entry.backend === backend,
    )
  } catch {
    return []
  }
}

function modelPreferenceKey(backend: AgentBackend, cwd: string): string {
  return `${backend}:${cwd}`
}

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
  const defaultCwd = useRef('')
  const defaultBackend = useRef<AgentBackend>(
    new URLSearchParams(window.location.search).get('backend') === 'claude' ? 'claude' : 'pi',
  )
  const didOpenInitialSession = useRef(false)
  const didRenderRestoredSessions = useRef(false)
  const tabsRef = useRef<ConversationTab[]>([])
  const preferredModels = useRef(new Map<string, ModelInfo>())
  const persistedOpenSessions = useRef(readOpenSessions(defaultBackend.current))

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
    void Promise.all([
      api.sessions('recent', defaultBackend.current),
      api.sessions('archived', defaultBackend.current),
    ]).then(([recent, archived]) => {
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

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshSessions()
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 30_000)
    return () => {
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(timer)
    }
  }, [refreshSessions])

  const createConversationTab = useCallback((cwd: string, label?: string, sessionPath?: string, backend = defaultBackend.current): ConversationTab => {
    // Include a page-scoped UUID so separate browser windows never bind to the
    // same Pi RPC process (each page's local counter otherwise starts at 1).
    const key = `conv-${pageSessionId}-${counter++}`
    const tab: ConversationTab = {
      key,
      label: label ?? cwd.split('/').filter(Boolean).at(-1) ?? cwd,
      cwd,
      sessionPath,
      backend,
      isFresh: sessionPath === undefined,
      timeline: timelineFor(key),
    }
    // Keep the ref in sync immediately. This prevents two quick clicks on
    // "New session" from racing the React state update and creating twins.
    tabsRef.current = [...tabsRef.current, tab]
    setTabs(tabsRef.current)
    setActiveKey(key)
    return tab
  }, [])

  const openConversation = useCallback((cwd: string, label?: string, backend = defaultBackend.current): string => {
    const freshTab = tabsRef.current.find((candidate) =>
      candidate.backend === backend
      && candidate.cwd === cwd
      && candidate.isFresh
      && !candidate.timeline.items.some((item) =>
        item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool',
      ),
    )
    if (freshTab) {
      setActiveKey(freshTab.key)
      return freshTab.key
    }
    const tab = createConversationTab(cwd, label, undefined, backend)
    const preferredModel = backend === 'claude'
      ? CLAUDE_DEFAULT_MODEL
      : preferredModels.current.get(modelPreferenceKey(backend, cwd))
    if (backend === 'claude') {
      tab.timeline.setState({
        model: CLAUDE_DEFAULT_MODEL,
        thinkingLevel: CLAUDE_DEFAULT_EFFORT,
        isStreaming: false,
        sessionId: '',
        messageCount: 0,
        pendingMessageCount: 0,
      })
    }
    void api.start(tab.key, cwd, backend, preferredModel, undefined, backend === 'claude' ? CLAUDE_DEFAULT_EFFORT : undefined).then((result) => {
      if (result.ok && result.state) tab.timeline.setState(result.state)
      else if (!result.ok) tab.timeline.appendNotice(result.error ?? `${backend === 'claude' ? 'Claude' : 'Pi'} could not be started`, 'error')
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

  const resumeConversation = useCallback((session: ResumeSession): string => {
    const existing = tabsRef.current.find(
      (tab) => tab.sessionPath === session.path || tab.timeline.state?.sessionFile === session.path,
    )
    if (existing) {
      setActiveKey(existing.key)
      return existing.key
    }

    const tab = createConversationTab(
      session.cwd,
      savedSessionTitle(session.name, session.firstPrompt),
      session.path,
      session.backend ?? 'pi',
    )
    const timeline = tab.timeline
    const restoredModel = tab.backend === 'claude' && session.lastModel
      ? claudeModelInfo(session.lastModel)
      : undefined
    const placeholderState = {
      model: restoredModel ?? null,
      thinkingLevel: session.lastEffort || (tab.backend === 'claude' ? CLAUDE_DEFAULT_EFFORT : 'off'),
      isStreaming: false,
      sessionId: '',
      sessionFile: session.path,
      messageCount: 0,
      pendingMessageCount: 0,
    }
    timeline.setState(placeholderState)
    void api.sessionMessages(session.path).then((result) => {
      if (!result.ok || !Array.isArray(result.messages) || result.messages.length === 0) return
      timeline.hydrate(result.messages, { ...(timeline.state ?? placeholderState), isStreaming: false })
    })
    void api.start(
      tab.key,
      session.cwd,
      tab.backend,
      restoredModel ?? undefined,
      session.path,
      tab.backend === 'claude' ? session.lastEffort : undefined,
    ).then(async (startResult) => {
      if (!startResult.ok) {
        timeline.appendNotice(startResult.error ?? `${tab.backend === 'claude' ? 'Claude' : 'Pi'} could not be started`, 'error')
        return
      }
      if (startResult.state) {
        const resumedState = startResult.state.isStreaming
          ? { ...startResult.state, isStreaming: false }
          : startResult.state
        if (Array.isArray(startResult.messages) && startResult.messages.length > 0) {
          timeline.hydrate(startResult.messages, resumedState)
        } else {
          timeline.setState(resumedState)
        }
        setTabs((current) => current.map((candidate) =>
          candidate.key === tab.key
            ? { ...candidate, sessionPath: startResult.state?.sessionFile ?? session.path }
            : candidate,
        ))
        refreshSessions()
        if (timeline.items.length > 0) return
      }
      const result = await api.resume(tab.key, session.path)
      if (result.ok && result.state && Array.isArray(result.messages)) {
        const resumedState = result.state.isStreaming
          ? { ...result.state, isStreaming: false }
          : result.state
        if (result.state.isStreaming) {
          try { await api.abort(tab.key) } catch { /* resume should still render the saved transcript */ }
        }
        timeline.hydrate(result.messages, resumedState)
        setTabs((current) => current.map((candidate) =>
          candidate.key === tab.key
            ? { ...candidate, sessionPath: result.state?.sessionFile ?? session.path }
            : candidate,
        ))
        refreshSessions()
      } else {
        timeline.reset(startResult.state ?? null)
        timeline.appendNotice(result.error ?? `Could not resume the ${tab.backend === 'claude' ? 'Claude' : 'Pi'} session`, 'error')
        void api.stop(tab.key)
      }
    }).catch((error) => {
      timeline.reset(null)
      timeline.appendNotice(`Could not resume the ${tab.backend === 'claude' ? 'Claude' : 'Pi'} session: ${String(error?.message ?? error)}`, 'error')
      void api.stop(tab.key)
    })
    return tab.key
  }, [createConversationTab, refreshSessions])

  useEffect(() => {
    if (didOpenInitialSession.current) return
    didOpenInitialSession.current = true

    const stored = persistedOpenSessions.current
    const split = localStorage.getItem('pi-web.session-layout') === 'split'
    const sessionsToRestore = split
      ? stored
      : [stored.find((session) => session.active) ?? stored.at(-1)].filter(Boolean) as PersistedOpenSession[]
    if (sessionsToRestore.length === 0) {
      void openDefaultConversation()
      return
    }

    let activeRestoredKey = ''
    for (const session of sessionsToRestore) {
      const key = session.sessionPath
        ? resumeConversation({
            path: session.sessionPath,
            name: session.label,
            cwd: session.cwd,
            createdAt: 0,
            modifiedAt: 0,
            messageCount: 0,
            backend: session.backend,
            lastModel: session.model?.id,
            lastEffort: session.thinkingLevel,
          })
        : openConversation(session.cwd, session.label, session.backend)
      if (session.active) activeRestoredKey = key
    }
    if (activeRestoredKey) setActiveKey(activeRestoredKey)
  }, [openConversation, openDefaultConversation, resumeConversation])

  useEffect(() => {
    if (!didOpenInitialSession.current) return
    // Do not let the provider's first empty render erase the snapshot that the
    // restoration effect above still needs to consume.
    if (!didRenderRestoredSessions.current) {
      if (tabs.length === 0) return
      didRenderRestoredSessions.current = true
    }
    const snapshot: PersistedOpenSession[] = tabs.map((tab) => ({
      cwd: tab.cwd,
      label: tab.label,
      backend: tab.backend,
      sessionPath: tab.sessionPath ?? tab.timeline.state?.sessionFile,
      model: tab.timeline.state?.model,
      thinkingLevel: tab.timeline.state?.thinkingLevel,
      active: tab.key === activeKey,
    }))
    localStorage.setItem(openSessionsStorageKey(defaultBackend.current), JSON.stringify(snapshot))
  }, [activeKey, tabs])

  const closeConversation = useCallback((key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key)
      tabsRef.current = next
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

  const setConversationLabel = useCallback((key: string, label: string) => {
    setTabs((current) => current.map((tab) => tab.key === key && tab.label !== label ? { ...tab, label } : tab))
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

  const setPreferredModel = useCallback((backend: AgentBackend, cwd: string, model: ModelInfo | null) => {
    const key = modelPreferenceKey(backend, cwd)
    if (model) preferredModels.current.set(key, model)
    else preferredModels.current.delete(key)
  }, [])

  const value: StoreValue = {
    tabs,
    activeKey,
    active,
    resumeSessions,
    archivedSessions,
    openConversation,
    openDefaultConversation,
    resumeConversation,
    closeConversation,
    setActiveKey,
    setConversationSessionPath,
    setConversationLabel,
    setConversationWorkspace,
    archiveSession,
    restoreSession,
    deleteSession,
    refreshSessions,
    setPreferredModel,
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

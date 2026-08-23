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
} from './api'
import { Timeline, type TimelineItem } from './timeline'

export interface ConversationTab {
  key: string
  label: string
  cwd: string
  timeline: Timeline
}

interface StoreValue {
  tabs: ConversationTab[]
  activeKey: string
  active: ConversationTab | undefined
  resumeSessions: ResumeSession[]
  detailsOpen: boolean
  openConversation: (cwd: string, label?: string) => string
  closeConversation: (key: string) => void
  setActiveKey: (key: string) => void
  toggleDetails: () => void
  refreshSessions: () => void
}

const StoreContext = createContext<StoreValue | null>(null)
const timelines = new Map<string, Timeline>()
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
  const [detailsOpen, setDetailsOpen] = useState(false)

  const refreshSessions = useCallback(() => {
    void api.sessions().then((result) => {
      if (result.ok) setResumeSessions(result.sessions)
    })
  }, [])

  useEffect(() => {
    refreshSessions()
    const unsubscribe = subscribeEvents((event: AgentEvent) => {
      const key = event.sessionKey
      if (!key) return
      timelines.get(key)?.handle(event)
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openConversation = useCallback((cwd: string, label?: string): string => {
    const key = `conv-${counter++}`
    const tab: ConversationTab = {
      key,
      label: label ?? cwd.split('/').filter(Boolean).at(-1) ?? cwd,
      cwd,
      timeline: timelineFor(key),
    }
    setTabs((current) => [...current, tab])
    setActiveKey(key)
    void api.start(key, cwd)
    return key
  }, [])

  const closeConversation = useCallback((key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key)
      setActiveKey((active) => (active === key ? (next.at(-1)?.key ?? '') : active))
      return next
    })
    timelines.delete(key)
  }, [])

  const active = useMemo(() => tabs.find((tab) => tab.key === activeKey), [tabs, activeKey])

  const value: StoreValue = {
    tabs,
    activeKey,
    active,
    resumeSessions,
    detailsOpen,
    openConversation,
    closeConversation,
    setActiveKey,
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

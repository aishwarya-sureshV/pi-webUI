import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { api, type ModelInfo, type SlashCommand } from '../lib/api'
import { useStore, useTimeline, type ConversationTab } from '../lib/store'
import { Timeline } from '../lib/timeline'
import type { TimelineItem } from '../lib/timeline'
import { ToolCard } from './ToolCard'
import { RichText } from './RichText'
import type { ToolFileView } from '../lib/toolCards'
import { FileViewer } from './FileViewer'

export function Conversation({ tab }: { tab: ConversationTab }) {
  const timeline = useTimeline(tab.timeline)!
  const { toggleDetails, refreshSessions } = useStore()
  const [draft, setDraft] = useState('')
  const [viewer, setViewer] = useState<ToolFileView | null>(null)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [levels, setLevels] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const state = timeline.state
  const status = timeline.status
  const streaming = status === 'working' || state?.isStreaming === true

  useEffect(() => {
    void api.commands(tab.key).then((r) => r.ok && setCommands(r.commands))
    void api.models(tab.key).then((r) => r.ok && setModels(r.models))
    void api.thinkingLevels(tab.key).then((r) => r.ok && setLevels(r.levels))
  }, [tab.key])

  useLayoutEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  })

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim()
      if (!message) return

      // Local slash handling for a couple of pane-level verbs; everything else
      // goes through pi's own slash dispatch as a prompt.
      if (message === '/new' || message === '/clear') {
        await api.newSession(tab.key)
        refreshSessions()
        setDraft('')
        setSlashOpen(false)
        return
      }
      if (message === '/compact') {
        await api.compact(tab.key)
        setDraft('')
        setSlashOpen(false)
        return
      }

      timeline.appendUser(message)
      setDraft('')
      setSlashOpen(false)
      stickToBottom.current = true
      const result = await api.prompt(tab.key, message)
      if (!result.ok) timeline.appendNotice(result.error ?? 'prompt failed', 'error')
    },
    [tab.key, timeline, refreshSessions],
  )

  const slashFilter = draft.startsWith('/') ? draft.slice(1).toLowerCase() : null
  const slashMatches =
    slashFilter !== null
      ? commands.filter((c) => c.name.toLowerCase().startsWith(slashFilter)).slice(0, 8)
      : []

  useEffect(() => {
    setSlashOpen(slashMatches.length > 0)
    setSlashIndex(0)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slashMatches.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
      if (event.key === 'Tab' || (event.key === 'Enter' && slashMatches[slashIndex])) {
        event.preventDefault()
        const picked = slashMatches[slashIndex]
        setDraft(`/${picked.name} `)
        setSlashOpen(false)
        return
      }
      if (event.key === 'Escape') { setSlashOpen(false); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  const autoGrow = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const modelLabel = state?.model?.name ?? state?.model?.id ?? 'model…'
  const hasItems = timeline.items.length > 0

  return (
    <>
      <div className="header">
        <div className="header__title">{state?.sessionName || tab.label}</div>
        <div className="header__meta">{modelLabel}</div>
        <div className="header__meta">{status}</div>
        <button
          type="button"
          onClick={toggleDetails}
          style={{
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            padding: '4px 10px',
            fontSize: 12,
          }}
        >
          Details
        </button>
        {streaming && (
          <div className="activity-line" aria-hidden="true" />
        )}
      </div>

      <div className="conversation">
        <div className="conversation__scroll" ref={scrollRef} onScroll={onScroll}>
          {hasItems ? (
            <div className="conversation__column">
              {timeline.items.map((item) => (
                <TimelineRow key={item.id} item={item} onOpenFile={setViewer} />
              ))}
              {streaming && <ThinkingRow />}
            </div>
          ) : (
            <div className="hero">
              <div className="hero__mark">π</div>
              <div className="hero__title">What should we work on?</div>
              <div className="hero__subtitle">
                Messages stream in as cards: reasoning summaries up top, then tool calls with
                diffs, then the final answer.
              </div>
            </div>
          )}
        </div>

        <div className="composer" style={{ position: 'relative' }}>
          {slashOpen && slashMatches.length > 0 && (
            <div className="slash-menu">
              {slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  className={`slash-menu__item${index === slashIndex ? ' is-active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); setDraft(`/${command.name} `); setSlashOpen(false); textareaRef.current?.focus() }}
                >
                  <code>/{command.name}</code>
                  <span>{command.description ?? ''}</span>
                </button>
              ))}
            </div>
          )}
          <form
            className="composer__card"
            onSubmit={(e: FormEvent) => { e.preventDefault(); void send(draft) }}
          >
            <textarea
              ref={textareaRef}
              className="composer__textarea"
              rows={1}
              placeholder="Message pi…  ( / for commands, Enter to send, Shift+Enter for newline )"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); autoGrow() }}
              onKeyDown={onKeyDown}
            />
            <div className="composer__bar">
              <span className="composer__hint">{tab.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
              {models.length > 0 && state?.model && (
                <select
                  className="composer__select"
                  value={`${state.model.provider}/${state.model.id}`}
                  onChange={(e) => {
                    const [provider, ...rest] = e.target.value.split('/')
                    void api.setModel(tab.key, provider, rest.join('/'))
                  }}
                >
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name ?? m.id}
                    </option>
                  ))}
                </select>
              )}
              {levels.length > 0 && (
                <select
                  className="composer__select"
                  value={state?.thinkingLevel ?? 'off'}
                  onChange={(e) => void api.setThinking(tab.key, e.target.value)}
                >
                  {levels.map((level) => (
                    <option key={level} value={level}>think: {level}</option>
                  ))}
                </select>
              )}
              {streaming ? (
                <button type="button" className="composer__stop" onClick={() => void api.abort(tab.key)}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="composer__send" disabled={!draft.trim()}>
                  Send
                </button>
              )}
            </div>
          </form>
        </div>
      </div>

      {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
    </>
  )
}

function ThinkingRow() {
  return (
    <div className="thinking" aria-label="pi is thinking">
      <span className="thinking__spinner" />
      <span>pi is thinking</span>
      <span className="thinking__dots" aria-hidden="true" />
    </div>
  )
}

function TimelineRow({ item, onOpenFile }: { item: TimelineItem; onOpenFile: (view: ToolFileView) => void }) {
  if (item.kind === 'tool') return <ToolCard item={item} onOpenFile={onOpenFile} />

  if (item.kind === 'notice') {
    return <div className={`notice notice--${item.tone}`}>{item.text}</div>
  }

  if (item.kind === 'user') {
    return (
      <article className="tl tl--user">
        <span className="tl__node" />
        <div className="user-msg">{item.text}</div>
      </article>
    )
  }

  return (
    <article className={`tl tl--${item.kind}`}>
      <span className={`tl__node${item.live ? ' is-live' : ''}`} />
      {item.kind === 'rationale' && <div className="tl__eyebrow">reasoning summary</div>}
      <div className={item.kind === 'rationale' ? 'rationale-text' : undefined}>
        <RichText text={item.text} live={item.live} />
      </div>
    </article>
  )
}

export type { Timeline }

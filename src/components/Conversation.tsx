import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { api, subscribeEvents, type ModelInfo, type ProviderUsage, type SlashCommand } from '../lib/api'
import { useStore, useTimeline, type ConversationTab } from '../lib/store'
import { contextualSessionTitle, isLocalCommandText } from '../lib/sessionTitle'
import { CLAUDE_DEFAULT_EFFORT, CLAUDE_DEFAULT_MODEL, CLAUDE_EFFORT_LEVELS, CLAUDE_MODELS, formatClaudeModelName } from '../lib/claudeModels'
import { estimateContext } from '../lib/sessionMetrics'
import type { TimelineItem } from '../lib/timeline'
import { ToolCard } from './ToolCard'
import { RichText } from './RichText'
import type { ToolFileView } from '../lib/toolCards'
import { FileViewer } from './FileViewer'
import { Trajectory } from './Trajectory'
import { BackendLog } from './BackendLog'
import { WorkspacePicker } from './WorkspacePicker'
import { CopyButton } from './CopyButton'
import { TodoTracker, TodoTranscript, extractTodos } from './TodoTracker'
import { UsageSummary } from './UsageDisplay'
import {
  ActiveRunIndicator,
  ToolActivitySummary,
  ToolDetailsRail,
  type ToolGroup,
} from './ToolActivity'
import {
  IconArrowUp,
  IconChevronDown,
  IconCommand,
  IconCube,
  IconDownload,
  IconFile,
  IconFork,
  IconPlus,
  IconStop,
  IconUpload,
  FishLogo,
} from './icons'

type ModelOption = { provider: string; id: string; label: string }
type AccessMode = 'workspace-write' | 'read-only'
type AgentMode = 'standard' | 'plan'
const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000 + 30_000
type Attachment = {
  id: string
  name: string
  mimeType: string
  size: number
  path: string
  imageData?: string
}

function isModelIdentityQuestion(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim()
  return (
    /\bwhat\b.{0,48}\b(?:model|provider|version)\b/.test(normalized)
    || /\b(?:model|provider|version)\b.{0,48}\b(?:you|u|running)\b/.test(normalized)
  )
}

function isUsageShortcut(value: string): boolean {
  return /^\/(?:grok-cli-usage|grok-usage)$/i.test(value.trim())
}

function runtimeModelAnswer(model: ModelInfo): string {
  const label = model.name || model.id
  return `This session is running ${label} (${model.provider}/${model.id}), as reported by the backend.`
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.onload = () => resolve(String(reader.result ?? '').split(',', 2)[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export function Conversation({
  tab,
  split = false,
  paneIndex = 0,
  paneCount = 1,
  onClose,
}: {
  tab: ConversationTab
  split?: boolean
  paneIndex?: number
  paneCount?: number
  onClose?: () => void
}) {
  const timeline = useTimeline(tab.timeline)!
  const {
    refreshSessions,
    setConversationSessionPath,
    setConversationWorkspace,
    setPreferredModel,
    setConversationLabel,
  } = useStore()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [viewer, setViewer] = useState<ToolFileView | null>(null)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [models, setModels] = useState<ModelInfo[]>(() => tab.backend === 'claude' ? CLAUDE_MODELS : [])
  const [levels, setLevels] = useState<string[]>(() => tab.backend === 'claude' ? CLAUDE_EFFORT_LEVELS : [])
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [accessMode, setAccessMode] = useState<AccessMode>('workspace-write')
  const [agentMode, setAgentMode] = useState<AgentMode>('standard')
  const [toolRail, setToolRail] = useState<ToolGroup | null>(null)
  const [forkingId, setForkingId] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [conversationView, setConversationView] = useState<'chat' | 'trajectory' | 'backend'>('chat')
  const [providerUsage, setProviderUsage] = useState<ProviderUsage | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const addDetailsRef = useRef<HTMLDetailsElement | null>(null)
  const usageRequestRef = useRef<Promise<boolean> | null>(null)
  const usageRefreshPendingRef = useRef(false)
  const commandRequestRef = useRef<Promise<void> | null>(null)
  const modelMetadataRequestRef = useRef<Promise<void> | null>(null)
  const commandsLoadedRef = useRef(false)
  const modelMetadataLoadedRef = useRef(tab.backend === 'claude')

  const state = timeline.state
  const status = timeline.status
  const streaming = status === 'working' || state?.isStreaming === true
  const firstUserItem = timeline.items.find((item) => item.kind === 'user' && !isLocalCommandText(item.kind === 'user' ? item.text : ''))
  const firstUserText = firstUserItem?.kind === 'user' ? firstUserItem.text : undefined
  const displayTitle = contextualSessionTitle(state?.sessionName || firstUserText || tab.label, tab.label)
  const todos = extractTodos(timeline.items)
  const context = estimateContext(timeline.items, state)
  const hasItems = timeline.items.length > 0
  const lastUserItemIndex = timeline.items.reduce(
    (lastIndex, item, index) => item.kind === 'user' ? index : lastIndex,
    -1,
  )
  const visibleItems = timeline.items.filter((item, index) => {
    if (item.kind === 'user' && isLocalCommandText(item.text)) return false
    return item.kind !== 'rationale' || (streaming && index > lastUserItemIndex)
  })
  const chatRows = buildChatRows(visibleItems, streaming)
  const responseActionIds = getResponseActionIds(visibleItems, streaming)
  const runningShell = streaming
    ? [...timeline.items].reverse().find(
        (item): item is Extract<TimelineItem, { kind: 'tool' }> =>
          item.kind === 'tool' && item.name.toLowerCase() === 'bash' && item.status === 'running',
      )
    : undefined

  const loadModelMetadata = useCallback(() => {
    if (modelMetadataLoadedRef.current || modelMetadataRequestRef.current || status === 'starting' || status === 'stopped') return
    const request = Promise.all([api.models(tab.key, tab.backend), api.thinkingLevels(tab.key, tab.backend)])
      .then(([modelResult, levelResult]) => {
        if (modelResult.ok && Array.isArray(modelResult.models) && modelResult.models.length > 0) setModels(modelResult.models)
        if (levelResult.ok && Array.isArray(levelResult.levels) && levelResult.levels.length > 0) setLevels(levelResult.levels)
        if (modelResult.ok && levelResult.ok) modelMetadataLoadedRef.current = true
      })
      .finally(() => { modelMetadataRequestRef.current = null })
    modelMetadataRequestRef.current = request
  }, [status, tab.backend, tab.key])

  const loadCommands = useCallback(() => {
    if (commandsLoadedRef.current || commandRequestRef.current || status === 'starting' || status === 'stopped') return
    const request = api.commands(tab.key, tab.backend)
      .then((result) => {
        if (result.ok && Array.isArray(result.commands)) {
          setCommands(result.commands)
          commandsLoadedRef.current = true
        }
      })
      .finally(() => { commandRequestRef.current = null })
    commandRequestRef.current = request
  }, [status, tab.backend, tab.key])

  useEffect(() => {
    if (draft.startsWith('/') || commandMenuOpen) loadCommands()
  }, [commandMenuOpen, draft, loadCommands])

  useEffect(() => {
    let cancelled = false
    void api.backendLog(tab.key).then((result) => {
      if (!cancelled && result.ok && Array.isArray(result.entries)) timeline.hydrateBackendLog(result.entries)
    })
    return () => { cancelled = true }
  }, [tab.key, timeline])

  const refreshUsage = useCallback((force = false): Promise<boolean> => {
    if (usageRequestRef.current) return usageRequestRef.current
    const request = api.usage(tab.key, tab.backend, force).then((result) => {
      setProviderUsage(result.ok ? result.usage : null)
      return result.ok
    }).catch(() => {
      setProviderUsage(null)
      return false
    }).finally(() => {
      usageRequestRef.current = null
    })
    usageRequestRef.current = request
    return request
  }, [tab.backend, tab.key])

  useEffect(() => {
    // Refresh once when the session/page loads, then only on a slow cadence while
    // visible. The server cache prevents remounts and split panes from repeatedly
    // contacting the provider.
    if (status === 'starting' || status === 'stopped' || !state) return
    let timer: number | undefined
    let cancelled = false

    const schedule = () => {
      if (cancelled || document.hidden) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        void refreshUsage().finally(schedule)
      }, USAGE_REFRESH_INTERVAL_MS)
    }
    const refreshOnVisible = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer)
        timer = undefined
        return
      }
      const force = usageRefreshPendingRef.current
      usageRefreshPendingRef.current = false
      void refreshUsage(force).finally(schedule)
    }

    void refreshUsage().finally(schedule)
    document.addEventListener('visibilitychange', refreshOnVisible)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', refreshOnVisible)
    }
  }, [refreshUsage, state?.model?.id, state?.model?.provider, status])

  useEffect(() => subscribeEvents((event) => {
    if (event.sessionKey !== tab.key || event.type !== 'agent_settled') return
    if (document.hidden) {
      usageRefreshPendingRef.current = true
      return
    }
    void refreshUsage(true)
  }), [refreshUsage, tab.key])

  useEffect(() => {
    setConversationLabel(tab.key, displayTitle)
  }, [displayTitle, setConversationLabel, tab.key])

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

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        timeline.appendNotice(`${file.name} is larger than the 20 MB upload limit.`, 'error')
        continue
      }
      try {
        const data = await fileAsBase64(file)
        const result = await api.upload(tab.key, file.name, file.type || 'application/octet-stream', data)
        if (!result.ok || !result.path) {
          timeline.appendNotice(result.error ?? `Could not upload ${file.name}`, 'error')
          continue
        }
        setAttachments((current) => [...current, {
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          path: result.path!,
          ...(file.type.startsWith('image/') ? { imageData: data } : {}),
        }])
      } catch (error) {
        timeline.appendNotice(error instanceof Error ? error.message : `Could not upload ${file.name}`, 'error')
      }
    }
  }

  const configureSession = async (nextAccess: AccessMode, nextMode: AgentMode, nextCwd = tab.cwd) => {
    if (hasItems) {
      timeline.appendNotice('Access and agent mode can only be changed before the first message.', 'warning')
      return
    }
    setConfiguring(true)
    const result = await api.configure(
      tab.key,
      nextCwd,
      nextAccess,
      nextMode,
      state?.model,
      state?.thinkingLevel,
      undefined,
      tab.backend,
    )
    setConfiguring(false)
    if (!result.ok || !result.state) {
      timeline.appendNotice(result.error ?? `Could not reconfigure the ${tab.backend === 'claude' ? 'Claude' : 'Pi'} session`, 'error')
      return
    }
    setAccessMode(nextAccess)
    setAgentMode(nextMode)
    timeline.reset(result.state)
    if (nextCwd !== tab.cwd) setConversationWorkspace(tab.key, nextCwd)
  }

  const send = async (raw: string) => {
    const message = raw.trim()
    if (!message && attachments.length === 0) return
    if (attachments.length === 0 && (message === '/new' || message === '/clear')) {
      const result = await api.newSession(tab.key)
      if (result.ok && result.state && Array.isArray(result.messages)) {
        timeline.hydrate(result.messages, result.state)
        setConversationSessionPath(tab.key, undefined)
      } else if (!result.ok) {
        timeline.appendNotice(result.error ?? `Could not create a new ${tab.backend === 'claude' ? 'Claude' : 'Pi'} session`, 'error')
      }
      refreshSessions()
      setDraft('')
      return
    }
    if (attachments.length === 0 && message === '/compact') {
      await api.compact(tab.key)
      setDraft('')
      return
    }
    if (attachments.length === 0 && isUsageShortcut(message)) {
      setDraft('')
      if (!await refreshUsage(true)) timeline.appendNotice('Could not retrieve usage', 'error')
      return
    }
    const pickedAttachments = attachments
    const attachmentLines = pickedAttachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`)
    const outboundMessage = [
      message || 'Please inspect the attached file(s).',
      attachmentLines.length ? `Attached files:\n${attachmentLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
    const displayMessage = [
      message || 'Attached file(s)',
      pickedAttachments.length ? `Attachments: ${pickedAttachments.map((attachment) => attachment.name).join(', ')}` : '',
    ].filter(Boolean).join('\n\n')
    const images = pickedAttachments
      .filter((attachment) => attachment.imageData)
      .map((attachment) => ({ type: 'image' as const, data: attachment.imageData!, mimeType: attachment.mimeType }))
    timeline.appendUser(displayMessage)
    setDraft('')
    setAttachments([])
    stickToBottom.current = true

    // A model's natural-language self-identification is not authoritative:
    // aliases and provider prompts can make Luna claim to be Kimi. For this
    // narrow question, answer from the session state that Pi reports instead.
    if (pickedAttachments.length === 0 && state?.model && isModelIdentityQuestion(message)) {
      timeline.appendAssistant(runtimeModelAnswer(state.model))
      return
    }

    const result = streaming
      ? await api.steer(tab.key, outboundMessage, images)
      : await api.prompt(tab.key, outboundMessage, images)
    if (!result.ok) {
      setAttachments(pickedAttachments)
      timeline.appendNotice(result.error ?? 'prompt failed', 'error')
    }
  }

  useEffect(() => {
    if (state?.sessionFile) setConversationSessionPath(tab.key, state.sessionFile)
  }, [setConversationSessionPath, state?.sessionFile, tab.key])

  useEffect(() => {
    if (state?.model) setPreferredModel(tab.backend, tab.cwd, state.model)
  }, [setPreferredModel, state?.model, tab.backend, tab.cwd])

  useEffect(() => {
    const closeFloatingMenus = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (addDetailsRef.current?.open && !addDetailsRef.current.contains(target)) {
        addDetailsRef.current.open = false
      }
      if (commandMenuOpen && !target.closest('.composer')) setCommandMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeFloatingMenus)
    return () => document.removeEventListener('pointerdown', closeFloatingMenus)
  }, [commandMenuOpen])

  // slash filtering for the command menu opened by typing "/"
  const slashFilter = draft.startsWith('/') ? draft.slice(1).toLowerCase() : null
  const slashMatches =
    slashFilter !== null && slashFilter.length >= 0
      ? commands.filter((c) => c.name.toLowerCase().startsWith(slashFilter)).slice(0, 8)
      : commands.slice(0, 8)
  const slashOpen = commandMenuOpen || (slashFilter !== null && slashMatches.length > 0)

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slashMatches.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
      if (event.key === 'Tab' || (event.key === 'Enter' && slashFilter !== null && draft.length > 1)) {
        event.preventDefault()
        const picked = slashMatches[Math.min(slashIndex, slashMatches.length - 1)]
        if (picked) setDraft(`/${picked.name} `)
        setCommandMenuOpen(false)
        return
      }
      if (event.key === 'Escape') { setCommandMenuOpen(false); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  const textareaMinHeight = 48
  const autoGrow = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, textareaMinHeight), 196)}px`
  }
  useLayoutEffect(() => {
    autoGrow()
  })

  const modelOptions: ModelOption[] = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label: tab.backend === 'claude' || m.provider === 'anthropic'
      ? formatClaudeModelName(m.name ?? m.id)
      : (m.name ?? m.id),
  }))
  const activeModel = state?.model ?? (tab.backend === 'claude' && tab.isFresh ? CLAUDE_DEFAULT_MODEL : null)
  const currentModel = activeModel ? `${activeModel.provider}/${activeModel.id}` : ''
  const currentModelLabel = modelOptions.find((option) => `${option.provider}/${option.id}` === currentModel)?.label
    ?? (tab.backend === 'claude' && activeModel ? formatClaudeModelName(activeModel.name ?? activeModel.id) : activeModel?.name)
    ?? activeModel?.id
    ?? 'model…'
  const effort = state?.thinkingLevel ?? (tab.backend === 'claude' && tab.isFresh ? CLAUDE_DEFAULT_EFFORT : 'off')

  const setModel = (value: string) => {
    const option = modelOptions.find((candidate) => `${candidate.provider}/${candidate.id}` === value)
    if (!option) return
    void api.setModel(tab.key, option.provider, option.id).then((result) => {
      if (!result.ok) {
        timeline.appendNotice(result.error ?? 'Could not set model', 'error')
        return
      }
      if (result.state) {
        timeline.setState(result.state)
        setPreferredModel(tab.backend, tab.cwd, result.state.model)
      } else {
        const model = result.data
          ?? models.find((candidate) => candidate.provider === option.provider && candidate.id === option.id)
          ?? option
        if (timeline.state) {
          timeline.setState({ ...timeline.state, model })
          setPreferredModel(tab.backend, tab.cwd, model)
        }
      }
      void api.thinkingLevels(tab.key, tab.backend).then((levelResult) => {
        if (levelResult.ok && Array.isArray(levelResult.levels)) setLevels(levelResult.levels)
      })
      void refreshUsage(true)
    })
  }

  const setEffort = (level: string) => {
    void api.setThinking(tab.key, level).then((result) => {
      if (!result.ok) {
        timeline.appendNotice(result.error ?? 'Could not set thinking level', 'error')
        return
      }
      if (timeline.state) timeline.setState({ ...timeline.state, thinkingLevel: level })
    })
  }

  const interrupt = useCallback(() => {
    void api.abort(tab.key)
  }, [tab.key])

  const forkOutput = async (item: Extract<TimelineItem, { kind: 'assistant' }>) => {
    if (streaming || forkingId) return
    setForkingId(item.id)
    const result = await api.fork(tab.key, item.timestamp)
    setForkingId(null)
    if (!result.ok || !result.state || !Array.isArray(result.messages)) {
      timeline.appendNotice(result.error ?? 'Could not fork this response', 'error')
      return
    }
    timeline.hydrate(result.messages, result.state)
    setConversationSessionPath(tab.key, result.state.sessionFile)
    refreshSessions()
  }

  const setupChips = (
    <div className="composer__setup">
      <div className="hero__chips">
        <WorkspacePicker
          cwd={tab.cwd}
          backend={tab.backend}
          disabled={configuring}
          onPick={(path) => configureSession(accessMode, agentMode, path)}
        />
        <div className="native-select native-select--chip native-select--mode">
          <span className="native-select__icon"><IconCube size={15} /></span>
          <select
            aria-label="Agent mode"
            value={agentMode}
            disabled={configuring}
            onChange={(event) => void configureSession(accessMode, event.target.value as AgentMode)}
          >
            <option value="standard">Standard mode</option>
            <option value="plan">Plan mode</option>
          </select>
          <span className="native-select__chev"><IconChevronDown size={13} /></span>
        </div>
      </div>
    </div>
  )

  const composer = (
    <div className="composer">
      {!hasItems && setupChips}
      {slashOpen && slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`slash-menu__item${index === slashIndex ? ' is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                setDraft(`/${command.name} `)
                setCommandMenuOpen(false)
                textareaRef.current?.focus()
              }}
            >
              <code>/{command.name}</code>
              <span>{command.description ?? ''}</span>
              <em>{command.source ?? 'pi'}</em>
            </button>
          ))}
        </div>
      )}
      {streaming && todos.length > 0 && <TodoTracker tasks={todos} />}
      <form
        className="composer__card"
        onSubmit={(e: FormEvent) => { e.preventDefault(); void send(draft) }}
      >
        <input
          ref={fileInputRef}
          className="composer__file-input"
          type="file"
          multiple
          onChange={(event) => {
            void uploadFiles(event.target.files)
            event.target.value = ''
          }}
        />
        {attachments.length > 0 && (
          <div className="composer__attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <span className="attachment-chip" key={attachment.id} title={attachment.path}>
                <IconFile size={14} />
                <span>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer__scroll">
          <textarea
            ref={textareaRef}
            className="composer__textarea"
            rows={2}
            placeholder="Describe what you want to build"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (commandMenuOpen) setCommandMenuOpen(false)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="composer__row">
          <div className="composer__tools">
            <details ref={addDetailsRef} className="add-disclosure">
              <summary className="composer__add" aria-label="Add">
                <IconPlus />
              </summary>
              <div className="native-add-menu">
                <button
                  type="button"
                  onClick={() => {
                    if (addDetailsRef.current) addDetailsRef.current.open = false
                    fileInputRef.current?.click()
                  }}
                >
                  <span className="native-add-menu__icon"><IconUpload /></span>
                  <span>Upload file</span>
                  <em>20 MB max</em>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (addDetailsRef.current) addDetailsRef.current.open = false
                    loadCommands()
                    setCommandMenuOpen(true)
                    setSlashIndex(0)
                    textareaRef.current?.focus()
                  }}
                >
                  <span className="native-add-menu__icon"><IconCommand /></span>
                  <span>Slash commands</span>
                  <em>{commands.length} from {tab.backend === 'claude' ? 'Claude' : 'Pi'}</em>
                </button>
              </div>
            </details>
          </div>
          <div className="composer__trailing">
            {providerUsage?.available && (
              <>
                <UsageSummary usage={providerUsage} />
                <span className="usage-summary__rule" aria-hidden="true" />
              </>
            )}
            <div className="native-model-controls" onPointerDown={loadModelMetadata} onFocus={loadModelMetadata}>
              <IconCube size={15} />
              <span className="native-model-controls__field native-model-controls__field--model" title={currentModelLabel}>
                <span className="native-model-controls__value">{currentModelLabel}</span>
                <span className="native-select__chev"><IconChevronDown size={13} /></span>
                <select
                  aria-label="Model"
                  value={currentModel}
                  disabled={configuring || streaming}
                  title={streaming ? 'Wait for the current response to finish before changing model' : 'Change model for the next message'}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!currentModel && <option value="">model…</option>}
                  {currentModel && !modelOptions.some((option) => `${option.provider}/${option.id}` === currentModel) && (
                    <option value={currentModel}>
                      {tab.backend === 'claude'
                        ? formatClaudeModelName(state?.model?.name ?? state?.model?.id ?? currentModel)
                        : (state?.model?.name ?? state?.model?.id ?? currentModel)}
                    </option>
                  )}
                  {modelOptions.map((option) => (
                    <option key={`${option.provider}/${option.id}`} value={`${option.provider}/${option.id}`}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </span>
              <span className="native-model-controls__field native-model-controls__field--effort" title={`Effort: ${effort}`}>
                <span className="native-model-controls__value">{effort}</span>
                <span className="native-select__chev"><IconChevronDown size={13} /></span>
                <select
                  aria-label="Effort"
                  value={effort}
                  disabled={configuring || streaming}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  {!levels.includes(effort) && <option value={effort}>{effort}</option>}
                  {levels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </span>
            </div>
            {streaming ? (
              <button
                type="button"
                className="composer__primary is-stop"
                aria-label="Stop"
                onClick={() => void api.abort(tab.key)}
              >
                <IconStop />
              </button>
            ) : (
              <button
                type="submit"
                className="composer__primary"
                aria-label="Send"
                disabled={!draft.trim() && attachments.length === 0}
              >
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )

  if (!hasItems) {
    return (
      <>
        {split && (
          <div className="conversation-header conversation-header--empty">
            <div className="conversation-header__top">
              <div className="conversation-header__identity" title={`${displayTitle}\n${tab.cwd}`}>
                <span className="conversation-header__pane-label">Session {paneIndex + 1} of {paneCount}</span>
                <div className="conversation-header__title">{displayTitle}</div>
                <div className="conversation-header__path">{tab.cwd}</div>
              </div>
              <span className={`conversation-header__backend is-${tab.backend}`}>{tab.backend === 'claude' ? 'Claude' : 'Pi'}</span>
              <div className="conversation-header__spacer" />
              {onClose && <button type="button" className="conversation-header__close" aria-label={`Close ${displayTitle}`} title="Close session" onClick={onClose}>×</button>}
            </div>
          </div>
        )}
        <div className="conversation-stage">
          <div className="conversation">
            <div className="hero">
              <div className="hero__glow" />
              <div className="hero__stack">
                <div className="hero__headline">
                  <span className="hero__fish"><FishLogo size={34} /></span>
                  <span className="hero__title">Onwards & Upwards</span>
                  <span className="hero__badge">Preview</span>
                </div>
              </div>
            </div>
            {composer}
          </div>
        </div>
        {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      </>
    )
  }

  return (
    <>
      <div className="conversation-header">
        <div className="conversation-header__top">
          <div className="conversation-header__identity" title={`${displayTitle}\n${tab.cwd}`}>
            {split && <span className="conversation-header__pane-label">Session {paneIndex + 1} of {paneCount}</span>}
            <div className="conversation-header__title">{displayTitle}</div>
            {split && <div className="conversation-header__path">{tab.cwd}</div>}
          </div>
          {split && <span className={`conversation-header__backend is-${tab.backend}`}>{tab.backend === 'claude' ? 'Claude' : 'Pi'}</span>}
          {agentMode === 'plan' && <div className="conversation-header__mode"><IconCube size={13} /> Plan mode</div>}
          {status === 'working' && <div className="conversation-header__status">Working</div>}
          <div className="conversation-header__spacer" />
          <a
            className={`conversation-header__download${state?.sessionFile ? '' : ' is-disabled'}`}
            href={state?.sessionFile ? api.sessionLogUrl(state.sessionFile) : undefined}
            aria-disabled={!state?.sessionFile}
            download
            onClick={(event) => { if (!state?.sessionFile) event.preventDefault() }}
          >
            Session log <IconDownload size={14} />
          </a>
          {onClose && <button type="button" className="conversation-header__close" aria-label={`Close ${displayTitle}`} title="Close session" onClick={onClose}>×</button>}
        </div>
        <ContextFill context={context} />
        <div className="conversation-header__tabs" role="tablist" aria-label="Conversation view">
          <button type="button" role="tab" aria-selected={conversationView === 'chat'} className={conversationView === 'chat' ? 'is-active' : ''} onClick={() => setConversationView('chat')}>Chat</button>
          <button type="button" role="tab" aria-selected={conversationView === 'trajectory'} className={conversationView === 'trajectory' ? 'is-active' : ''} onClick={() => setConversationView('trajectory')}>Trajectory</button>
          <button type="button" role="tab" aria-selected={conversationView === 'backend'} className={conversationView === 'backend' ? 'is-active' : ''} onClick={() => setConversationView('backend')}>Backend log</button>
        </div>
        {streaming && <div className="activity-line" aria-hidden="true" />}
      </div>

      <div className="conversation-stage">
        <div className="conversation">
          {conversationView === 'chat' ? (
            <div className="conversation__scroll" ref={scrollRef} onScroll={onScroll} role="tabpanel" aria-label="Chat" tabIndex={0}>
              <div className="conversation__column">
                {chatRows.map((row) => row.kind === 'summary' ? (
                  <ToolActivitySummary key={row.id} items={row.items} onOpen={setToolRail} />
                ) : (
                  <TimelineRow
                    key={row.item.id}
                    item={row.item}
                    onOpenFile={setViewer}
                    onFork={forkOutput}
                    forking={forkingId === row.item.id}
                    showActions={responseActionIds.has(row.item.id)}
                  />
                ))}
                {!streaming && <TodoTranscript tasks={todos} />}
                {runningShell
                  ? <ActiveRunIndicator item={runningShell} onInterrupt={interrupt} />
                  : streaming && <ThinkingRow />}
              </div>
            </div>
          ) : conversationView === 'trajectory' ? (
            <div className="conversation__scroll conversation__scroll--trajectory" role="tabpanel" aria-label="Trajectory" tabIndex={0}>
              <Trajectory items={timeline.items} />
            </div>
          ) : (
            <div className="conversation__scroll conversation__scroll--backend" role="tabpanel" aria-label="Backend log" tabIndex={0}>
              <BackendLog entries={timeline.backendLog} live={streaming} />
            </div>
          )}
          {composer}
        </div>
      </div>

      {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      {toolRail && <ToolDetailsRail group={toolRail} onClose={() => setToolRail(null)} />}
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

function ContextFill({ context }: { context: ReturnType<typeof estimateContext> }) {
  const percent = context.percent ?? 0
  return (
    <div
      className="context-fill"
      role="progressbar"
      aria-label={`Context used: ${percent}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={`Approximately ${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used`}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}

function TimelineRow({
  item,
  onOpenFile,
  onFork,
  forking,
  showActions,
}: {
  item: TimelineItem
  onOpenFile: (view: ToolFileView) => void
  onFork: (item: Extract<TimelineItem, { kind: 'assistant' }>) => void
  forking: boolean
  showActions: boolean
}) {
  if (item.kind === 'tool') return <ToolCard item={item} onOpenFile={onOpenFile} />
  if (item.kind === 'notice') return <div className={`notice notice--${item.tone}`}>{item.text}</div>
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
        <RichText text={item.kind === 'assistant' ? item.text.replace(/\s*\[DONE:\d+\]\s*/gi, ' ') : item.text} live={item.live} />
      </div>
      {item.kind === 'assistant' && !item.live && (item.provider || item.modelId) && (
        <div className="response-model-tag" title="Model that generated this reply, as tracked by the backend — not the model's own self-report.">
          {item.provider}{item.provider && item.modelId ? '/' : ''}{item.modelId}
        </div>
      )}
      {item.kind === 'assistant' && !item.live && showActions && (
        <div className="response-actions" aria-label="Response actions">
          <CopyButton
            text={item.text.replace(/\s*\[DONE:\d+\]\s*/gi, ' ')}
            label="Copy response"
            iconOnly
          />
          <button
            type="button"
            className={forking ? 'is-busy' : undefined}
            aria-label="Fork response"
            title={forking ? 'Forking response' : 'Fork response'}
            disabled={forking}
            onClick={() => onFork(item)}
          >
            <IconFork />
          </button>
        </div>
      )}
    </article>
  )
}

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>
type ChatRow =
  | { kind: 'item'; item: TimelineItem }
  | { kind: 'summary'; id: string; items: ToolItem[] }

function isExpandableActivity(item: TimelineItem): item is ToolItem {
  if (item.kind !== 'tool') return false
  return !['edit', 'write'].includes(item.name.toLowerCase())
}

function buildChatRows(items: TimelineItem[], streaming: boolean): ChatRow[] {
  const segments: TimelineItem[][] = []
  let current: TimelineItem[] = []
  for (const item of items) {
    if (item.kind === 'user' && current.length) {
      segments.push(current)
      current = []
    }
    current.push(item)
  }
  if (current.length) segments.push(current)

  return segments.flatMap((segment, segmentIndex) => {
    const active = streaming && segmentIndex === segments.length - 1
    if (active) return segment.map((item) => ({ kind: 'item' as const, item }))

    const rows: ChatRow[] = []
    let activity: ToolItem[] = []
    const flushActivity = () => {
      if (activity.length) {
        rows.push({
          kind: 'summary',
          id: `tool-summary-${activity[0]?.id ?? segmentIndex}`,
          items: activity,
        })
        activity = []
      }
    }
    segment.forEach((item) => {
      if (isExpandableActivity(item)) {
        activity.push(item)
        return
      }
      flushActivity()
      rows.push({ kind: 'item', item })
    })
    flushActivity()
    return rows
  })
}

function getResponseActionIds(items: TimelineItem[], streaming: boolean): Set<string> {
  const ids = new Set<string>()
  let segment: TimelineItem[] = []
  const segments: TimelineItem[][] = []
  for (const item of items) {
    if (item.kind === 'user' && segment.length) {
      segments.push(segment)
      segment = []
    }
    segment.push(item)
  }
  if (segment.length) segments.push(segment)

  segments.forEach((turn, index) => {
    if (streaming && index === segments.length - 1) return
    const assistantIndex = turn.reduce((last, item, itemIndex) => item.kind === 'assistant' ? itemIndex : last, -1)
    if (assistantIndex < 0) return
    if (turn.slice(assistantIndex + 1).some((item) => item.kind === 'tool')) return
    const response = turn[assistantIndex]
    if (response?.kind === 'assistant') ids.add(response.id)
  })
  return ids
}

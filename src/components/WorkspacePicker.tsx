import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, backendLabel, type AgentBackend, type DirectoryListingResponse } from '../lib/api'
import { IconChevronDown, IconCode, IconFolder, IconPlus } from './icons'

export type WorkspacePickerHandle = { openBrowser: () => void }

const RECENT_WORKSPACES_KEY = 'pi-web.workspaces.v1'

function folderLabel(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function storedWorkspaces(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : []
  } catch {
    return []
  }
}

export const WorkspacePicker = forwardRef<WorkspacePickerHandle, {
  cwd: string
  backend?: AgentBackend
  disabled: boolean
  onPick: (path: string) => Promise<void>
  onViewWorkspace?: () => void
  hideTrigger?: boolean
}>(function WorkspacePicker({
  cwd,
  backend = 'pi',
  disabled,
  onPick,
  onViewWorkspace,
  hideTrigger = false,
}, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [listing, setListing] = useState<DirectoryListingResponse | null>(null)
  const [pathDraft, setPathDraft] = useState(cwd)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [recent, setRecent] = useState(() => [cwd, ...storedWorkspaces().filter((path) => path !== cwd)].slice(0, 10))

  const remember = (path: string) => {
    setRecent((current) => {
      const next = [path, ...current.filter((candidate) => candidate !== path)].slice(0, 10)
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next))
      return next
    })
  }

  useEffect(() => { remember(cwd) }, [cwd])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!browserOpen) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setBrowserOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [browserOpen])

  const navigate = async (path?: string) => {
    setLoading(true)
    const result = await api.directories(path)
    setLoading(false)
    setListing(result)
    if (result.ok && result.path) setPathDraft(result.path)
  }

  const choose = async (path: string) => {
    if (path === cwd) {
      setOpen(false)
      setBrowserOpen(false)
      return
    }
    remember(path)
    setOpen(false)
    setBrowserOpen(false)
    await onPick(path)
  }

  const visibleEntries = useMemo(
    () => (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden),
    [listing?.entries, showHidden],
  )

  const openBrowser = () => {
    setOpen(false)
    setBrowserOpen(true)
    setPathDraft(cwd)
    void navigate(cwd)
  }

  useImperativeHandle(ref, () => ({ openBrowser }))

  return (
    <div className="workspace-picker" ref={rootRef} hidden={hideTrigger && !browserOpen ? true : undefined}>
      <button
        type="button"
        className="workspace-picker__trigger"
        aria-label="Workspace"
        aria-expanded={open}
        disabled={disabled}
        title={cwd}
        onClick={() => setOpen((current) => !current)}
      >
        <IconFolder size={15} />
        <span>{folderLabel(cwd)}</span>
        <IconChevronDown size={13} />
      </button>

      {open && (
        <div className="workspace-picker__menu" role="menu" aria-label="Workspaces">
          <div className="workspace-picker__recent">
            {recent.map((path) => (
              <button type="button" role="menuitem" key={path} title={path} onClick={() => void choose(path)}>
                <IconFolder size={16} />
                <span>{folderLabel(path)}</span>
                {path === cwd && <strong aria-label="Current workspace">✓</strong>}
              </button>
            ))}
          </div>
          <div className="workspace-picker__footer">
            {onViewWorkspace && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onViewWorkspace()
                }}
              >
                <IconCode size={16} />
                <span>View workspace</span>
              </button>
            )}
            <button type="button" role="menuitem" onClick={openBrowser}>
              <IconPlus size={16} />
              <span>Add workspace…</span>
            </button>
          </div>
        </div>
      )}

      {browserOpen && (
        <div className="directory-modal" role="dialog" aria-modal="true" aria-label="Choose a project directory">
          <button type="button" className="directory-modal__backdrop" aria-label="Cancel directory selection" onClick={() => setBrowserOpen(false)} />
          <div className="directory-modal__panel">
            <div className="directory-modal__head">
              <div>
                <strong>Choose a project directory</strong>
                <span>{backendLabel(backend)} will use this folder as its workspace.</span>
              </div>
              <button type="button" aria-label="Close directory picker" onClick={() => setBrowserOpen(false)}>×</button>
            </div>
            <form
              className="directory-modal__path"
              onSubmit={(event: FormEvent) => { event.preventDefault(); void navigate(pathDraft) }}
            >
              <button type="button" disabled={!listing?.home || loading} onClick={() => void navigate(listing?.home)}>Home</button>
              <button type="button" disabled={!listing?.parent || loading} onClick={() => void navigate(listing?.parent ?? undefined)}>Up</button>
              <input aria-label="Directory path" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} />
              <button type="submit" disabled={loading}>Go</button>
            </form>
            <div className="directory-modal__options">
              <span>{listing?.path ?? pathDraft}</span>
              <label><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> Show hidden</label>
            </div>
            <div className="directory-modal__list" aria-busy={loading}>
              {loading && <div className="directory-modal__status">Loading folders…</div>}
              {!loading && !listing?.ok && <div className="directory-modal__error" role="alert">{listing?.error ?? 'Could not read this directory.'}</div>}
              {!loading && listing?.ok && visibleEntries.length === 0 && <div className="directory-modal__status">No folders here.</div>}
              {!loading && listing?.ok && visibleEntries.map((entry) => (
                <button type="button" key={entry.path} title={entry.path} onClick={() => void navigate(entry.path)}>
                  <IconFolder size={17} />
                  <span>{entry.name}</span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            <div className="directory-modal__actions">
              <button type="button" onClick={() => setBrowserOpen(false)}>Cancel</button>
              <button type="button" className="is-primary" disabled={!listing?.ok || loading || !listing.path} onClick={() => void choose(listing?.path ?? '')}>
                Use this folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

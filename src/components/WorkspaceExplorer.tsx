import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { api, type WorkspaceEntry, type WorkspaceFileResponse } from '../lib/api'
import { highlightCode } from '../lib/highlight'
import { langFromPath } from '../lib/toolCards'
import { CopyButton } from './CopyButton'
import { IconCode, IconExpand, IconFile, IconFolder, IconPanel, IconRefresh, IconSearch } from './icons'

export type WorkspacePlacement = 'side' | 'full'

const HEAVY_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'DerivedData',
  '__pycache__', '.venv', 'venv', 'target', '.turbo', '.cache', 'Pods',
])

type Clip = { mode: 'cut' | 'copy'; entry: WorkspaceEntry }
type MenuState = { x: number; y: number; entry: WorkspaceEntry }

function folderLabel(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function relativePath(root: string, path: string): string {
  if (path === root) return folderLabel(root)
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

function formatSize(bytes: number | undefined): string | null {
  if (bytes === undefined) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function visibleEntries(
  entries: WorkspaceEntry[],
  query: string,
  listings: Record<string, WorkspaceEntry[]>,
  showHidden: boolean,
): WorkspaceEntry[] {
  const needle = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (!showHidden && entry.hidden) return false
    if (!needle) return true
    if (entry.name.toLowerCase().includes(needle)) return true
    if (entry.type !== 'directory') return false
    const children = listings[entry.path]
    if (!children) return true
    return visibleEntries(children, query, listings, showHidden).length > 0
  })
}

export function WorkspaceExplorer({
  root,
  visible = true,
  placement,
  onPlacementChange,
  onClose,
  onAddToChat,
}: {
  root: string
  visible?: boolean
  placement: WorkspacePlacement
  onPlacementChange: (placement: WorkspacePlacement) => void
  onClose: () => void
  onAddToChat?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([root]))
  const [listings, setListings] = useState<Record<string, WorkspaceEntry[]>>({})
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [truncatedRoots, setTruncatedRoots] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [clip, setClip] = useState<Clip | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [apps, setApps] = useState<{ id: string; label: string }[]>([{ id: 'default', label: 'Default App' }])
  const [notice, setNotice] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem('pi-web.workspace-width'))
    return Number.isFinite(stored) ? Math.min(860, Math.max(360, stored)) : 560
  })
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = Number(localStorage.getItem('pi-web.workspace-tree-width'))
    return Number.isFinite(stored) ? Math.min(420, Math.max(168, stored)) : 228
  })

  const dirty = Boolean(file?.ok && file.content !== undefined && draft !== file.content)

  const loadListing = async (path: string) => {
    setLoadingPaths((current) => new Set(current).add(path))
    const result = await api.workspace(path)
    setLoadingPaths((current) => {
      const next = new Set(current)
      next.delete(path)
      return next
    })
    if (!result.ok || !result.entries) {
      setErrors((current) => ({ ...current, [path]: result.error ?? 'Could not read this folder.' }))
      return
    }
    setErrors((current) => {
      if (!current[path]) return current
      const next = { ...current }
      delete next[path]
      return next
    })
    setListings((current) => ({ ...current, [path]: result.entries ?? [] }))
    setTruncatedRoots((current) => {
      const next = new Set(current)
      if (result.truncated) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const refreshTree = async (paths = expanded) => {
    await Promise.all([...paths].map((path) => loadListing(path)))
  }

  useEffect(() => { void loadListing(root) }, [root])
  useEffect(() => { void api.workspaceApps().then((result) => { if (result.ok) setApps(result.apps) }) }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (menu) { setMenu(null); return }
      if (renaming) { setRenaming(null); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, onClose, renaming])

  const toggleDirectory = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!listings[path]) void loadListing(path)
      }
      return next
    })
  }

  const openFile = async (path: string) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    setSelected(path)
    setMenu(null)
    setFileLoading(true)
    setSaveError(null)
    const result = await api.workspaceFile(path)
    setFileLoading(false)
    setFile(result)
    setDraft(result.content ?? '')
  }

  const saveFile = async () => {
    if (!file?.path || file.content === undefined) return
    setSaving(true)
    setSaveError(null)
    const result = await api.workspaceSave(file.path, draft)
    setSaving(false)
    if (!result.ok) {
      setSaveError(result.error ?? 'Could not save this file.')
      return
    }
    setFile((current) => current ? { ...current, content: draft, size: result.size ?? draft.length, truncated: false } : current)
  }

  const showNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => current === message ? null : current), 2400)
  }

  const runAction = async (label: string, work: () => Promise<{ ok: boolean; error?: string; path?: string }>) => {
    setMenu(null)
    const result = await work()
    if (!result.ok) {
      showNotice(result.error ?? `Could not ${label}.`)
      return result
    }
    await refreshTree()
    return result
  }

  const pasteInto = async (directory: string) => {
    if (!clip) return
    const result = await runAction(clip.mode === 'cut' ? 'move' : 'copy', () => (
      clip.mode === 'cut' ? api.workspaceMove(clip.entry.path, directory) : api.workspaceCopy(clip.entry.path, directory)
    ))
    if (result.ok && clip.mode === 'cut') setClip(null)
  }

  const renameEntry = async (path: string, name: string) => {
    setRenaming(null)
    const next = name.trim()
    if (!next || next === folderLabel(path)) return
    const result = await runAction('rename', () => api.workspaceRename(path, next))
    if (result.ok && result.path && selected === path) {
      setSelected(result.path)
      if (file?.path === path) void openFile(result.path)
    }
  }

  const deleteEntry = async (entry: WorkspaceEntry) => {
    const confirmed = window.confirm(`Delete “${entry.name}”? This cannot be undone.`)
    if (!confirmed) return
    const result = await runAction('delete', () => api.workspaceDelete(entry.path))
    if (result.ok && (selected === entry.path || selected?.startsWith(`${entry.path}/`))) {
      setSelected(null)
      setFile(null)
      setDraft('')
    }
  }

  const persistPanelWidth = (width: number) => {
    const next = Math.min(Math.max(width, 360), Math.round(window.innerWidth * 0.82))
    setPanelWidth(next)
    localStorage.setItem('pi-web.workspace-width', String(next))
    return next
  }

  const persistTreeWidth = (width: number) => {
    const next = Math.min(420, Math.max(168, width))
    setTreeWidth(next)
    localStorage.setItem('pi-web.workspace-tree-width', String(next))
    return next
  }

  const startPanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = panelWidth
    const onMove = (moveEvent: PointerEvent) => persistPanelWidth(startWidth + startX - moveEvent.clientX)
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-workspace')
    }
    document.body.classList.add('is-resizing-workspace')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const resizePanelWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    persistPanelWidth(panelWidth + (event.key === 'ArrowLeft' ? 32 : -32))
  }

  const startTreeResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = treeWidth
    const onMove = (moveEvent: PointerEvent) => persistTreeWidth(startWidth + moveEvent.clientX - startX)
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void }, entry: WorkspaceEntry) => {
    event.preventDefault()
    setSelected(entry.path)
    const width = 248
    const height = 420
    setMenu({
      entry,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    })
  }

  const rootEntries = listings[root] ?? []
  const shownRoot = useMemo(
    () => visibleEntries(rootEntries, query, listings, showHidden),
    [listings, query, rootEntries, showHidden],
  )
  const language = file?.path ? langFromPath(file.path) : undefined
  const sizeLabel = formatSize(file?.size)
  const canEdit = Boolean(file?.ok && file.content !== undefined && !file.binary && !file.truncated)

  if (!visible) return null

  return (
    <aside
      className={`workspace-explorer is-${placement}`}
      aria-label="Workspace source"
      style={placement === 'side' ? { width: panelWidth, flexBasis: panelWidth } : undefined}
    >
      {placement === 'side' && (
        <button
          type="button"
          className="workspace-explorer__resize"
          aria-label="Resize workspace"
          title="Drag to resize workspace"
          onPointerDown={startPanelResize}
          onKeyDown={resizePanelWithKeyboard}
        />
      )}
      <header className="workspace-explorer__head">
        <div className="workspace-explorer__identity" title={root}>
          <IconCode size={15} />
          <div>
            <strong>{folderLabel(root)}</strong>
            <span>Project source</span>
          </div>
        </div>
        <div className="workspace-explorer__modes" role="group" aria-label="Workspace layout">
          <button type="button" aria-pressed={placement === 'side'} title="Side panel" onClick={() => onPlacementChange('side')}>
            <IconPanel size={14} />
          </button>
          <button type="button" aria-pressed={placement === 'full'} title="Full screen" onClick={() => onPlacementChange('full')}>
            <IconExpand size={14} />
          </button>
        </div>
        <button
          type="button"
          className="workspace-explorer__icon-btn"
          aria-label="Refresh workspace"
          title="Refresh"
          onClick={() => {
            void refreshTree()
            if (selected && !dirty) void openFile(selected)
          }}
        >
          <IconRefresh size={14} />
        </button>
        <button type="button" className="workspace-explorer__close" aria-label="Close workspace" onClick={onClose}>×</button>
      </header>

      <div className="workspace-explorer__body">
        <div className="workspace-explorer__tree" style={{ width: treeWidth, flexBasis: treeWidth }}>
          <label className="workspace-explorer__search">
            <IconSearch size={13} />
            <input
              type="search"
              value={query}
              placeholder="Filter files"
              aria-label="Filter workspace files"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="workspace-explorer__hidden">
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
            Hidden files
          </label>
          <div className="workspace-explorer__list" aria-busy={loadingPaths.has(root)}>
            {loadingPaths.has(root) && !listings[root] && <div className="workspace-explorer__status">Reading project…</div>}
            {errors[root] && <div className="workspace-explorer__error" role="alert">{errors[root]}</div>}
            {!loadingPaths.has(root) && !errors[root] && shownRoot.length === 0 && (
              <div className="workspace-explorer__status">{query ? 'No matching files.' : 'This folder is empty.'}</div>
            )}
            {shownRoot.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                query={query}
                showHidden={showHidden}
                expanded={expanded}
                listings={listings}
                loadingPaths={loadingPaths}
                errors={errors}
                truncatedRoots={truncatedRoots}
                selected={selected}
                renaming={renaming}
                onToggle={toggleDirectory}
                onOpenFile={openFile}
                onMenu={openMenu}
                onRename={renameEntry}
                onCancelRename={() => setRenaming(null)}
              />
            ))}
            {truncatedRoots.has(root) && <div className="workspace-explorer__status">Showing the first 2,000 entries.</div>}
          </div>
          <button
            type="button"
            className="workspace-explorer__tree-resize"
            aria-label="Resize file tree"
            title="Drag to resize file tree"
            onPointerDown={startTreeResize}
          />
        </div>

        <section className="workspace-explorer__editor" aria-label="Source">
          {!selected && (
            <div className="workspace-explorer__placeholder">
              <IconCode size={22} />
              <strong>Browse the project</strong>
              <p>Open a file to edit it, or double-click for Finder-style actions.</p>
            </div>
          )}
          {selected && fileLoading && !file && <div className="workspace-explorer__status">Opening file…</div>}
          {selected && file && !file.ok && <div className="workspace-explorer__error" role="alert">{file.error ?? 'Could not open this file.'}</div>}
          {selected && file?.ok && file.binary && (
            <div className="workspace-explorer__placeholder">
              <IconFile size={22} />
              <strong>{file.name}</strong>
              <p>This file is binary, so it isn’t shown as source.{sizeLabel ? ` ${sizeLabel}.` : ''}</p>
            </div>
          )}
          {selected && file?.ok && file.content !== undefined && (
            <>
              <div className="workspace-explorer__file-head">
                <div title={file.path ?? selected}>
                  <strong>{file.name}{dirty ? ' ·' : ''}</strong>
                  <span>
                    {relativePath(root, file.path ?? selected)}
                    {language ? ` · ${language}` : ''}
                    {sizeLabel ? ` · ${sizeLabel}` : ''}
                    {file.truncated ? ' · truncated' : ''}
                    {dirty ? ' · unsaved' : ''}
                  </span>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    className={`workspace-explorer__save${dirty ? ' is-ready' : ''}`}
                    disabled={!dirty || saving}
                    onClick={() => void saveFile()}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
                <CopyButton text={draft || file.content} label="Copy file" className="workspace-explorer__copy" iconOnly />
              </div>
              {file.truncated && <div className="workspace-explorer__notice">Showing the first 1 MB of this file. Editing is disabled.</div>}
              {saveError && <div className="workspace-explorer__error" role="alert">{saveError}</div>}
              {canEdit ? (
                <div className="workspace-code-editor">
                  <pre className="workspace-code-editor__highlight" aria-hidden="true"><code>{highlightCode(`${draft}\n`, language)}</code></pre>
                  <textarea
                    ref={editorRef}
                    value={draft}
                    spellCheck={false}
                    wrap="off"
                    aria-label={`Edit ${file.name}`}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                        event.preventDefault()
                        void saveFile()
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="workspace-explorer__code">
                  <pre><code>{highlightCode(file.content, language)}</code></pre>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {notice && <div className="workspace-explorer__toast" role="status">{notice}</div>}

      {menu && (
        <FileMenu
          menu={menu}
          root={root}
          apps={apps}
          clip={clip}
          onClose={() => setMenu(null)}
          onOpenToSide={() => {
            onPlacementChange('side')
            if (menu.entry.type === 'file') void openFile(menu.entry.path)
            else toggleDirectory(menu.entry.path)
            setMenu(null)
          }}
          onOpenWith={(app) => { void runAction('open', () => api.workspaceOpen(menu.entry.path, app)) }}
          onReveal={() => { void runAction('reveal', () => api.workspaceReveal(menu.entry.path)) }}
          onTerminal={() => { void runAction('open Terminal', () => api.workspaceTerminal(menu.entry.path)) }}
          onAddToChat={() => {
            onAddToChat?.(menu.entry.path)
            setMenu(null)
          }}
          onCut={() => { setClip({ mode: 'cut', entry: menu.entry }); setMenu(null) }}
          onCopy={() => { setClip({ mode: 'copy', entry: menu.entry }); setMenu(null) }}
          onPaste={() => {
            const directory = menu.entry.type === 'directory' ? menu.entry.path : parentPath(menu.entry.path)
            void pasteInto(directory)
          }}
          onCopyPath={() => {
            void navigator.clipboard?.writeText(menu.entry.path)
            setMenu(null)
            showNotice('Copied path')
          }}
          onCopyRelative={() => {
            void navigator.clipboard?.writeText(relativePath(root, menu.entry.path))
            setMenu(null)
            showNotice('Copied relative path')
          }}
          onRename={() => { setRenaming(menu.entry.path); setMenu(null) }}
          onDelete={() => { void deleteEntry(menu.entry) }}
        />
      )}
    </aside>
  )
}

function TreeNode({
  entry,
  depth,
  query,
  showHidden,
  expanded,
  listings,
  loadingPaths,
  errors,
  truncatedRoots,
  selected,
  renaming,
  onToggle,
  onOpenFile,
  onMenu,
  onRename,
  onCancelRename,
}: {
  entry: WorkspaceEntry
  depth: number
  query: string
  showHidden: boolean
  expanded: ReadonlySet<string>
  listings: Record<string, WorkspaceEntry[]>
  loadingPaths: ReadonlySet<string>
  errors: Record<string, string>
  truncatedRoots: ReadonlySet<string>
  selected: string | null
  renaming: string | null
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onMenu: (event: { clientX: number; clientY: number; preventDefault: () => void }, entry: WorkspaceEntry) => void
  onRename: (path: string, name: string) => void
  onCancelRename: () => void
}) {
  const isDirectory = entry.type === 'directory'
  const isOpen = isDirectory && expanded.has(entry.path)
  const children = isOpen ? visibleEntries(listings[entry.path] ?? [], query, listings, showHidden) : []
  const heavy = isDirectory && HEAVY_DIRS.has(entry.name)
  const isRenaming = renaming === entry.path

  return (
    <>
      {isRenaming ? (
        <form
          className="workspace-tree__rename"
          style={{ paddingLeft: 8 + depth * 14 }}
          onSubmit={(event) => {
            event.preventDefault()
            const value = new FormData(event.currentTarget).get('name')
            onRename(entry.path, String(value ?? ''))
          }}
        >
          {isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
          <input
            name="name"
            defaultValue={entry.name}
            aria-label={`Rename ${entry.name}`}
            autoFocus
            onBlur={(event) => onRename(entry.path, event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancelRename() } }}
          />
        </form>
      ) : (
        <button
          type="button"
          className={`workspace-tree__item${selected === entry.path ? ' is-active' : ''}${heavy ? ' is-heavy' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={entry.path}
          aria-expanded={isDirectory ? isOpen : undefined}
          onClick={() => (isDirectory ? onToggle(entry.path) : onOpenFile(entry.path))}
          onDoubleClick={(event) => onMenu(event, entry)}
          onContextMenu={(event) => onMenu(event, entry)}
        >
          {isDirectory
            ? <span className={`workspace-tree__chevron${isOpen ? '' : ' is-collapsed'}`}>⌄</span>
            : <span className="workspace-tree__file-gap" />}
          {isDirectory ? <IconFolder size={14} /> : <IconFile size={14} />}
          <span>{entry.name}</span>
        </button>
      )}
      {isOpen && loadingPaths.has(entry.path) && !listings[entry.path] && (
        <div className="workspace-explorer__status" style={{ paddingLeft: 26 + depth * 14 }}>Loading…</div>
      )}
      {isOpen && errors[entry.path] && (
        <div className="workspace-explorer__error" style={{ paddingLeft: 26 + depth * 14 }}>{errors[entry.path]}</div>
      )}
      {isOpen && children.map((child) => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          query={query}
          showHidden={showHidden}
          expanded={expanded}
          listings={listings}
          loadingPaths={loadingPaths}
          errors={errors}
          truncatedRoots={truncatedRoots}
          selected={selected}
          renaming={renaming}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onMenu={onMenu}
          onRename={onRename}
          onCancelRename={onCancelRename}
        />
      ))}
      {isOpen && truncatedRoots.has(entry.path) && (
        <div className="workspace-explorer__status" style={{ paddingLeft: 26 + depth * 14 }}>Folder truncated.</div>
      )}
    </>
  )
}

function FileMenu({
  menu,
  root,
  apps,
  clip,
  onClose,
  onOpenToSide,
  onOpenWith,
  onReveal,
  onTerminal,
  onAddToChat,
  onCut,
  onCopy,
  onPaste,
  onCopyPath,
  onCopyRelative,
  onRename,
  onDelete,
}: {
  menu: MenuState
  root: string
  apps: { id: string; label: string }[]
  clip: Clip | null
  onClose: () => void
  onOpenToSide: () => void
  onOpenWith: (app: string) => void
  onReveal: () => void
  onTerminal: () => void
  onAddToChat: () => void
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onCopyPath: () => void
  onCopyRelative: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const [openWith, setOpenWith] = useState(false)

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.workspace-menu')) onClose()
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [onClose])

  return (
    <div className="workspace-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={onOpenToSide}>Open to the Side</button>
      <div className={`workspace-menu__sub${openWith ? ' is-open' : ''}`}>
        <button type="button" role="menuitem" aria-haspopup="menu" onClick={() => setOpenWith((open) => !open)}>
          Open With… <span>›</span>
        </button>
        {openWith && (
          <div className="workspace-menu workspace-menu--nested" role="menu">
            {apps.map((app) => (
              <button type="button" role="menuitem" key={app.id} onClick={() => onOpenWith(app.id)}>{app.label}</button>
            ))}
          </div>
        )}
      </div>
      <button type="button" role="menuitem" onClick={onReveal}>Reveal in Finder</button>
      <button type="button" role="menuitem" onClick={onTerminal}>Open in Integrated Terminal</button>
      <div className="workspace-menu__rule" />
      <button type="button" role="menuitem" onClick={onAddToChat}>Add File to Chat</button>
      <div className="workspace-menu__rule" />
      <button type="button" role="menuitem" onClick={onCut}>Cut</button>
      <button type="button" role="menuitem" onClick={onCopy}>Copy</button>
      <button type="button" role="menuitem" disabled={!clip} onClick={onPaste}>Paste</button>
      <button type="button" role="menuitem" onClick={onCopyPath}>Copy Path</button>
      <button type="button" role="menuitem" onClick={onCopyRelative}>Copy Relative Path</button>
      <div className="workspace-menu__rule" />
      <button type="button" role="menuitem" onClick={onRename}>Rename…</button>
      <button type="button" role="menuitem" className="is-danger" onClick={onDelete}>Delete</button>
      <div className="workspace-menu__hint">{relativePath(root, menu.entry.path)}</div>
    </div>
  )
}

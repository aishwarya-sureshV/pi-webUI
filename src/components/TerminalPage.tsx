import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const LIGHT_THEME = {
  background: '#f4f1e9', foreground: '#231f19', cursor: '#b05d13', cursorAccent: '#f4f1e9',
  selectionBackground: 'rgba(176, 93, 19, .22)', black: '#231f19', red: '#a4392e', green: '#3f6f39',
  yellow: '#846214', blue: '#1f6f6a', magenta: '#875a8a', cyan: '#1f6f6a', white: '#ebe6da',
  brightBlack: '#6b6355', brightRed: '#c35043', brightGreen: '#568550', brightYellow: '#a27a22',
  brightBlue: '#318783', brightMagenta: '#9b6d9e', brightCyan: '#318783', brightWhite: '#fffdf7',
}

const DARK_THEME = {
  background: '#0e0d0b', foreground: '#f0ebe2', cursor: '#e8a765', cursorAccent: '#0e0d0b',
  selectionBackground: 'rgba(232, 167, 101, .22)', black: '#12110f', red: '#d4796f', green: '#86b784',
  yellow: '#d9b972', blue: '#7cc7c0', magenta: '#c59ac7', cyan: '#7cc7c0', white: '#d6cfc4',
  brightBlack: '#6d655c', brightRed: '#e08d84', brightGreen: '#a0cb9d', brightYellow: '#e7cb89',
  brightBlue: '#99d7d1', brightMagenta: '#d8b2da', brightCyan: '#99d7d1', brightWhite: '#fffdf7',
}

export function TerminalPage({ cwd, theme }: { cwd?: string; theme: 'light' | 'dark' }) {
  const initialId = useRef(crypto.randomUUID())
  const nextNumber = useRef(2)
  const [tabs, setTabs] = useState(() => [{ id: initialId.current, label: 'Terminal 1', cwd }])
  const [activeId, setActiveId] = useState(initialId.current)
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({})

  const addTerminal = () => {
    const id = crypto.randomUUID()
    const label = `Terminal ${nextNumber.current++}`
    setTabs((current) => [...current, { id, label, cwd }])
    setActiveId(id)
  }

  const closeTerminal = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id)
      const next = current.filter((tab) => tab.id !== id)
      if (id === activeId) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? '')
      return next
    })
    setStatuses((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  return (
    <section className="terminal-page" aria-label="Terminal">
      <header className="terminal-page__header">
        <div><strong>Terminal</strong><span>{cwd || 'Home'}</span></div>
        <button type="button" className="terminal-page__new" onClick={addTerminal} aria-label="New terminal" title="New terminal">+</button>
      </header>
      <div className="terminal-page__tabs" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => {
          const status = statuses[tab.id] ?? 'connecting'
          return (
            <div className={`terminal-page__tab${tab.id === activeId ? ' is-active' : ''}`} key={tab.id}>
              <button type="button" role="tab" aria-selected={tab.id === activeId} onClick={() => setActiveId(tab.id)}>
                <span className={`terminal-page__tab-status is-${status}`} />
                <span>{tab.label}</span>
              </button>
              <button type="button" className="terminal-page__tab-close" onClick={() => closeTerminal(tab.id)} aria-label={`Close ${tab.label}`}>×</button>
            </div>
          )
        })}
        <button type="button" className="terminal-page__tab-add" onClick={addTerminal} aria-label="New terminal tab" title="New terminal">+</button>
      </div>
      <div className="terminal-page__shells">
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.id}
            cwd={tab.cwd}
            theme={theme}
            active={tab.id === activeId}
            onStatus={(status) => setStatuses((current) => current[tab.id] === status ? current : { ...current, [tab.id]: status })}
          />
        ))}
        {tabs.length === 0 && (
          <div className="terminal-page__empty">
            <span>No terminals are open.</span>
            <button type="button" onClick={addTerminal}>New terminal</button>
          </div>
        )}
      </div>
    </section>
  )
}

type TerminalStatus = 'connecting' | 'ready' | 'closed'

function TerminalSession({ cwd, theme, active, onStatus }: {
  cwd?: string
  theme: 'light' | 'dark'
  active: boolean
  onStatus: (status: TerminalStatus) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const statusCallbackRef = useRef(onStatus)

  useEffect(() => {
    statusCallbackRef.current = onStatus
  }, [onStatus])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    fit.fit()
    terminal.focus()
    terminalRef.current = terminal
    fitRef.current = fit

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/terminal?cwd=${encodeURIComponent(cwd || '')}`)
    socketRef.current = socket
    socket.addEventListener('open', () => {
      statusCallbackRef.current('ready')
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
    })
    socket.addEventListener('message', (event) => terminal.write(String(event.data)))
    socket.addEventListener('close', () => statusCallbackRef.current('closed'))
    socket.addEventListener('error', () => terminal.write('\r\n\x1b[31mTerminal connection failed.\x1b[0m\r\n'))

    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
    })
    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      input.dispose()
      socket.close()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      socketRef.current = null
    }
  }, [cwd])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = theme === 'dark' ? DARK_THEME : LIGHT_THEME
  }, [theme])

  useEffect(() => {
    if (!active) return
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit()
      terminalRef.current?.focus()
      const socket = socketRef.current
      const terminal = terminalRef.current
      if (socket?.readyState === WebSocket.OPEN && terminal) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  return (
    <div className={`terminal-page__viewport${active ? ' is-active' : ''}`} ref={hostRef} onPointerDown={() => terminalRef.current?.focus()} />
  )
}

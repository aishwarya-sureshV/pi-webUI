/**
 * pi-web server: static file serving (production build), JSON command API,
 * and a Server-Sent Events stream that fans out pi RPC events to the browser.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/sessions?view=archived       -> persisted ~/.pi sessions
 *   POST /api/sessions/archive             { sessionPath }
 *   POST /api/sessions/restore             { sessionPath }
 *   POST /api/sessions/delete              { sessionPath }
 *   GET  /api/events                       -> SSE stream of all agent events
 *   POST /api/:sessionKey/start            { cwd }
 *   POST /api/:sessionKey/prompt           { message }
 *   POST /api/:sessionKey/steer            { message }
 *   POST /api/:sessionKey/abort
 *   POST /api/:sessionKey/stop
 *   GET  /api/:sessionKey/log
 *   POST /api/:sessionKey/new-session
 *   POST /api/:sessionKey/fork              { timestamp }
 *   POST /api/:sessionKey/compact          { customInstructions? }
 *   POST /api/:sessionKey/set-model        { provider, modelId }
 *   POST /api/:sessionKey/set-thinking     { level }
 *   GET  /api/:sessionKey/commands
 *   GET  /api/:sessionKey/models
 *   GET  /api/:sessionKey/thinking-levels
 */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { PiAgentPool } from './pi-agent.js'
import { ClaudeAgentPool } from './claude-agent.js'
import { archiveSession, deleteSession, listSessions, loadSessionLog, readSessionMessages, restoreSession } from './sessions.js'
import { loadCatalog } from './catalog.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PI_WEB_PORT || 4319)
const HOST = process.env.PI_WEB_HOST || '127.0.0.1'
const BUILD_ID = existsSync(join(DIST, 'index.html'))
  ? createHash('sha256').update(readFileSync(join(DIST, 'index.html'))).digest('hex').slice(0, 12)
  : 'dev'

const piPool = new PiAgentPool()
const claudePool = new ClaudeAgentPool()
/** @type {Map<string, 'pi' | 'claude'>} */
const sessionBackends = new Map()
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set()
/** @type {Map<string, Array<{ id: string, timestamp: number, source: string, type: string, payload: object }>>} */
const runtimeLogs = new Map()
const MAX_RUNTIME_LOG_ENTRIES = 25_000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const res of sseClients) {
    try { res.write(line) } catch { /* dropped */ }
  }
}

function logPayload(event) {
  if (event && typeof event === 'object' && !Array.isArray(event)) return event
  return { value: event }
}

function recordRuntimeEvent(sessionKey, source, event) {
  const entry = {
    id: randomUUID(),
    timestamp: Date.now(),
    source,
    type: String(event?.type ?? 'unknown'),
    payload: logPayload(event),
  }
  const entries = runtimeLogs.get(sessionKey) ?? []
  entries.push(entry)
  if (entries.length > MAX_RUNTIME_LOG_ENTRIES) entries.splice(0, entries.length - MAX_RUNTIME_LOG_ENTRIES)
  runtimeLogs.set(sessionKey, entries)
  return entry
}

function publishRuntimeEvent(sessionKey, source, event) {
  const entry = recordRuntimeEvent(sessionKey, source, event)
  broadcast({
    ...event,
    sessionKey,
    __logId: entry.id,
    __loggedAt: entry.timestamp,
    __logSource: source,
  })
  return entry
}

function commandMetadata(body) {
  const metadata = {}
  if (body && typeof body.cwd === 'string') metadata.cwd = body.cwd
  if (body && typeof body.backend === 'string') metadata.backend = backendName(body.backend)
  if (body && typeof body.message === 'string') metadata.message = body.message
  if (body?.model && typeof body.model === 'object') {
    metadata.model = {
      provider: body.model.provider,
      id: body.model.id,
    }
  }
  if (body && Array.isArray(body.images)) {
    metadata.images = body.images.map((image) => ({
      type: image?.type,
      mimeType: image?.mimeType,
      attached: Boolean(image?.data),
    }))
  }
  return metadata
}

async function runLoggedCommand(sessionKey, action, body, run) {
  const requestId = randomUUID()
  publishRuntimeEvent(sessionKey, 'server', {
    type: 'backend_request',
    requestId,
    action,
    payload: commandMetadata(body),
  })
  let result
  try {
    result = await run()
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }
  publishRuntimeEvent(sessionKey, 'server', {
    type: 'backend_response',
    requestId,
    action,
    ok: Boolean(result?.ok),
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.data !== undefined ? { data: result.data } : {}),
    ...(result?.state !== undefined ? { state: result.state } : {}),
    ...(Array.isArray(result?.messages) ? { messageCount: result.messages.length } : {}),
  })
  return result
}

// Fan every pool event out to all SSE clients (events carry their sessionKey).
function backendName(value) {
  return value === 'claude' ? 'claude' : 'pi'
}

// This was previously sent to the active model as ordinary text when it was
// entered in the composer. It is a display-only shortcut, though: forwarding
// it starts an unnecessary agent turn (and a stale client can keep doing so).
function isUsageShortcut(message, images) {
  return !images?.length && /^\/(?:grok-cli-usage|grok-usage)$/i.test(String(message ?? '').trim())
}

function poolFor(backend) {
  return backend === 'claude' ? claudePool : piPool
}

function watch(sessionKey, requestedBackend) {
  const backend = requestedBackend === undefined
    ? (sessionBackends.get(sessionKey) ?? 'pi')
    : backendName(requestedBackend)
  sessionBackends.set(sessionKey, backend)
  const agent = poolFor(backend).get(sessionKey)
  if (!agent.__watched) {
    agent.__watched = true
    agent.onEvent((event) => publishRuntimeEvent(sessionKey, backend, event))
  }
  return agent
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
  })
  res.end(data)
}

async function readBody(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname
  filePath = normalize(filePath).replace(/^(\.\.[/\\])+/, '')
  const abs = join(DIST, filePath)
  if (!abs.startsWith(DIST) || !existsSync(abs) || !statSync(abs).isFile()) {
    // SPA fallback
    const index = join(DIST, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
      })
      res.end(readFileSyncSafe(index))
      return
    }
    res.writeHead(404); res.end('Not found (run npm run build)'); return
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
  })
  res.end(readFileSyncSafe(abs))
}

function readFileSyncSafe(p) { try { return readFileSync(p) } catch { return '' } }

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: '0.1.0', buildId: BUILD_ID, cwd: process.cwd() })
  }

  if (pathname === '/api/directories' && req.method === 'GET') {
    const requested = url.searchParams.get('path')?.trim() || homedir()
    try {
      const path = resolve(requested)
      const info = await stat(path)
      if (!info.isDirectory()) return sendJson(res, 400, { ok: false, error: 'That path is not a directory.' })
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: join(path, entry.name), hidden: entry.name.startsWith('.') }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      return sendJson(res, 200, {
        ok: true,
        path,
        parent: path === dirname(path) ? null : dirname(path),
        home: homedir(),
        entries,
      })
    } catch (error) {
      const message = error?.code === 'ENOENT'
        ? 'That directory does not exist.'
        : error?.code === 'EACCES'
          ? 'Pi cannot read that directory.'
          : String(error?.message ?? error)
      return sendJson(res, 400, { ok: false, error: message })
    }
  }

  if (pathname === '/api/catalog' && req.method === 'GET') {
    return sendJson(res, 200, await loadCatalog())
  }

  if (pathname === '/api/session-log' && req.method === 'GET') {
    const result = await loadSessionLog(url.searchParams.get('path') ?? '')
    if (!result.ok) return sendJson(res, 400, result)
    const filename = basename(result.path).replace(/[^a-zA-Z0-9._-]/g, '_')
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store, max-age=0',
    })
    res.end(result.contents)
    return
  }

  if (pathname === '/api/session-messages' && req.method === 'GET') {
    return sendJson(res, 200, await readSessionMessages(url.searchParams.get('path') || ''))
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, await listSessions({
      archived: url.searchParams.get('view') === 'archived',
      backend: backendName(url.searchParams.get('backend')),
    }))
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
    const action = pathname.slice('/api/sessions/'.length)
    const body = await readBody(req)
    const sessionPath = String(body.sessionPath ?? '')
    const result = action === 'archive'
      ? await archiveSession(sessionPath)
      : action === 'restore'
        ? await restoreSession(sessionPath)
        : action === 'delete'
          ? await deleteSession(sessionPath)
          : { ok: false, error: 'unknown session action' }
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`data: ${JSON.stringify({ type: '__hello' })}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  const m = pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/)
  if (!m) {
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'unknown route' })
    return serveStatic(req, res, pathname)
  }
  const [, sessionKey, action] = m

  if (req.method === 'GET' && action === 'log') {
    return sendJson(res, 200, { ok: true, entries: runtimeLogs.get(sessionKey) ?? [] })
  }

  if (req.method === 'POST' && action === 'start') {
    const body = await readBody(req)
    const agent = watch(sessionKey, body.backend)
    const result = await runLoggedCommand(sessionKey, 'start', body, () => agent.start(body.cwd || process.cwd(), {
      model: body.model && typeof body.model === 'object'
        ? { provider: String(body.model.provider || ''), id: String(body.model.id || '') }
        : undefined,
      sessionPath: typeof body.sessionPath === 'string' && body.sessionPath ? body.sessionPath : undefined,
      thinkingLevel: typeof body.thinkingLevel === 'string' ? body.thinkingLevel : undefined,
    }))
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'prompt') {
    const body = await readBody(req)
    const message = String(body.message ?? '')
    const images = Array.isArray(body.images) ? body.images : undefined
    if (isUsageShortcut(message, images)) {
      const result = await runLoggedCommand(sessionKey, 'usage', {}, () => watch(sessionKey).getUsage(true))
      return sendJson(res, result.ok ? 200 : 500, result)
    }
    const result = await runLoggedCommand(sessionKey, 'prompt', body, () =>
      watch(sessionKey).prompt(message, images),
    )
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'steer') {
    const body = await readBody(req)
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'steer', body, () =>
      watch(sessionKey).steer(String(body.message ?? ''), Array.isArray(body.images) ? body.images : undefined),
    ))
  }
  if (req.method === 'POST' && action === 'abort') {
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'abort', {}, () => watch(sessionKey).abort()))
  }
  if (req.method === 'POST' && action === 'stop') {
    const backend = sessionBackends.get(sessionKey) ?? 'pi'
    const result = await runLoggedCommand(sessionKey, 'stop', {}, () => {
      poolFor(backend).stop(sessionKey)
      sessionBackends.delete(sessionKey)
      return { ok: true }
    })
    return sendJson(res, 200, result)
  }
  if (req.method === 'POST' && action === 'configure') {
    const body = await readBody(req)
    const currentBackend = sessionBackends.get(sessionKey) ?? 'pi'
    poolFor(currentBackend).stop(sessionKey)
    sessionBackends.delete(sessionKey)
    const agent = watch(sessionKey, body.backend)
    const result = await runLoggedCommand(sessionKey, 'configure', body, () => agent.start(String(body.cwd || process.cwd()), {
      accessMode: body.accessMode === 'read-only' ? 'read-only' : 'workspace-write',
      agentMode: body.agentMode === 'plan' ? 'plan' : 'standard',
      sessionPath: typeof body.sessionPath === 'string' && body.sessionPath ? body.sessionPath : undefined,
      model: body.model && typeof body.model === 'object'
        ? { provider: String(body.model.provider || ''), id: String(body.model.id || '') }
        : undefined,
      thinkingLevel: typeof body.thinkingLevel === 'string' ? body.thinkingLevel : undefined,
    }))
    if (result.ok && body.sessionPath) {
      try { result.messages = await agent.getMessages() }
      catch (error) { return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
    }
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'upload') {
    const body = await readBody(req)
    const data = typeof body.data === 'string' ? body.data : ''
    const bytes = Buffer.from(data, 'base64')
    if (!data || bytes.length === 0) return sendJson(res, 400, { ok: false, error: 'The uploaded file was empty.' })
    if (bytes.length > 20 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: 'Files must be 20 MB or smaller.' })
    const safeSession = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const safeName = basename(String(body.name || 'attachment')).replace(/[^a-zA-Z0-9._ -]/g, '_')
    const directory = join(tmpdir(), 'pi-web-uploads', safeSession)
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${Date.now()}-${safeName}`)
    await writeFile(path, bytes)
    return sendJson(res, 200, { ok: true, path })
  }
  if (req.method === 'POST' && action === 'new-session') {
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'new-session', {}, () => watch(sessionKey).newSession()))
  }
  if (req.method === 'POST' && action === 'resume') {
    const body = await readBody(req)
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'resume', body, () => watch(sessionKey).switchSession(String(body.sessionPath ?? ''))))
  }
  if (req.method === 'POST' && action === 'fork') {
    const body = await readBody(req)
    const result = await runLoggedCommand(sessionKey, 'fork', body, () => watch(sessionKey).forkAt(Number(body.timestamp)))
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'compact') {
    const body = await readBody(req)
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'compact', body, () => watch(sessionKey).compact(body.customInstructions)))
  }
  if (req.method === 'POST' && action === 'set-model') {
    const body = await readBody(req)
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'set-model', body, () => watch(sessionKey).setModel(String(body.provider), String(body.modelId))))
  }
  if (req.method === 'POST' && action === 'set-thinking') {
    const body = await readBody(req)
    return sendJson(res, 200, await runLoggedCommand(sessionKey, 'set-thinking', body, () => watch(sessionKey).setThinkingLevel(String(body.level))))
  }
  if (req.method === 'GET' && action === 'commands') return sendJson(res, 200, await watch(sessionKey, url.searchParams.get('backend') || undefined).getCommands())
  if (req.method === 'GET' && action === 'models') return sendJson(res, 200, await watch(sessionKey, url.searchParams.get('backend') || undefined).getAvailableModels())
  if (req.method === 'GET' && action === 'thinking-levels') return sendJson(res, 200, await watch(sessionKey, url.searchParams.get('backend') || undefined).getThinkingLevels())
  if (req.method === 'GET' && action === 'usage') {
    const refresh = url.searchParams.get('refresh') === '1'
    const result = await watch(sessionKey, url.searchParams.get('backend') || undefined).getUsage(refresh)
    return sendJson(res, result.ok ? 200 : 500, result)
  }

  return sendJson(res, 404, { ok: false, error: 'unknown route' })
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }))
})

const terminalSockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
  if (url.pathname !== '/api/terminal') {
    socket.destroy()
    return
  }
  terminalSockets.handleUpgrade(req, socket, head, (webSocket) => terminalSockets.emit('connection', webSocket, req, url))
})

terminalSockets.on('connection', (socket, _request, url) => {
  const requestedCwd = url.searchParams.get('cwd') || homedir()
  const cwd = existsSync(requestedCwd) && statSync(requestedCwd).isDirectory() ? requestedCwd : homedir()
  const shell = process.env.SHELL || '/bin/zsh'
  let terminal
  try {
    terminal = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
  } catch (error) {
    socket.send(`\r\n\x1b[31mCould not start the shell: ${String(error?.message ?? error)}\x1b[0m\r\n`)
    socket.close()
    return
  }
  terminal.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data)
  })
  terminal.onExit(() => socket.close())
  socket.on('message', (raw) => {
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    if (message.type === 'input' && typeof message.data === 'string') terminal.write(message.data)
    if (message.type === 'resize') {
      const cols = Math.max(2, Math.min(500, Number(message.cols) || 80))
      const rows = Math.max(1, Math.min(200, Number(message.rows) || 24))
      terminal.resize(cols, rows)
    }
  })
  socket.on('close', () => terminal.kill())
})

server.listen(PORT, HOST, () => {
  console.log(`pi-web ready: http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    piPool.stop()
    claudePool.stop()
    sessionBackends.clear()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}

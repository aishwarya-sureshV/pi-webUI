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
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PiAgentPool } from './pi-agent.js'
import { archiveSession, deleteSession, listSessions, loadSessionLog, restoreSession } from './sessions.js'
import { loadCatalog } from './catalog.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PI_WEB_PORT || 4319)
const HOST = process.env.PI_WEB_HOST || '127.0.0.1'
const BUILD_ID = existsSync(join(DIST, 'index.html'))
  ? createHash('sha256').update(readFileSync(join(DIST, 'index.html'))).digest('hex').slice(0, 12)
  : 'dev'

const pool = new PiAgentPool()
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set()

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

// Fan every pool event out to all SSE clients (events carry their sessionKey).
function watch(sessionKey) {
  const agent = pool.get(sessionKey)
  if (!agent.__watched) {
    agent.__watched = true
    agent.onEvent((event) => broadcast(event))
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

  if (pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, await listSessions({ archived: url.searchParams.get('view') === 'archived' }))
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

  if (req.method === 'POST' && action === 'start') {
    const body = await readBody(req)
    const agent = watch(sessionKey)
    const result = await agent.start(body.cwd || process.cwd())
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'prompt') {
    const body = await readBody(req)
    const result = await watch(sessionKey).prompt(String(body.message ?? ''), Array.isArray(body.images) ? body.images : undefined)
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'steer') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).steer(String(body.message ?? ''), Array.isArray(body.images) ? body.images : undefined))
  }
  if (req.method === 'POST' && action === 'abort') {
    return sendJson(res, 200, await watch(sessionKey).abort())
  }
  if (req.method === 'POST' && action === 'stop') {
    pool.stop(sessionKey)
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'POST' && action === 'configure') {
    const body = await readBody(req)
    pool.stop(sessionKey)
    const agent = watch(sessionKey)
    const result = await agent.start(String(body.cwd || process.cwd()), {
      accessMode: body.accessMode === 'read-only' ? 'read-only' : 'workspace-write',
      agentMode: body.agentMode === 'plan' ? 'plan' : 'standard',
      sessionPath: typeof body.sessionPath === 'string' && body.sessionPath ? body.sessionPath : undefined,
      model: body.model && typeof body.model === 'object'
        ? { provider: String(body.model.provider || ''), id: String(body.model.id || '') }
        : undefined,
      thinkingLevel: typeof body.thinkingLevel === 'string' ? body.thinkingLevel : undefined,
    })
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
    return sendJson(res, 200, await watch(sessionKey).newSession())
  }
  if (req.method === 'POST' && action === 'resume') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).switchSession(String(body.sessionPath ?? '')))
  }
  if (req.method === 'POST' && action === 'fork') {
    const body = await readBody(req)
    const result = await watch(sessionKey).forkAt(Number(body.timestamp))
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'compact') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).compact(body.customInstructions))
  }
  if (req.method === 'POST' && action === 'set-model') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).setModel(String(body.provider), String(body.modelId)))
  }
  if (req.method === 'POST' && action === 'set-thinking') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).setThinkingLevel(String(body.level)))
  }
  if (req.method === 'GET' && action === 'commands') return sendJson(res, 200, await watch(sessionKey).getCommands())
  if (req.method === 'GET' && action === 'models') return sendJson(res, 200, await watch(sessionKey).getAvailableModels())
  if (req.method === 'GET' && action === 'thinking-levels') return sendJson(res, 200, await watch(sessionKey).getThinkingLevels())

  return sendJson(res, 404, { ok: false, error: 'unknown route' })
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }))
})

server.listen(PORT, HOST, () => {
  console.log(`pi-web ready: http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { pool.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref() })
}

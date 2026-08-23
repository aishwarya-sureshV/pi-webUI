/**
 * pi-web server: static file serving (production build), JSON command API,
 * and a Server-Sent Events stream that fans out pi RPC events to the browser.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/sessions                     -> persisted ~/.pi sessions
 *   GET  /api/events                       -> SSE stream of all agent events
 *   POST /api/:sessionKey/start            { cwd }
 *   POST /api/:sessionKey/prompt           { message }
 *   POST /api/:sessionKey/steer            { message }
 *   POST /api/:sessionKey/abort
 *   POST /api/:sessionKey/new-session
 *   POST /api/:sessionKey/compact          { customInstructions? }
 *   POST /api/:sessionKey/set-model        { provider, modelId }
 *   POST /api/:sessionKey/set-thinking     { level }
 *   GET  /api/:sessionKey/commands
 *   GET  /api/:sessionKey/models
 *   GET  /api/:sessionKey/thinking-levels
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiAgentPool } from './pi-agent.js'
import { listSessions } from './sessions.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PI_WEB_PORT || 4319)
const HOST = process.env.PI_WEB_HOST || '127.0.0.1'

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(readFileSyncSafe(index))
      return
    }
    res.writeHead(404); res.end('Not found (run npm run build)'); return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(abs)] ?? 'application/octet-stream' })
  res.end(readFileSyncSafe(abs))
}

import { readFileSync } from 'node:fs'
function readFileSyncSafe(p) { try { return readFileSync(p) } catch { return '' } }

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, version: '0.1.0' })

  if (pathname === '/api/sessions') return sendJson(res, 200, await listSessions())

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
    const result = await watch(sessionKey).prompt(String(body.message ?? ''))
    return sendJson(res, result.ok ? 200 : 500, result)
  }
  if (req.method === 'POST' && action === 'steer') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).steer(String(body.message ?? '')))
  }
  if (req.method === 'POST' && action === 'abort') {
    return sendJson(res, 200, await watch(sessionKey).abort())
  }
  if (req.method === 'POST' && action === 'new-session') {
    return sendJson(res, 200, await watch(sessionKey).newSession())
  }
  if (req.method === 'POST' && action === 'resume') {
    const body = await readBody(req)
    return sendJson(res, 200, await watch(sessionKey).switchSession(String(body.sessionPath ?? '')))
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

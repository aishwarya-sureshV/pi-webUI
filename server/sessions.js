/** Discovers and manages resumable Pi and Claude Code sessions. */
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const AGENT_ROOT = join(homedir(), '.pi', 'agent')
const SESSIONS_ROOT = join(AGENT_ROOT, 'sessions')
const ARCHIVE_INDEX = join(AGENT_ROOT, 'pi-web-archived-sessions.json')
const CLAUDE_ROOT = join(homedir(), '.claude')
const CLAUDE_SESSIONS_ROOT = join(CLAUDE_ROOT, 'projects')
const CLAUDE_ARCHIVE_INDEX = join(CLAUDE_ROOT, 'pi-web-archived-sessions.json')
let archiveMutation = Promise.resolve()

import { messagesFromClaudeLog } from './claude-agent.js'

export async function listSessions({ archived = false, backend = 'pi' } = {}) {
  return backend === 'claude' ? listClaudeSessions({ archived }) : listPiSessions({ archived })
}

async function listPiSessions({ archived = false } = {}) {
  try {
    const [folders, archivedPaths] = await Promise.all([
      readdir(SESSIONS_ROOT, { withFileTypes: true }),
      readArchiveIndex(),
    ])
    const paths = (
      await Promise.all(
        folders
          .filter((entry) => entry.isDirectory())
          .map(async (folder) => {
            const entries = await readdir(join(SESSIONS_ROOT, folder.name), { withFileTypes: true })
            return entries
              .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
              .map((entry) => join(SESSIONS_ROOT, folder.name, entry.name))
          }),
      )
    ).flat().filter((path) => archivedPaths.has(path) === archived)
    const sessions = (
      await Promise.all(paths.map((path) => readResumeSession(path)))
    ).filter(Boolean).map((session) => ({ ...session, backend: 'pi' }))
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { ok: true, sessions }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), sessions: [] }
  }
}

export async function listClaudeSessions({ archived = false } = {}) {
  try {
    const [projects, archivedPaths] = await Promise.all([
      readdir(CLAUDE_SESSIONS_ROOT, { withFileTypes: true }),
      readArchiveIndex(CLAUDE_ARCHIVE_INDEX),
    ])
    const paths = (
      await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
        const directory = join(CLAUDE_SESSIONS_ROOT, project.name)
        const entries = await readdir(directory, { withFileTypes: true })
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => join(directory, entry.name))
      }))
    ).flat().filter((path) => archivedPaths.has(path) === archived)
    const sessions = (await Promise.all(paths.map(readClaudeResumeSession)))
      .filter((session) => session && !isInternalClaudeSession(session))
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { ok: true, sessions }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, sessions: [] }
    return { ok: false, error: String(error?.message ?? error), sessions: [] }
  }
}

export async function archiveSession(path) {
  return updateArchiveIndex(path, true)
}

export async function restoreSession(path) {
  return updateArchiveIndex(path, false)
}

export async function deleteSession(path) {
  try {
    const { path: safePath, archiveIndex } = await resolveSessionPath(path)
    await unlink(safePath)
    await mutateArchiveIndex(archiveIndex, async (archivedPaths) => {
      archivedPaths.delete(safePath)
      return archivedPaths
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export async function readSessionMessages(path) {
  try {
    const { path: safePath, backend } = await resolveSessionPath(path)
    const contents = await readFile(safePath, 'utf8')
    const messages = backend === 'claude' ? messagesFromClaudeLog(contents) : messagesFromPiLog(contents)
    return { ok: true, messages }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), messages: [] }
  }
}

function messagesFromPiLog(contents) {
  const messages = []
  for (const line of String(contents || '').split('\n')) {
    if (!line) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue
    const timestamp = Date.parse(entry.timestamp ?? entry.message.timestamp ?? '') || Date.now()
    messages.push({ ...entry.message, timestamp })
  }
  return messages
}

export async function loadSessionLog(path) {
  try {
    const { path: safePath } = await resolveSessionPath(path)
    return { ok: true, path: safePath, contents: await readFile(safePath, 'utf8') }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function updateArchiveIndex(path, archived) {
  try {
    const { path: safePath, archiveIndex } = await resolveSessionPath(path)
    await mutateArchiveIndex(archiveIndex, async (archivedPaths) => {
      if (archived) archivedPaths.add(safePath)
      else archivedPaths.delete(safePath)
      return archivedPaths
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function resolveSessionPath(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) throw new Error('Invalid saved session path.')
  const requested = resolve(path)
  let candidate
  try {
    candidate = await realpath(requested)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('The saved session no longer exists.')
    throw error
  }
  for (const config of [
    { root: SESSIONS_ROOT, archiveIndex: ARCHIVE_INDEX, backend: 'pi' },
    { root: CLAUDE_SESSIONS_ROOT, archiveIndex: CLAUDE_ARCHIVE_INDEX, backend: 'claude' },
  ]) {
    let root
    try { root = await realpath(config.root) } catch { continue }
    const fromRoot = relative(root, candidate)
    if (fromRoot && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)) {
      const file = await stat(candidate)
      if (!file.isFile()) throw new Error('The saved session no longer exists.')
      return { path: candidate, archiveIndex: config.archiveIndex, backend: config.backend }
    }
  }
  throw new Error('The requested file is not a saved Pi or Claude session.')
}

async function readArchiveIndex(indexPath = ARCHIVE_INDEX) {
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    return new Set(Array.isArray(parsed?.paths) ? parsed.paths.filter((path) => typeof path === 'string') : [])
  } catch {
    return new Set()
  }
}

async function mutateArchiveIndex(indexPath, change) {
  const operation = archiveMutation.then(async () => {
    const paths = await change(await readArchiveIndex(indexPath))
    await mkdir(indexPath === CLAUDE_ARCHIVE_INDEX ? CLAUDE_ROOT : AGENT_ROOT, { recursive: true })
    const temporary = `${indexPath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, paths: [...paths].sort() }, null, 2)}\n`, 'utf8')
    await rename(temporary, indexPath)
  })
  archiveMutation = operation.catch(() => {})
  return operation
}

function isInternalClaudeSession(session) {
  const text = `${session?.name || ''}\n${session?.firstPrompt || ''}`
  return /<local-command-caveat>|<command-name>|<command-message>|<command-args>/.test(text)
}

async function readClaudeResumeSession(path) {
  try {
    const [contents, file] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    let name
    let cwd = ''
    let createdAt = file.birthtimeMs || file.mtimeMs
    // Claude touches a resumed JSONL by appending bookkeeping records such as
    // `last-prompt`, `atis-latch`, and `mode`. Those are not conversation
    // activity, so the sidebar's "Recent" time must come from a real turn.
    let modifiedAt = 0
    let messageCount = 0
    let firstPrompt = ''
    let lastModel
    let lastEffort
    for (const line of contents.split('\n')) {
      if (!line) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      if (Number.isFinite(timestamp)) createdAt = Math.min(createdAt, timestamp)
      if (typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
        name = entry.customTitle.trim()
      } else if (!name && entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
        name = entry.aiTitle.trim()
      }
      if (entry.type === 'assistant') {
        const model = entry.message?.model
        if (typeof model === 'string' && model && model !== '<synthetic>') lastModel = model
        if (typeof entry.effort === 'string' && entry.effort.trim()) lastEffort = entry.effort.trim()
      }
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      if (Number.isFinite(timestamp)) modifiedAt = Math.max(modifiedAt, timestamp)
      messageCount += 1
      if (firstPrompt || entry.type !== 'user') continue
      const content = entry.message?.content
      if (typeof content === 'string' && content.trim()) firstPrompt = content.trim()
      else if (Array.isArray(content)) {
        const text = content.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text
        if (text?.trim()) firstPrompt = text.trim()
      }
    }
    return {
      path,
      backend: 'claude',
      name: name || firstPrompt || 'Untitled session',
      cwd,
      createdAt,
      modifiedAt: modifiedAt || createdAt,
      messageCount,
      firstPrompt: firstPrompt || undefined,
      lastModel,
      lastEffort,
    }
  } catch { return null }
}

async function readResumeSession(path) {
  try {
    const [contents, file] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    let name
    let cwd = ''
    let createdAt = file.birthtimeMs || file.mtimeMs
    let modifiedAt = file.mtimeMs
    let messageCount = 0
    let firstPrompt = ''
    for (const line of contents.split('\n')) {
      if (!line) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (entry.type === 'session') {
        if (typeof entry.cwd === 'string') cwd = entry.cwd
        if (typeof entry.timestamp === 'string') createdAt = Date.parse(entry.timestamp) || createdAt
      } else if (entry.type === 'session_info' && typeof entry.name === 'string') {
        name = entry.name.trim() || undefined
      } else if (entry.type === 'message') {
        messageCount++
        if (typeof entry.timestamp === 'string') modifiedAt = Date.parse(entry.timestamp) || modifiedAt
        const message = entry.message
        if (!firstPrompt && message?.role === 'user' && Array.isArray(message.content)) {
          const text = message.content.find(
            (part) => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string',
          )?.text
          if (text) firstPrompt = text
        }
      }
    }
    return {
      path,
      name: name || firstPrompt || 'Untitled session',
      cwd,
      createdAt,
      modifiedAt,
      messageCount,
      firstPrompt: firstPrompt || undefined,
    }
  } catch { return null }
}

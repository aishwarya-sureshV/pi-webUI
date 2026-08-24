/** Discovers and manages resumable Pi sessions from ~/.pi/agent/sessions. */
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const AGENT_ROOT = join(homedir(), '.pi', 'agent')
const SESSIONS_ROOT = join(AGENT_ROOT, 'sessions')
const ARCHIVE_INDEX = join(AGENT_ROOT, 'pi-web-archived-sessions.json')
let archiveMutation = Promise.resolve()

export async function listSessions({ archived = false } = {}) {
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
    ).filter(Boolean)
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { ok: true, sessions }
  } catch (error) {
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
    const safePath = await resolveSessionPath(path)
    await unlink(safePath)
    await mutateArchiveIndex(async (archivedPaths) => {
      archivedPaths.delete(safePath)
      return archivedPaths
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export async function loadSessionLog(path) {
  try {
    const safePath = await resolveSessionPath(path)
    return { ok: true, path: safePath, contents: await readFile(safePath, 'utf8') }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function updateArchiveIndex(path, archived) {
  try {
    const safePath = await resolveSessionPath(path)
    await mutateArchiveIndex(async (archivedPaths) => {
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
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) throw new Error('Invalid Pi session path.')
  const requested = resolve(path)
  const root = await realpath(SESSIONS_ROOT)
  let candidate
  try {
    candidate = await realpath(requested)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('The saved Pi session no longer exists.')
    throw error
  }
  const fromRoot = relative(root, candidate)
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('The requested file is not a saved Pi session.')
  }
  const file = await stat(candidate)
  if (!file.isFile()) throw new Error('The saved Pi session no longer exists.')
  return candidate
}

async function readArchiveIndex() {
  try {
    const parsed = JSON.parse(await readFile(ARCHIVE_INDEX, 'utf8'))
    return new Set(Array.isArray(parsed?.paths) ? parsed.paths.filter((path) => typeof path === 'string') : [])
  } catch {
    return new Set()
  }
}

async function mutateArchiveIndex(change) {
  const operation = archiveMutation.then(async () => {
    const paths = await change(await readArchiveIndex())
    await mkdir(AGENT_ROOT, { recursive: true })
    const temporary = `${ARCHIVE_INDEX}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, paths: [...paths].sort() }, null, 2)}\n`, 'utf8')
    await rename(temporary, ARCHIVE_INDEX)
  })
  archiveMutation = operation.catch(() => {})
  return operation
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
    }
  } catch { return null }
}

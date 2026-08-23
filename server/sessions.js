/** Discovers resumable Pi sessions from ~/.pi/agent/sessions (mirrors AgentDeck). */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export async function listSessions() {
  try {
    const root = join(homedir(), '.pi', 'agent', 'sessions')
    const folders = await readdir(root, { withFileTypes: true })
    const paths = (
      await Promise.all(
        folders
          .filter((entry) => entry.isDirectory())
          .map(async (folder) => {
            const entries = await readdir(join(root, folder.name), { withFileTypes: true })
            return entries
              .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
              .map((entry) => join(root, folder.name, entry.name))
          }),
      )
    ).flat()
    const sessions = (
      await Promise.all(paths.map((path) => readResumeSession(path)))
    ).filter(Boolean)
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { ok: true, sessions }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), sessions: [] }
  }
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

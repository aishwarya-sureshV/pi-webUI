import type { TimelineItem } from './timeline'

export type TodoTask = {
  id: number
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  activeForm?: string
  blockedBy?: number[]
}

function asTask(value: unknown): TodoTask | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = Number(record.id)
  const subject = (
    typeof record.subject === 'string' ? record.subject
    : typeof record.content === 'string' ? record.content
    : ''
  ).trim()
  const status = String(record.status ?? '') as TodoTask['status']
  if (!Number.isFinite(id) || !subject || !['pending', 'in_progress', 'completed', 'deleted'].includes(status)) return null
  return {
    id,
    subject,
    status,
    ...(typeof record.activeForm === 'string' ? { activeForm: record.activeForm } : {}),
    ...(Array.isArray(record.blockedBy) ? { blockedBy: record.blockedBy.map(Number).filter(Number.isFinite) } : {}),
  }
}

function isTodoTool(item: TimelineItem): item is Extract<TimelineItem, { kind: 'tool' }> {
  return item.kind === 'tool' && item.name.toLowerCase().includes('todo')
}

function isTurnStart(item: TimelineItem): boolean {
  return item.kind === 'user' && !/<local-command-caveat>|<command-name>|<command-message>|<command-args>/.test(item.text)
}

function snapshotFromTool(item: Extract<TimelineItem, { kind: 'tool' }>): TodoTask[] | 'clear' | null {
  const source = (
    Array.isArray(item.details.tasks) ? item.details.tasks
    : Array.isArray(item.details.todos) ? item.details.todos
    : Array.isArray(item.args.tasks) ? item.args.tasks
    : Array.isArray(item.args.todos) ? item.args.todos
    : null
  )
  if (item.details.action === 'clear' && (!source || source.length === 0)) return 'clear'
  if (!source) return null
  const snapshot = source.map(asTask).filter((task): task is TodoTask => task !== null)
  if (snapshot.length === 0 && !item.details.action) return null
  return snapshot
}

/**
 * Todos for the *current* turn only. Pi persists one list for the whole session,
 * so a later snapshot still contains every prior task — those leftovers are
 * dropped. A new user prompt with no todo writes yet returns []. Incomplete
 * tasks are marked completed once the turn has settled (abort / natural end).
 */
export function extractTodos(items: TimelineItem[], options: { turnComplete?: boolean } = {}): TodoTask[] {
  let lastUser = -1
  for (let index = 0; index < items.length; index++) {
    if (isTurnStart(items[index]!)) lastUser = index
  }

  let previous: TodoTask[] = []
  let current: TodoTask[] | null = null
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (!isTodoTool(item)) continue
    const snapshot = snapshotFromTool(item)
    if (snapshot === null) continue
    if (index < lastUser) {
      previous = snapshot === 'clear' ? [] : snapshot
    } else {
      current = snapshot === 'clear' ? [] : snapshot
    }
  }

  if (current === null) return []

  const previousById = new Map(previous.map((task) => [task.id, task]))
  let visible = current.filter((task) => {
    const prior = previousById.get(task.id)
    if (!prior) return true
    if (prior.subject !== task.subject) return true
    return prior.status !== task.status
  })

  if (options.turnComplete) {
    visible = visible.map((task) => (
      task.status === 'pending' || task.status === 'in_progress'
        ? { ...task, status: 'completed' as const }
        : task
    ))
  }

  return visible.filter((task) => task.status !== 'deleted')
}

import { useState } from 'react'
import type { TimelineItem } from '../lib/timeline'

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
  const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
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

/** Read the latest persisted snapshot emitted by the installed todo tool. */
export function extractTodos(items: TimelineItem[]): TodoTask[] {
  let latest: TodoTask[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || !item.name.toLowerCase().includes('todo')) continue
    const rawTasks = Array.isArray(item.details.tasks)
      ? item.details.tasks
      : Array.isArray(item.details.todos)
        ? item.details.todos
        : []
    if (rawTasks.length === 0 && item.details.action === 'clear') {
      latest = []
      continue
    }
    const snapshot = rawTasks.map(asTask).filter((task): task is TodoTask => task !== null)
    if (snapshot.length > 0 || rawTasks.length === 0 && item.details.action) latest = snapshot
  }
  return latest.filter((task) => task.status !== 'deleted')
}

function taskGlyph(task: TodoTask): string {
  if (task.status === 'completed') return '✓'
  if (task.status === 'in_progress') return '▸'
  return '○'
}

function dependencyLabel(task: TodoTask): string | null {
  return task.blockedBy?.length ? `⋈ ${task.blockedBy.map((id) => `#${id}`).join(',')}` : null
}

export function TodoTracker({ tasks }: { tasks: TodoTask[] }) {
  const [collapsed, setCollapsed] = useState(false)
  const visible = tasks.filter((task) => task.status !== 'deleted')
  if (visible.length === 0) return null
  const completed = visible.filter((task) => task.status === 'completed').length
  const active = visible.find((task) => task.status === 'in_progress')
  const percent = Math.round((completed / visible.length) * 100)

  return (
    <section className={`todo-tracker${collapsed ? ' is-collapsed' : ''}`} aria-label="Live todos">
      <button type="button" className="todo-tracker__head" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <span className="todo-tracker__pulse" />
        <span className="todo-tracker__label">Todos</span>
        <span className="todo-tracker__count">{completed}/{visible.length}</span>
        <span className="todo-tracker__meter"><span style={{ width: `${percent}%` }} /></span>
        <span className="todo-tracker__chevron">{collapsed ? '⌄' : '⌃'}</span>
      </button>
      {!collapsed && (
        <div className="todo-tracker__body">
          {visible.map((task, index) => (
            <div className={`todo-tracker__task is-${task.status}`} key={task.id}>
              <span className="todo-tracker__branch">{index === visible.length - 1 ? '└─' : '├─'}</span>
              <span className="todo-tracker__status">{taskGlyph(task)}</span>
              <span className="todo-tracker__id">#{task.id}</span>
              <span className={task.status === 'completed' ? 'todo-tracker__subject is-done' : 'todo-tracker__subject'}>{task.subject}</span>
              {task.status === 'in_progress' && task.activeForm && <span className="todo-tracker__active">{task.activeForm}</span>}
              {dependencyLabel(task) && <span className="todo-tracker__dependency">{dependencyLabel(task)}</span>}
            </div>
          ))}
          {active && <span className="sr-only">Currently working on {active.subject}</span>}
        </div>
      )}
    </section>
  )
}

export function TodoTranscript({ tasks }: { tasks: TodoTask[] }) {
  const visible = tasks.filter((task) => task.status !== 'deleted')
  if (visible.length === 0) return null
  const completed = visible.filter((task) => task.status === 'completed').length
  return (
    <section className="todo-transcript" aria-label="Todos">
      <div className="todo-transcript__head"><span>○</span><span>Todos</span><span>({completed}/{visible.length})</span></div>
      {visible.map((task, index) => (
        <div className={`todo-transcript__task is-${task.status}`} key={task.id}>
          <span className="todo-transcript__branch">{index === visible.length - 1 ? '└─' : '├─'}</span>
          <span className="todo-transcript__status">{taskGlyph(task)}</span>
          <span className="todo-transcript__id">#{task.id}</span>
          <span className={task.status === 'completed' ? 'todo-transcript__subject is-done' : 'todo-transcript__subject'}>{task.subject}</span>
          {dependencyLabel(task) && <span className="todo-transcript__dependency">{dependencyLabel(task)}</span>}
        </div>
      ))}
    </section>
  )
}

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TimelineItem } from './timeline.ts'
import { extractTodos } from './todos.ts'

function user(text: string): TimelineItem {
  return { id: text, kind: 'user', text, timestamp: 1 }
}

function todo(tasks: Array<{ id: number; subject: string; status: 'pending' | 'in_progress' | 'completed' }>): TimelineItem {
  return {
    id: `todo-${tasks.map((task) => `${task.id}:${task.status}`).join(',')}`,
    kind: 'tool',
    name: 'todo',
    args: {},
    details: { tasks },
    output: '',
    status: 'done',
    startedAt: 1,
  }
}

const turn1 = [
  { id: 1, subject: 'Set up worktrees', status: 'completed' as const },
  { id: 2, subject: 'Run 5 tasks', status: 'completed' as const },
  { id: 3, subject: 'Collect logs', status: 'completed' as const },
  { id: 4, subject: 'Analyze waste', status: 'in_progress' as const },
]

describe('extractTodos', () => {
  it('hides the previous turn after a new prompt with no new todo writes', () => {
    const items = [user('first'), todo(turn1), user('second prompt')]
    assert.deepEqual(extractTodos(items), [])
  })

  it('shows only tasks created this turn, not leftover completed ones', () => {
    const items = [
      user('first'),
      todo(turn1.map((task) => ({ ...task, status: 'completed' as const }))),
      user('second prompt'),
      todo([
        ...turn1.map((task) => ({ ...task, status: 'completed' as const })),
        { id: 5, subject: 'Write the report', status: 'in_progress' as const },
      ]),
    ]
    const todos = extractTodos(items)
    assert.deepEqual(todos.map((task) => task.id), [5])
    assert.equal(todos[0]?.subject, 'Write the report')
  })

  it('force-completes leftover in-progress tasks when the turn was interrupted', () => {
    const items = [user('first'), todo(turn1)]
    const todos = extractTodos(items, { turnComplete: true })
    assert.equal(todos.length, 4)
    assert.equal(todos[3]?.status, 'completed')
    assert.equal(todos[3]?.subject, 'Analyze waste')
  })

  it('keeps live in-progress tasks while the turn is still running', () => {
    const items = [user('first'), todo(turn1)]
    const todos = extractTodos(items, { turnComplete: false })
    assert.equal(todos[3]?.status, 'in_progress')
  })
})

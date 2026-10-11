// What the session is doing: subagents and task lists, as the router observes
// them through `agent.spawn`, `turn.step`, `tool.call` and `turn.complete`.
// Pure. Tracked in every routing state, OFF included: it only displays.
//
// Progress is never invented. A task list's bar is completed over total; an
// agent's bar is its own task list when it keeps one, and otherwise the band
// shows its activity (steps, tool calls, tokens, time) without a percentage.

import type { Activity, AgentActivity, TaskItem, Tokens } from '../types'
import { addTokens, zeroTokens } from './accounting'

export const MAIN = 'main'

export function emptyActivity(): Activity {
  return { agents: {}, tasks: [], todos: {}, listStarted: {}, context: null, lastRequestAt: null, dismissed: [], compactions: 0, savingsMark: null, lastAutoCompactAt: null }
}

type Status = TaskItem['status']

function status(value: unknown): Status | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
}

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : ''
}

/** Carries timestamps across a status change: started when first in progress, completed when first done. */
function stamp(prev: TaskItem | undefined, next: TaskItem, now: number): TaskItem {
  const startedAt = prev?.startedAt ?? (next.status !== 'pending' ? now : undefined)
  const completedAt = next.status === 'completed' ? prev?.completedAt ?? now : undefined
  return { ...next, ...(startedAt !== undefined ? { startedAt } : {}), ...(completedAt !== undefined ? { completedAt } : {}) }
}

function started(a: Activity, key: string, list: TaskItem[], now: number): Record<string, number> {
  if (list.length === 0) {
    const { [key]: _gone, ...rest } = a.listStarted
    return rest
  }
  return a.listStarted[key] !== undefined ? a.listStarted : { ...a.listStarted, [key]: now }
}

/** TodoWrite sends the whole list each time: it replaces the scope's list. */
export function applyTodoWrite(a: Activity, scope: string, input: unknown, now = 0): Activity {
  const todos = (input as { todos?: unknown })?.todos
  if (!Array.isArray(todos)) return a
  // TodoWrite items have no ids: match the previous list by subject to keep timestamps.
  const before = new Map((a.todos[scope] ?? []).map(t => [t.subject, t]))
  const list: TaskItem[] = []
  todos.slice(0, 100).forEach((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>
    const st = status(o.status)
    const subject = text(o.content)
    if (!st || !subject) return
    const activeForm = text(o.activeForm)
    list.push(stamp(before.get(subject), { id: `todo-${i}`, subject, status: st, ...(activeForm ? { activeForm } : {}) }, now))
  })
  return { ...a, todos: { ...a.todos, [scope]: list }, listStarted: started(a, scope, list, now) }
}

/** TaskCreate adds a pending task under the id the tool returned. */
export function applyTaskCreate(a: Activity, input: unknown, result: unknown, now = 0): Activity {
  const task = (result as { task?: { id?: unknown; subject?: unknown } })?.task
  const i = (input ?? {}) as Record<string, unknown>
  const id = text(task?.id, 60)
  const subject = text(task?.subject) || text(i.subject)
  if (!id || !subject) return a
  const activeForm = text(i.activeForm)
  const item: TaskItem = { id, subject, status: 'pending', ...(activeForm ? { activeForm } : {}) }
  const tasks = [...a.tasks.filter(t => t.id !== id), item].slice(-100)
  return { ...a, tasks, listStarted: started(a, 'tasks', tasks, now) }
}

/** TaskUpdate changes one task; `deleted` removes it. */
export function applyTaskUpdate(a: Activity, input: unknown, now = 0): Activity {
  const i = (input ?? {}) as Record<string, unknown>
  const id = text(i.taskId, 60)
  if (!id) return a
  if (i.status === 'deleted') {
    const tasks = a.tasks.filter(t => t.id !== id)
    return { ...a, tasks, listStarted: started(a, 'tasks', tasks, now) }
  }
  const st = status(i.status)
  const subject = text(i.subject)
  const activeForm = text(i.activeForm)
  const known = a.tasks.some(t => t.id === id)
  if (!known) {
    if (!subject) return a
    const tasks = [...a.tasks, stamp(undefined, { id, subject, status: st ?? 'pending', ...(activeForm ? { activeForm } : {}) }, now)].slice(-100)
    return { ...a, tasks, listStarted: started(a, 'tasks', tasks, now) }
  }
  return {
    ...a,
    tasks: a.tasks.map(t =>
      t.id === id ? stamp(t, { ...t, ...(st ? { status: st } : {}), ...(subject ? { subject } : {}), ...(activeForm ? { activeForm } : {}) }, now) : t,
    ),
  }
}

/** TaskList's result is the authoritative list: it replaces ours, keeping known spinner texts. */
export function applyTaskList(a: Activity, result: unknown, now = 0): Activity {
  const tasks = (result as { tasks?: unknown })?.tasks
  if (!Array.isArray(tasks)) return a
  const before = new Map(a.tasks.map(t => [t.id, t]))
  const list: TaskItem[] = []
  for (const t of tasks.slice(0, 100)) {
    const o = (t ?? {}) as Record<string, unknown>
    const id = text(o.id, 60)
    const subject = text(o.subject)
    const st = status(o.status)
    if (!id || !subject || !st) continue
    const prev = before.get(id)
    const activeForm = prev?.activeForm
    list.push(stamp(prev, { id, subject, status: st, ...(activeForm ? { activeForm } : {}) }, now))
  }
  return { ...a, tasks: list, listStarted: started(a, 'tasks', list, now) }
}

export type TaskProgress = { done: number; total: number; current: string | null }

/** The list a scope shows: the session-wide task list for the main loop when it has one, else its TodoWrite list. */
export function taskList(a: Activity, scope: string): TaskItem[] {
  if (scope === MAIN && a.tasks.length > 0) return a.tasks
  return a.todos[scope] ?? []
}

/** When the list `taskList` returns for a scope first had items. */
export function listStartedAt(a: Activity, scope: string): number | null {
  if (scope === MAIN && a.tasks.length > 0) return a.listStarted.tasks ?? null
  return a.listStarted[scope] ?? null
}

export function progress(list: TaskItem[]): TaskProgress | null {
  if (list.length === 0) return null
  const current = list.find(t => t.status === 'in_progress')
  return {
    done: list.filter(t => t.status === 'completed').length,
    total: list.length,
    current: current ? current.activeForm ?? current.subject : null,
  }
}

// --- agents ------------------------------------------------------------------

export function startAgent(
  a: Activity,
  args: { id: string; description: string; type: string; model: string | null; at: number; phaseId: string | null; background: boolean },
): Activity {
  const agent: AgentActivity = {
    id: args.id,
    description: text(args.description, 80) || args.type,
    type: text(args.type, 40),
    model: args.model,
    status: 'running',
    startedAt: args.at,
    endedAt: null,
    steps: 0,
    tools: 0,
    tokens: zeroTokens(),
    unknown: 0,
    phaseId: args.phaseId,
    background: args.background,
  }
  const agents = { ...a.agents, [args.id]: agent }
  const ids = Object.keys(agents)
  for (const id of ids.slice(0, Math.max(0, ids.length - 40))) delete agents[id]
  return { ...a, agents }
}

function patchAgent(a: Activity, id: string, change: (g: AgentActivity) => AgentActivity): Activity {
  const g = a.agents[id]
  return g ? { ...a, agents: { ...a.agents, [id]: change(g) } } : a
}

export function agentStep(a: Activity, id: string, usage: Tokens | null, observedModel: string | null): Activity {
  return patchAgent(a, id, g => ({
    ...g,
    steps: g.steps + 1,
    tokens: usage ? addTokens(g.tokens, usage) : g.tokens,
    unknown: g.unknown + (usage ? 0 : 1),
    model: observedModel ?? g.model,
  }))
}

export function agentTool(a: Activity, id: string): Activity {
  return patchAgent(a, id, g => ({ ...g, tools: g.tools + 1 }))
}

/** A subagent's run ended: answered (done), an API error (failed), or interrupted (stopped). */
export function endAgent(a: Activity, id: string, reason: string, at: number): Activity {
  const st: AgentActivity['status'] = reason === 'error' ? 'failed' : reason === 'aborted' ? 'stopped' : 'done'
  return patchAgent(a, id, g => ({ ...g, status: st, endedAt: at }))
}

export type AgentSummary = { running: number; done: number; failed: number; total: number }

/** The agents of the current phase (or the latest ones, when the phase spawned none). */
export function phaseAgents(a: Activity, phaseId: string | null): AgentActivity[] {
  const all = Object.values(a.agents)
  const mine = all.filter(g => g.phaseId === phaseId)
  return (mine.length > 0 ? mine : all.filter(g => g.status === 'running')).sort((x, y) => x.startedAt - y.startedAt)
}

export function agentSummary(list: AgentActivity[]): AgentSummary | null {
  if (list.length === 0) return null
  return {
    running: list.filter(g => g.status === 'running').length,
    done: list.filter(g => g.status === 'done').length,
    failed: list.filter(g => g.status === 'failed' || g.status === 'stopped').length,
    total: list.length,
  }
}

// Completion estimates for task lists and subagents. Pure.
//
// Every estimate comes from something observed, and says what:
// - a task list: the pace of its own completed items (time per finished
//   item), with the item in progress credited for the time it has run;
// - a subagent with a task list of its own: the same;
// - a subagent without one: how long finished runs of the same agent type
//   took on this machine (at least three of them).
// With nothing to go on there is no number: "estimating" until the first item
// finishes, live activity for an agent type never seen finish. An agent past
// its usual time is "longer than usual", never a countdown below zero, and
// nothing reads 100% until it has actually finished.

import type { AgentActivity, AgentStats, TaskItem } from '../types'

export const MIN_HISTORY = 3
const KEEP = 30
const RUNNING_CAP = 0.95

export type Estimate = {
  /** Fraction complete, 0..1; null when there is no honest way to say. */
  fraction: number | null
  status: 'estimating' | 'estimate' | 'overdue' | 'done' | 'no-history'
  /** Estimated time left (ms) and finish time (epoch ms), when status is `estimate`. */
  remainingMs: number | null
  etaMs: number | null
  /** What the estimate rests on, in words. */
  basis: string
}

export function median(values: readonly number[]): number | null {
  const v = values.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * A task list's progress and time left, from its own pace: elapsed time up to
 * the last completion over the number completed. The item in progress is
 * credited for the time it has already run (never below a quarter item).
 */
export function taskEstimate(list: readonly TaskItem[], startedAt: number | null, now: number): Estimate | null {
  const total = list.length
  if (total === 0) return null
  const done = list.filter(t => t.status === 'completed').length
  const fraction = done / total
  if (done === total) return { fraction: 1, status: 'done', remainingMs: 0, etaMs: null, basis: `all ${total} done` }
  const start = startedAt ?? Math.min(...list.map(t => t.startedAt ?? Infinity))
  // Only completions seen after the list began set the pace: items already
  // finished when the list was first seen say nothing about how long one takes.
  const completions = list
    .map(t => t.completedAt)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(start) && n > start)
  if (done === 0 || completions.length === 0 || !Number.isFinite(start)) {
    return { fraction, status: 'estimating', remainingMs: null, etaMs: null, basis: 'time left is estimated after the first task finishes' }
  }
  const last = Math.max(...completions)
  const perItem = Math.max(1, (last - start) / completions.length)
  const left = total - done
  const currentRun = Math.max(0, now - last)
  const remainingMs = Math.max(perItem * 0.25, perItem - currentRun) + (left - 1) * perItem
  return {
    fraction,
    status: 'estimate',
    remainingMs,
    etaMs: now + remainingMs,
    basis: `${done} of ${total} done, about ${duration(perItem)} per task so far (from ${completions.length} timed)`,
  }
}

/** Records one finished run of an agent type (done runs only), bounded. */
export function recordRun(stats: AgentStats, type: string, durationMs: number, steps: number): AgentStats {
  if (!type || !Number.isFinite(durationMs) || durationMs <= 0) return stats
  const prev = stats[type] ?? { durations: [], steps: [] }
  const next = { ...stats, [type]: { durations: [...prev.durations, Math.round(durationMs)].slice(-KEEP), steps: [...prev.steps, steps].slice(-KEEP) } }
  const types = Object.keys(next)
  for (const t of types.slice(0, Math.max(0, types.length - 40))) delete next[t]
  return next
}

/**
 * A subagent's progress. Its own task list when it keeps one; otherwise the
 * typical duration of this agent type's finished runs. Capped below 100%
 * until it finishes; past the typical duration it is "longer than usual".
 */
export function agentEstimate(agent: AgentActivity, ownList: readonly TaskItem[], ownListStarted: number | null, stats: AgentStats, now: number): Estimate {
  if (agent.status !== 'running') {
    const took = agent.endedAt !== null ? duration(agent.endedAt - agent.startedAt) : 'unknown time'
    return { fraction: agent.status === 'done' ? 1 : null, status: 'done', remainingMs: 0, etaMs: null, basis: `${agent.status} after ${took}` }
  }
  if (ownList.length > 0) {
    const t = taskEstimate(ownList, ownListStarted ?? agent.startedAt, now)
    if (t) return { ...t, fraction: t.fraction !== null ? Math.min(t.fraction, RUNNING_CAP) : null, status: t.status === 'done' ? 'estimating' : t.status }
  }
  const history = stats[agent.type]
  const typical = history && history.durations.length >= MIN_HISTORY ? median(history.durations) : null
  const elapsed = Math.max(0, now - agent.startedAt)
  if (typical === null || typical <= 0) {
    const n = history?.durations.length ?? 0
    return {
      fraction: null,
      status: 'no-history',
      remainingMs: null,
      etaMs: null,
      basis: n === 0 ? `no finished ${agent.type} runs yet to estimate from` : `${n} finished ${agent.type} run(s) so far; estimates start at ${MIN_HISTORY}`,
    }
  }
  const runs = history?.durations.length ?? 0
  if (elapsed > typical) {
    return {
      fraction: RUNNING_CAP,
      status: 'overdue',
      remainingMs: null,
      etaMs: null,
      basis: `longer than usual: ${agent.type} runs typically take ${duration(typical)} (${runs} past runs)`,
    }
  }
  const remainingMs = typical - elapsed
  return {
    fraction: Math.min(RUNNING_CAP, elapsed / typical),
    status: 'estimate',
    remainingMs,
    etaMs: now + remainingMs,
    basis: `typical ${agent.type} run ${duration(typical)}, from ${runs} past runs`,
  }
}

/** When every running agent should be done: the latest estimate, or null if any has none. */
export function overallAgentEta(estimates: readonly Estimate[]): { remainingMs: number; etaMs: number } | null {
  const running = estimates.filter(e => e.status !== 'done')
  if (running.length === 0 || running.some(e => e.status !== 'estimate' || e.etaMs === null || e.remainingMs === null)) return null
  const last = running.reduce((a, b) => ((a.etaMs as number) >= (b.etaMs as number) ? a : b))
  return { remainingMs: last.remainingMs as number, etaMs: last.etaMs as number }
}

/** `~3m10s left · done ~14:32 (est.)`, the short form the band and pane show. */
export function etaText(e: { remainingMs: number | null; etaMs: number | null } | null): string | null {
  if (!e || e.remainingMs === null || e.etaMs === null) return null
  const d = new Date(e.etaMs)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `~${duration(e.remainingMs)} left · done ~${hhmm} (est.)`
}

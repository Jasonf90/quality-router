// Recommendations: when to compact, when a fresh session would be cheaper,
// when the weekly pace is a problem, when routing would help. Pure.
//
// Every figure a recommendation quotes is observed (the context fill Claude
// Code reports, the prompt tokens the API reported for the last request) or
// is labelled as an estimate. Nothing here acts: the band offers a button,
// and the person decides.

import type { Recommendation, RouterMode, RouterState } from '../types'
import { compact } from './accounting'
import { formatWhen, type Projection } from './limits'

export type AdviceInput = {
  state: RouterState
  mode: RouterMode
  /** Context fill as Claude Code reports it (0-100), when known. */
  contextPercent: number | null
  /** Prompt tokens of the last main request: what each request currently re-sends. */
  promptTokens: number
  isWorking: boolean
  /** Time since the last model request ended; null when none has run. */
  idleMs: number | null
  /** How long the prompt cache lasts (the inferred or configured lifetime); 5 minutes when not given. */
  cacheTtlMs?: number
  /** The window Claude Code compacts against (the model's limit, or CLAUDE_CODE_AUTO_COMPACT_WINDOW), when known. */
  contextWindow?: number | null
  /** Verdict of the current phase's checks against the current code. */
  phaseVerdict: 'verified' | 'failed' | 'unverified'
  /** Context the current phase inherited from earlier ones, and how many came before it. */
  phaseStartContext: number
  phaseOrdinal: number
  weekly: Projection | null
  /** Dry run: estimated list-price difference had the proposals been applied (same volumes). */
  potential: { usd: number; percent: number | null } | null
  dismissed: readonly string[]
  /** The current phase began with a plan-step prompt ("start phase 3"). */
  planPrompt?: boolean
  /** The current task list is complete. */
  tasksDone?: boolean
}

const SEVERITY: Record<Recommendation['severity'], number> = { urgent: 0, warn: 1, info: 2 }

export const LIMITS = {
  contextHigh: 70,
  contextCritical: 90,
  /** Absolute sizes: on a 1M-token window, percentages alone come far too late. */
  compactBetweenPhases: 150_000,
  largePrompt: 250_000,
  hugePrompt: 500_000,
  freshAfterVerified: 40_000,
  inheritedContext: 60_000,
  idleMs: 5 * 60_000,
  idleContext: 30_000,
  longSessionPhases: 5,
  longSessionContext: 80_000,
}

export function recommend(i: AdviceInput): Recommendation[] {
  const out: Recommendation[] = []
  const k = compact(i.promptTokens)
  const pct = i.contextPercent

  // Between plan phases on a large context: the cheapest moment to compact,
  // and compaction keeps the plan the next phase depends on.
  if (!i.isWorking && i.promptTokens >= LIMITS.compactBetweenPhases && (i.planPrompt || i.tasksDone || i.phaseVerdict === 'verified')) {
    out.push({
      id: 'compact-before-next-phase',
      severity: i.promptTokens >= LIMITS.hugePrompt ? 'urgent' : 'warn',
      title: `Before the next phase: compact (${k} tokens re-sent per request)`,
      detail: `Every request in the next phase would re-send about ${k} tokens. Compacting keeps the plan, what is done and what comes next, and drops the rest, so the next phase starts at a fraction of that. Compaction runs between turns, so now is the moment.`,
      action: 'compact',
    })
  }
  if (i.promptTokens >= LIMITS.largePrompt) {
    out.push({
      id: i.promptTokens >= LIMITS.hugePrompt ? 'prompt-huge' : 'prompt-large',
      severity: i.promptTokens >= LIMITS.hugePrompt ? 'urgent' : 'warn',
      title: `Each request re-sends ${k} tokens: compact ${i.promptTokens >= LIMITS.hugePrompt ? 'now' : 'soon'}`,
      detail: `That is the size of the last request's prompt, as reported. Most of it is earlier work. Compacting keeps the current task${i.planPrompt ? ' and the plan' : ''} and cuts what every request carries${i.isWorking ? '; it can run when this turn ends' : ''}.`,
      action: 'compact',
    })
  }

  if (pct !== null && pct >= LIMITS.contextCritical) {
    out.push({
      id: 'context-critical',
      severity: 'urgent',
      title: `Context ${pct}% full: compact now`,
      detail: 'Claude Code will auto-compact soon and decide on its own what to keep. Compacting now, with the current task as the focus, keeps what matters.',
      action: 'compact',
    })
  } else if (pct !== null && pct >= LIMITS.contextHigh) {
    out.push({
      id: 'context-high',
      severity: 'warn',
      title: `Context ${pct}% full: compact soon`,
      detail: `Each request re-sends about ${k} tokens (as reported for the last request). Compacting keeps the current task and drops older detail.`,
      action: 'compact',
    })
  }

  if (i.phaseOrdinal > 0 && i.phaseStartContext >= LIMITS.inheritedContext && !i.isWorking) {
    out.push(
      i.planPrompt
        ? {
            id: 'new-task-old-context',
            severity: 'warn',
            title: `This phase started on ${compact(i.phaseStartContext)} tokens of earlier phases`,
            detail: 'A plan step builds on the plan, so compact rather than start fresh: compaction keeps the plan and progress and drops the detail of finished phases.',
            action: 'compact',
          }
        : {
            id: 'new-task-old-context',
            severity: 'warn',
            title: `New task on ${compact(i.phaseStartContext)} tokens of earlier context`,
            detail: 'If this task does not depend on the earlier ones, a new session stops re-sending their history with every request. If it does depend on them, compact instead.',
            action: 'new-session',
          },
    )
  }

  if (i.phaseVerdict === 'verified' && i.promptTokens >= LIMITS.freshAfterVerified && !i.isWorking) {
    out.push({
      id: 'task-verified',
      severity: 'info',
      title: 'Checks passed: start fresh for the next task',
      detail: `An unrelated next request would re-send about ${k} tokens of this task's history each time. A new session starts that at almost nothing.`,
      action: 'new-session',
    })
  }

  const ttlMs = i.cacheTtlMs ?? LIMITS.idleMs
  if (i.idleMs !== null && i.idleMs >= ttlMs && i.promptTokens >= LIMITS.idleContext && !i.isWorking) {
    const minutes = Math.round(i.idleMs / 60_000)
    const lasts = ttlMs >= 3_600_000 ? 'an hour' : `${Math.round(ttlMs / 60_000)} minutes`
    out.push({
      id: 'cache-cold',
      severity: 'info',
      title: `Idle ${minutes} min: the prompt cache may have expired`,
      detail: `The prompt cache lasts ${lasts} here, so it has likely lapsed: your next message re-writes about ${k} tokens to it either way. Switching tasks? Now is the cheapest moment to compact or start a new session.`,
      action: 'new-session',
    })
  }

  if (i.phaseOrdinal + 1 >= LIMITS.longSessionPhases && i.promptTokens >= LIMITS.longSessionContext && !i.isWorking) {
    out.push({
      id: 'long-session',
      severity: 'info',
      title: `${i.phaseOrdinal + 1} tasks in one session`,
      detail: `Every request carries about ${k} tokens of all of them. One session per task keeps requests small.`,
      action: 'new-session',
    })
  }

  // The router compacts only between turns; Claude Code's own compaction can
  // run mid-turn, but by default only near a 1M window. A long stretch of work
  // past 500k means the default is costing far more than it needs to.
  if (i.promptTokens >= 500_000 && (i.contextWindow ?? 1_000_000) >= 900_000) {
    out.push({
      id: 'compact-window',
      severity: 'warn',
      title: `Conversations grow to ${k} inside long turns: let Claude Code compact sooner`,
      detail: 'The router can compact only when a turn ends. Setting CLAUDE_CODE_AUTO_COMPACT_WINDOW=450000 in the env block of ~/.claude/settings.json makes Claude Code compact on its own at about 417k, mid-turn too, with the router\'s summary instructions. On recorded long sessions that cut cost by a further 1-35 percentage points.',
      action: null,
    })
  }

  const w = i.weekly
  if (w && w.status === 'projected' && w.etaMs !== null) {
    out.push({
      id: 'weekly-pace',
      severity: 'warn',
      title: `Weekly limit projected ${formatWhen(w.etaMs)} (estimate)`,
      detail: `At the recent pace (${w.percentUsed}% used) the weekly window would fill before it resets. Economy mode and fresher sessions slow the pace.`,
      action: i.mode === 'economy' ? null : 'economy',
    })
  }

  if (i.state !== 'on' && i.potential && i.potential.usd >= 0.1) {
    const pctText = i.potential.percent !== null ? ` (${i.potential.percent}%)` : ''
    out.push({
      id: 'dry-run-potential',
      severity: 'info',
      title: `Routing could have cost est. $${i.potential.usd.toFixed(2)} less${pctText} this session`,
      detail: 'Estimate: the same recorded token volumes priced at the models the router proposed, at list prices. Actual use on other models can differ.',
      action: 'enable',
    })
  }

  // One compaction suggestion is enough: keep the most pressing.
  const visible = out.filter(r => !i.dismissed.includes(r.id)).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])
  const firstCompact = visible.find(r => r.action === 'compact')
  return visible.filter(r => r.action !== 'compact' || r === firstCompact)
}

export const AUTO_COMPACT_COOLDOWN_MS = 10 * 60_000

/**
 * Smart auto-compaction: when to compact now that a main-loop turn has ended.
 *
 * - 'boundary': the prompt has reached the boundary size and the work in hand
 *   is finished: committed during this turn, its checks passing against the
 *   current code, or its task list complete; and no check failing. The least
 *   that a summary can lose, and the next task starts small.
 * - 'ceiling': the prompt has passed the ceiling, finished or not, so a long
 *   task cannot grow without limit.
 *
 * Never mid-turn, after an interrupted or failed turn, while a subagent runs,
 * or within ten minutes of the last time. Null when none of this holds.
 */
export function smartCompactDue(i: {
  state: RouterState
  smart: 'off' | 'watch' | 'on'
  promptTokens: number
  turnReason: string
  agentsRunning: number
  lastAt: number | null
  now: number
  boundaryTokens: number
  ceilingTokens: number
  /** The work in hand is finished: committed this turn, checks passing, or its task list complete. */
  finished: boolean
  failingCheck: boolean
}): 'boundary' | 'ceiling' | null {
  if (i.state !== 'on' || i.smart === 'off') return null
  if (i.turnReason !== 'answer' || i.agentsRunning > 0) return null
  if (i.lastAt !== null && i.now - i.lastAt < AUTO_COMPACT_COOLDOWN_MS) return null
  if (i.promptTokens >= i.ceilingTokens) return 'ceiling'
  if (i.promptTokens >= i.boundaryTokens && i.finished && !i.failingCheck) return 'boundary'
  return null
}

/** What watching smart auto-compact has shown so far, in a few lines. */
export function watchReport(obs: readonly { at: number; tokens: number; smart: 'boundary' | 'ceiling' | null; plain: boolean; midTask: boolean }[]): string[] {
  if (obs.length === 0) return ['No moments recorded yet: smart auto-compact notes a moment when a turn ends at a task boundary past the boundary size, or past the ceiling.']
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const boundary = obs.filter(o => o.smart === 'boundary')
  const ceiling = obs.filter(o => o.smart === 'ceiling')
  const plain = obs.filter(o => o.plain)
  const plainMid = plain.filter(o => o.midTask)
  const lines = [
    `Smart would have compacted ${boundary.length + ceiling.length} time(s): ${boundary.length} when work is finished${boundary.length ? ` (at ${boundary.map(o => k(o.tokens)).join(', ')})` : ''}, ${ceiling.length} past the ceiling${ceiling.length ? ` (at ${ceiling.map(o => k(o.tokens)).join(', ')})` : ''}.`,
    `The plain threshold compacted ${plain.length} time(s)${plain.length ? `, ${plainMid.length} of them with work unfinished (no commit, no passing checks or done task list, or a check failing)` : ''}.`,
  ]
  return lines
}

/**
 * Whether to compact on our own now that a main-loop turn has ended: routing
 * ON, the person set a threshold, the prompt reached it, the turn finished
 * normally (not interrupted or failed), no subagent is still running, and the
 * last automatic compaction was more than ten minutes ago.
 */
export function autoCompactDue(i: {
  state: RouterState
  threshold: number | null
  promptTokens: number
  turnReason: string
  agentsRunning: number
  lastAutoCompactAt: number | null
  now: number
}): boolean {
  if (i.state !== 'on' || i.threshold === null) return false
  if (i.promptTokens < i.threshold) return false
  if (i.turnReason !== 'answer') return false
  if (i.agentsRunning > 0) return false
  if (i.lastAutoCompactAt !== null && i.now - i.lastAutoCompactAt < AUTO_COMPACT_COOLDOWN_MS) return false
  return true
}

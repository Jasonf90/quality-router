// Automatic effort: how hard the model thinks on a request. Pure.
//
// The goal is fewer thinking tokens where thinking does not change the
// result, and never at the expense of the result. So the policy works
// relative to the person's own session effort (what they chose with /effort)
// and is lopsided on purpose:
//
// - It LOWERS effort only for narrow work where deep reasoning adds nothing
//   (mechanical edits, look-ups, summaries, classification), and only when the
//   risk is low, the task is unambiguous, the router is confident about it,
//   nothing has escalated and no check has failed in the task.
// - It never lowers effort for writing or fixing code (implement, debug,
//   test, refactor, review): those keep the session's effort.
// - It RAISES effort where quality is at stake (high risk, architecture, hard
//   diagnosis, broad changes in quality-first mode) and after repeated failed
//   repairs, alongside the stronger model.
//
// A per-tier effort the person set always wins; with automatic effort off, or
// when the session carries no effort level, nothing is changed.

import type { Analysis, Effort, Prefs, RouterMode, Tier } from '../types'
import { EFFORTS, effortRank, isEffort } from './settings'

export type EffortChoice = {
  effort?: Effort
  effortSource?: 'auto' | 'preference'
  effortReason?: string
}

export type EffortInput = {
  prefs: Prefs
  analysis: Analysis
  tier: Tier
  /** The decision's own confidence (rules or classifier). */
  confidence: number
  /** The decision fell back after a failed classifier call. */
  fallback: boolean
  escalations: number
  /** A check failed in this task: no lowering for the rest of it. */
  phaseFailed: boolean
  /** The session's own effort for this request, as the engine resolved it; null when none. */
  sessionEffort: string | null
  /**
   * A large prompt the cache still holds: effort is not lowered (a change may
   * re-send the prompt uncached, which would cost more than it saves). Raising
   * for quality is unaffected.
   */
  holdLowering?: boolean
}

/** Narrow work where deeper reasoning does not change the result. */
const LIGHT_WORK = ['mechanical', 'extraction', 'summarize', 'classify'] as const
/** Read-only or prose work that may go one step lower outside quality-first. */
const PROSE_WORK = ['docs', 'question'] as const

/** In quality-first, critical work gets at least this much effort; in balanced, at least medium. */
const CRITICAL_FLOOR: Record<RouterMode, Effort | null> = {
  'quality-first': 'high',
  balanced: 'medium',
  economy: null,
}

function step(e: Effort, by: number, lowest: Effort = 'low', highest: Effort = 'max'): Effort {
  const i = Math.max(effortRank(lowest), Math.min(effortRank(highest), effortRank(e) + by))
  return EFFORTS[i] ?? e
}

function atLeast(e: Effort, floor: Effort): Effort {
  return effortRank(e) >= effortRank(floor) ? e : floor
}

export function chooseEffort(i: EffortInput): EffortChoice {
  const pref = i.prefs.effort[i.tier]
  if (pref) return { effort: pref, effortSource: 'preference', effortReason: `your ${i.tier}-tier setting` }
  if (!i.prefs.autoEffort) return {}
  // A numeric budget or no effort at all: the router does not guess what it means.
  if (!isEffort(i.sessionEffort)) return {}
  const base: Effort = i.sessionEffort
  const a = i.analysis
  const mode = i.prefs.mode

  const choose = (target: Effort, reason: string): EffortChoice =>
    target === base ? {} : { effort: target, effortSource: 'auto', effortReason: reason }

  // Repeated failed repairs: think harder, alongside the stronger model. The
  // automatic raise stops at xhigh, but never below the session's own level
  // (a session at max stays at max).
  if (i.escalations > 0) {
    return choose(atLeast(atLeast(step(base, i.escalations, 'low', 'xhigh'), 'high'), base), 'raised after failed repairs')
  }

  const critical =
    a.risk === 'high' ||
    a.category === 'architecture' ||
    a.category === 'diagnosis' ||
    (a.category === 'review' && i.tier === 'strong') ||
    a.breadth === 'broad'
  if (critical) {
    const floor = CRITICAL_FLOOR[mode]
    return floor ? choose(atLeast(base, floor), a.risk === 'high' ? 'raised for high-risk work' : `raised for ${a.category === 'unknown' ? 'broad' : a.category} work`) : {}
  }

  // Anything uncertain keeps the session's effort: never lower on a guess.
  const uncertain = i.fallback || a.ambiguity !== 'low' || a.risk !== 'low' || i.phaseFailed
  if (uncertain) return {}
  // A large prompt still in the cache: lowering effort could cost more than it saves.
  if (i.holdLowering) return {}

  if ((LIGHT_WORK as readonly string[]).includes(a.category) && i.confidence >= 0.8) {
    const target = mode === 'quality-first' ? step(base, -1) : 'low'
    return choose(target, `lowered for ${a.category === 'mechanical' ? 'a mechanical change' : a.category}`)
  }
  if ((PROSE_WORK as readonly string[]).includes(a.category) && mode !== 'quality-first' && i.confidence >= 0.7) {
    return choose(step(base, -1), `lowered for ${a.category === 'docs' ? 'docs' : 'a read-only question'}`)
  }
  // Writing or fixing code: the session's effort, unchanged.
  return {}
}

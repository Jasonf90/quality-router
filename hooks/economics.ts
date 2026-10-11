// Does switching the main conversation's model pay for itself? Pure.
//
// Switching models mid-conversation throws away the prompt cache: the new
// model writes the whole prompt to its cache, and going back later makes the
// old one write it again. A cheaper model only saves on each later request
// (cheaper cache reads and output). So a switch pays when the phase is long
// enough for the per-request saving to repay that one-time cost.
//
// Every number is either a list price (dated, sourced: settings.ts) or an
// observation from this session; the result says which it used. With no
// price for either model it returns `pays: null` and the caller falls back to
// the plain prompt-size rule.

import type { ModelPrice, Prefs, PriceRow, Tokens } from '../types'
import { promptTokens } from './accounting'
import { findPrice } from './savings'
import { cacheTtlOf } from './settings'

export type SwitchInput = {
  prefs: Prefs
  /** The model the conversation is on now (its cache holds the prompt when warm). */
  fromModel: string
  toModel: string
  /** Prompt tokens of the last request: what a switch re-sends uncached. */
  promptTokens: number
  /** Requests still expected in this phase (median of this session's phases, or a default). */
  expectedRequests: number
  expectedSource: 'history' | 'default'
  /** Average output tokens per main request this session. */
  avgOutput: number
  /** Whether the current model's cache still holds the prompt (last request within the TTL). */
  cacheWarm: boolean
}

export type SwitchVerdict = {
  pays: boolean | null
  /** Requests needed to repay the switch; null when it never pays or prices are missing. */
  breakEven: number | null
  oneTimeUsd: number
  perRequestUsd: number
  reason: string
}

function writePrice(p: PriceRow, ttl: '5m' | '1h'): number {
  return ttl === '1h' ? p.cacheWrite1h : p.cacheWrite5m
}

/** Prices for a request of this size: the long-prompt rate where the list has one. */
function rates(p: ModelPrice, promptTokens: number): PriceRow {
  return promptTokens > 100_000 && p.over100k ? p.over100k : p
}

const MARGIN = 1.5

export function switchPays(i: SwitchInput): SwitchVerdict {
  const from = findPrice(i.fromModel, i.prefs.pricing)
  const to = findPrice(i.toModel, i.prefs.pricing)
  if (!from || !to) {
    const missing = !from ? i.fromModel : i.toModel
    return { pays: null, breakEven: null, oneTimeUsd: 0, perRequestUsd: 0, reason: `no price for ${missing}` }
  }
  const P = i.promptTokens / 1_000_000
  const O = i.avgOutput / 1_000_000
  const a = rates(from.price, i.promptTokens)
  const b = rates(to.price, i.promptTokens)
  const ttl = cacheTtlOf(i.prefs)
  // Warm: switching costs the new model's cache write, and coming back later
  // costs the old model's write again. Cold: staying would write the old
  // model's cache once now; switching writes the new model's now AND the old
  // model's again on the way back, so the new model's whole write is extra.
  const oneTime = i.cacheWarm
    ? P * writePrice(b, ttl) + P * writePrice(a, ttl)
    : P * writePrice(b, ttl)
  const perRequest = P * (a.cacheRead - b.cacheRead) + O * (a.output - b.output)
  if (perRequest <= 0) {
    return { pays: false, breakEven: null, oneTimeUsd: oneTime, perRequestUsd: perRequest, reason: `${i.toModel} is not cheaper per request here` }
  }
  const breakEven = Math.ceil(oneTime / perRequest)
  const pays = breakEven * MARGIN <= i.expectedRequests
  const k = Math.round(i.promptTokens / 1000)
  const expected = `${i.expectedRequests} requests expected${i.expectedSource === 'default' ? ' (default until phases finish)' : ''}`
  const reason = breakEven === 0
    ? `switch pays at once (cache already cold, ${k}k prompt)`
    : `switching pays back after ~${breakEven} requests at ${k}k tokens (${i.cacheWarm ? 'warm' : 'cold'} cache); ${expected}`
  return { pays, breakEven, oneTimeUsd: oneTime, perRequestUsd: perRequest, reason }
}

/** Median requests per finished phase this session, or a default before there are three. */
export function expectedPhaseRequests(finished: readonly number[], soFar: number): { n: number; source: 'history' | 'default' } {
  const done = finished.filter(n => n > 0).sort((x, y) => x - y)
  if (done.length >= 3) {
    const mid = Math.floor(done.length / 2)
    const median = done.length % 2 ? (done[mid] as number) : Math.round(((done[mid - 1] as number) + (done[mid] as number)) / 2)
    return { n: Math.max(3, median - soFar), source: 'history' }
  }
  return { n: Math.max(3, 10 - soFar), source: 'default' }
}

/** What idle gaps have shown about how long the prompt cache lasts. */
export type TtlEvidence = { longReads: number; expiries: number }

export const NO_TTL_EVIDENCE: TtlEvidence = { longReads: 0, expiries: 0 }

/**
 * One main-loop request after an idle gap of 5.5 to 55 minutes on the same
 * model: a large cache read says the cache outlived 5 minutes (the 1-hour
 * cache); writing the whole prompt again says it had expired. Claude Code does
 * not report the lifetime per request, so this is how 'auto' learns it.
 */
export function ttlEvidence(ev: TtlEvidence, gapMs: number, usage: Tokens, sameModel: boolean): TtlEvidence {
  if (!sameModel || gapMs <= 330_000 || gapMs >= 3_300_000) return ev
  const prompt = promptTokens(usage)
  if (prompt < 20_000) return ev
  if (usage.cacheRead >= 0.5 * prompt) return { ...ev, longReads: ev.longReads + 1 }
  if (usage.cacheWrite >= 0.8 * prompt) return { ...ev, expiries: ev.expiries + 1 }
  return ev
}

/** The lifetime to assume: the person's setting, else 5m only on repeated expiries and no long reads, else 1h. */
export function resolveTtl(pref: Prefs['cacheTtl'], ev: TtlEvidence | null): '5m' | '1h' {
  if (pref !== 'auto') return pref
  return ev && ev.expiries >= 2 && ev.longReads === 0 ? '5m' : '1h'
}

// Usage accounting: one record per model request, from the usage the API
// reported for that request. Pure.
//
// Rules this module keeps:
// - The four token categories stay separate everywhere.
// - A request whose usage was not reported is counted as `unknown`, never as
//   zero tokens.
// - Each request is counted once, by its key (turn, loop, step, attempt).
//   Turn and session totals are derived from request records, never added on
//   top of them, so the same tokens cannot be counted twice.

import type { Bucket, Ledger, RequestRecord, Tokens } from '../types'

export const LONG_PROMPT = 100_000

export function zeroTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function emptyBucket(): Bucket {
  return { requests: 0, unknown: 0, tokens: zeroTokens(), over100k: zeroTokens() }
}

export function emptyLedger(sessionId: string, now: number): Ledger {
  return {
    sessionId,
    startedAt: now,
    total: emptyBucket(),
    byModel: {},
    byRole: {},
    byPurpose: {},
    byProposed: {},
    routedRequests: 0,
    effortLowered: 0,
    effortRaised: 0,
    seen: [],
    aborted: 0,
    noResponse: 0,
    turnMismatches: 0,
    engineCostUsd: null,
  }
}

/** The API's four counts, as `turn.step` and `$.model.complete` report them. */
export function fromUsage(u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): Tokens {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  }
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

export function subTokens(a: Tokens, b: Tokens): Tokens {
  const d = (x: number, y: number) => Math.max(0, x - y)
  return { input: d(a.input, b.input), output: d(a.output, b.output), cacheRead: d(a.cacheRead, b.cacheRead), cacheWrite: d(a.cacheWrite, b.cacheWrite) }
}

/** What the request sent as its prompt: uncached input plus cache reads and writes. */
export function promptTokens(t: Tokens): number {
  return t.input + t.cacheRead + t.cacheWrite
}

/**
 * All four categories summed. Shown only beside the categories themselves:
 * cache reads are a small fraction of the input price, so this total is a
 * volume, not a cost.
 */
export function allTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

export function addToBucket(b: Bucket | undefined, usage: Tokens | null): Bucket {
  const base = b ?? emptyBucket()
  if (usage === null) return { ...base, requests: base.requests + 1, unknown: base.unknown + 1 }
  const long = promptTokens(usage) > LONG_PROMPT
  return {
    requests: base.requests + 1,
    unknown: base.unknown,
    tokens: addTokens(base.tokens, usage),
    over100k: long ? addTokens(base.over100k, usage) : base.over100k,
  }
}

/** The label a request is filed under: the model the API said answered. */
export function modelKey(rec: RequestRecord): string {
  if (rec.role === 'classifier') return `${rec.requestedModel} (classifier, as requested)`
  return rec.observedModel ?? `${rec.requestedModel} (unconfirmed)`
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** -1 when the request carried less effort than the session's, 1 when more, 0 otherwise or unknown. */
export function effortShift(rec: RequestRecord): number {
  const sent = rec.effortSent ? EFFORT_ORDER.indexOf(rec.effortSent) : -1
  const session = rec.effortSession ? EFFORT_ORDER.indexOf(rec.effortSession) : -1
  if (sent < 0 || session < 0) return 0
  return Math.sign(sent - session)
}

/** The label a request is filed under on the proposed side: the router's model, else the actual one. */
export function proposedKey(rec: RequestRecord): string {
  return rec.proposedModel ?? modelKey(rec)
}

/**
 * Adds one request. Returns the ledger unchanged (and `added: false`) when the
 * key was already counted: a replayed event, a reload, a duplicate dispatch.
 */
export function addRequest(ledger: Ledger, rec: RequestRecord): { ledger: Ledger; added: boolean } {
  if (ledger.seen.includes(rec.key)) return { ledger, added: false }
  const key = modelKey(rec)
  return {
    added: true,
    ledger: {
      ...ledger,
      seen: [...ledger.seen, rec.key].slice(-400),
      total: addToBucket(ledger.total, rec.usage),
      byModel: { ...ledger.byModel, [key]: addToBucket(ledger.byModel[key], rec.usage) },
      byRole: { ...ledger.byRole, [rec.role]: addToBucket(ledger.byRole[rec.role], rec.usage) },
      byPurpose: { ...ledger.byPurpose, [rec.purpose]: addToBucket(ledger.byPurpose[rec.purpose], rec.usage) },
      byProposed: rec.role === 'classifier' ? ledger.byProposed : { ...ledger.byProposed, [proposedKey(rec)]: addToBucket(ledger.byProposed[proposedKey(rec)], rec.usage) },
      routedRequests: ledger.routedRequests + (rec.routed ? 1 : 0),
      effortLowered: ledger.effortLowered + (effortShift(rec) < 0 ? 1 : 0),
      effortRaised: ledger.effortRaised + (effortShift(rec) > 0 ? 1 : 0),
      aborted: ledger.aborted + (rec.status === 'aborted' ? 1 : 0),
      noResponse: ledger.noResponse + (rec.status === 'no-response' || rec.status === 'failed-fallback' ? 1 : 0),
    },
  }
}

/**
 * Loads a ledger the store kept for this session (a restarted process
 * resuming it). Anything malformed starts a fresh ledger rather than mixing
 * damaged figures into new ones.
 */
export function restoreLedger(raw: unknown, sessionId: string, now: number): Ledger {
  if (raw === null || typeof raw !== 'object') return emptyLedger(sessionId, now)
  const r = raw as Partial<Ledger>
  if (r.sessionId !== sessionId || !r.total || !Array.isArray(r.seen) || typeof r.byModel !== 'object') {
    return emptyLedger(sessionId, now)
  }
  return { ...emptyLedger(sessionId, now), ...r, byProposed: r.byProposed ?? {}, routedRequests: r.routedRequests ?? 0, effortLowered: r.effortLowered ?? 0, effortRaised: r.effortRaised ?? 0 } as Ledger
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

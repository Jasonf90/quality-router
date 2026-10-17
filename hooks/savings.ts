// Savings, reported honestly. Pure. Three separate things, never blended:
//
// A. Observed usage: what the API reported (accounting.ts).
// B. Same-volume pricing estimate: the recorded token volumes priced at each
//    responding model's list price, against the same volumes priced at a
//    baseline model. It does not predict what the baseline would actually
//    have consumed, cached, retried or achieved, nor subscription quota.
// C. Experimental token reduction: separately recorded routed and baseline
//    runs of the same task from the same starting state, compared only when
//    their declared conditions match.
// D. The router's compactions: their estimated cost against the cache reads
//    the smaller conversation avoided. Shown beside routing's estimate, each
//    named, and added to it only where the band gives one figure.

import type { Bucket, CacheAware, CompactionSavings, ExperimentArm, Ledger, ModelPrice, PathSim, Prefs, PriceRow, SavingsEntry, Tokens } from '../types'
import { addTokens, allTokens, emptyBucket, subTokens, zeroTokens } from './accounting'
import { cacheTtlOf } from './settings'

export const ESTIMATE_LABEL = 'Estimated pricing difference — same recorded token volumes'

export const ESTIMATE_CAVEATS = [
  "does not predict the baseline model's actual token use, cache behaviour, attempts or quality",
  'API list prices; not a measure of subscription quota',
]

/** Finds a price: exact id, then the longest configured id the model id starts with. */
export function findPrice(model: string, pricing: Record<string, ModelPrice>): { id: string; price: ModelPrice } | null {
  const plain = model.replace(/\[[^\]]*\]$/, '')
  const exact = pricing[model] ?? pricing[plain]
  if (exact) return { id: pricing[model] ? model : plain, price: exact }
  let best: string | null = null
  for (const id of Object.keys(pricing)) {
    if (plain.startsWith(id) && (best === null || id.length > best.length)) best = id
  }
  return best ? { id: best, price: pricing[best] as ModelPrice } : null
}

function priceTokens(t: Tokens, row: PriceRow, ttl: '5m' | '1h'): number {
  const write = ttl === '1h' ? row.cacheWrite1h : row.cacheWrite5m
  return (t.input * row.input + t.output * row.output + t.cacheRead * row.cacheRead + t.cacheWrite * write) / 1_000_000
}

/** A bucket priced at one model: prompts over 100k tokens at that model's long-prompt rate, if it has one. */
export function priceBucket(b: Bucket, price: ModelPrice, ttl: '5m' | '1h'): number {
  const standard = subTokens(b.tokens, b.over100k)
  return priceTokens(standard, price, ttl) + priceTokens(b.over100k, price.over100k ?? price, ttl)
}

export type SameVolume = {
  status: 'ok' | 'partial' | 'unavailable'
  baselineModel: string
  routedUsd: number
  baselineUsd: number
  /** Baseline minus routed: positive is a lower estimated price, negative a higher one. */
  differenceUsd: number
  classifierUsd: number
  missingPrices: string[]
  unknownRequests: number
  provenance: string[]
  notes: string[]
}

/**
 * Prices the recorded volumes. Routed usage includes the classifier's own
 * calls; the baseline is priced over the same volumes without them, since a
 * baseline run makes no classifier calls. Models without a configured price
 * are left out of both sides and listed.
 */
export function sameVolumeEstimate(ledger: Ledger, prefs: Prefs, sessionModel: string | null): SameVolume {
  const baselineModel = prefs.baselineModel ?? sessionModel ?? prefs.models.strong
  const base = findPrice(baselineModel, prefs.pricing)
  const out: SameVolume = {
    status: 'unavailable',
    baselineModel,
    routedUsd: 0,
    baselineUsd: 0,
    differenceUsd: 0,
    classifierUsd: 0,
    missingPrices: [],
    unknownRequests: ledger.total.unknown,
    provenance: [],
    notes: [],
  }
  if (!base) {
    out.notes.push(`no price configured for the baseline ${baselineModel}`)
    return out
  }
  const used = new Set<string>([`${base.id}: ${base.price.source} (${base.price.asOf})`])
  const priced: Bucket = emptyBucket()
  let pricedAny = false
  for (const [model, bucket] of Object.entries(ledger.byModel)) {
    if (model.includes('(classifier')) continue
    if (allTokens(bucket.tokens) === 0) continue
    const found = findPrice(model, prefs.pricing)
    if (!found) {
      out.missingPrices.push(model)
      continue
    }
    used.add(`${found.id}: ${found.price.source} (${found.price.asOf})`)
    out.routedUsd += priceBucket(bucket, found.price, cacheTtlOf(prefs))
    priced.tokens = addTokens(priced.tokens, bucket.tokens)
    priced.over100k = addTokens(priced.over100k, bucket.over100k)
    pricedAny = true
  }
  // Classifier calls run on the cheap tier's model and count on the routed side
  // only: a baseline run makes none.
  const classifier = ledger.byRole.classifier
  if (classifier && allTokens(classifier.tokens) > 0) {
    const cp = findPrice(prefs.models.cheap, prefs.pricing)
    if (cp) {
      out.classifierUsd = priceBucket(classifier, cp.price, cacheTtlOf(prefs))
      out.routedUsd += out.classifierUsd
      used.add(`${cp.id}: ${cp.price.source} (${cp.price.asOf})`)
    } else {
      out.missingPrices.push(`${prefs.models.cheap} (classifier)`)
    }
  }
  if (pricedAny) out.baselineUsd = priceBucket(priced, base.price, cacheTtlOf(prefs))
  out.differenceUsd = out.baselineUsd - out.routedUsd
  out.status = out.missingPrices.length > 0 ? 'partial' : 'ok'
  out.provenance = [...used]
  out.notes.push(`cache writes priced at the ${cacheTtlOf(prefs)} rate (${prefs.cacheTtl === "auto" ? "inferred from cache reads after idle gaps" : "your setting"}; Claude Code does not report it per request)`)
  if (out.unknownRequests > 0) out.notes.push(`${out.unknownRequests} request(s) reported no usage and are not priced`)
  if (out.missingPrices.length > 0) out.notes.push(`left out of both sides (no price): ${out.missingPrices.join(', ')}`)
  return out
}

// --- C. experiments -----------------------------------------------------

export type Comparison =
  | { status: 'no-baseline'; reason: string }
  | { status: 'not-comparable'; reason: string; mismatched: string[] }
  | {
      status: 'compared'
      runs: { routed: number; baseline: number }
      routed: ArmSummary
      baseline: ArmSummary
      /** Baseline minus routed per category (mean per run): negative means routing used more. */
      reduction: Tokens & { all: number; allPercent: number | null }
      routedFailedValidation: boolean
      limitations: string[]
    }

export type ArmSummary = {
  tokens: Tokens
  classifierTokens: Tokens
  requests: number
  unknown: number
  escalations: number
  retries: number
  durationMs: number
  outcome: { passed: number; failed: number; notRun: number }
}

function mean(arms: ExperimentArm[]): ArmSummary {
  const n = Math.max(1, arms.length)
  const sum = arms.reduce(
    (acc, a) => ({
      tokens: addTokens(acc.tokens, a.tokens),
      classifierTokens: addTokens(acc.classifierTokens, a.classifierTokens),
      requests: acc.requests + a.requests,
      unknown: acc.unknown + a.unknown,
      escalations: acc.escalations + a.escalations,
      retries: acc.retries + a.retries,
      durationMs: acc.durationMs + a.durationMs,
      outcome: {
        passed: acc.outcome.passed + a.outcome.passed,
        failed: acc.outcome.failed + a.outcome.failed,
        notRun: acc.outcome.notRun + a.outcome.notRun,
      },
    }),
    { tokens: zeroTokens(), classifierTokens: zeroTokens(), requests: 0, unknown: 0, escalations: 0, retries: 0, durationMs: 0, outcome: { passed: 0, failed: 0, notRun: 0 } },
  )
  const div = (t: Tokens): Tokens => ({ input: Math.round(t.input / n), output: Math.round(t.output / n), cacheRead: Math.round(t.cacheRead / n), cacheWrite: Math.round(t.cacheWrite / n) })
  return { ...sum, tokens: div(sum.tokens), classifierTokens: div(sum.classifierTokens), durationMs: Math.round(sum.durationMs / n) }
}

const CONDITIONS = ['spec', 'startState', 'validation', 'environment'] as const

/**
 * Compares the finished runs recorded under one label. Runs are compared only
 * when every declared condition (task spec, starting repository state,
 * validation criteria, environment) is identical and non-empty across both
 * arms; otherwise there is no comparable baseline and no number is given.
 */
export function compareExperiment(all: ExperimentArm[], label: string): Comparison {
  const arms = all.filter(a => a.label === label && a.endedAt !== null)
  const routed = arms.filter(a => a.arm === 'routed')
  const baseline = arms.filter(a => a.arm === 'baseline')
  if (routed.length === 0 || baseline.length === 0) {
    return { status: 'no-baseline', reason: `needs at least one finished routed run and one finished baseline run under "${label}"` }
  }
  const mismatched: string[] = []
  const ref = routed[0] as ExperimentArm
  for (const key of CONDITIONS) {
    if (!ref[key] || arms.some(a => a[key] !== ref[key])) mismatched.push(key)
  }
  if (mismatched.length > 0) {
    return { status: 'not-comparable', reason: 'declared conditions differ or are missing', mismatched }
  }
  const r = mean(routed)
  const b = mean(baseline)
  const red = subSigned(b.tokens, r.tokens)
  const allR = allTokens(r.tokens)
  const allB = allTokens(b.tokens)
  const limitations = [
    'conditions are as declared when the runs were started; the router cannot verify them',
    'model output varies run to run; few runs give a noisy comparison',
    'token volume is not cost: categories are priced differently',
  ]
  if (r.unknown + b.unknown > 0) limitations.push(`${r.unknown + b.unknown} request(s) without reported usage are not counted`)
  return {
    status: 'compared',
    runs: { routed: routed.length, baseline: baseline.length },
    routed: r,
    baseline: b,
    reduction: { ...red, all: allB - allR, allPercent: allB > 0 ? Math.round(((allB - allR) / allB) * 1000) / 10 : null },
    routedFailedValidation: r.outcome.failed > 0 && b.outcome.failed === 0,
    limitations,
  }
}

function subSigned(a: Tokens, b: Tokens): Tokens {
  return { input: a.input - b.input, output: a.output - b.output, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite }
}

export function usd(n: number): string {
  const sign = n < 0 ? '-' : ''
  const v = Math.abs(n)
  return `${sign}$${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)}`
}

// --- headline figures ------------------------------------------------------------

export type Headline = {
  /** Estimated list-price difference, baseline minus routed: negative means routing cost more. */
  usd: number
  /** The difference as a share of the baseline, or null without one. */
  percent: number | null
}

export function headline(est: SameVolume): Headline | null {
  if (est.status === 'unavailable' || est.baselineUsd <= 0) return null
  return { usd: est.differenceUsd, percent: Math.round((est.differenceUsd / est.baselineUsd) * 100) }
}

/**
 * Dry run: the recorded volumes priced at the models actually used versus the
 * same volumes priced at the models the router proposed. An estimate of what
 * applying the proposals might have saved at list prices, nothing more.
 */
export function potentialEstimate(ledger: Ledger, prefs: Prefs): Headline | null {
  let actual = 0
  let proposed = 0
  for (const [model, bucket] of Object.entries(ledger.byModel)) {
    if (model.includes('(classifier') || allTokens(bucket.tokens) === 0) continue
    const p = findPrice(model, prefs.pricing)
    if (!p) return null
    actual += priceBucket(bucket, p.price, cacheTtlOf(prefs))
  }
  for (const [model, bucket] of Object.entries(ledger.byProposed)) {
    if (allTokens(bucket.tokens) === 0) continue
    const p = findPrice(model.replace(/ \(unconfirmed\)$/, ''), prefs.pricing)
    if (!p) return null
    proposed += priceBucket(bucket, p.price, cacheTtlOf(prefs))
  }
  if (actual <= 0) return null
  return { usd: actual - proposed, percent: Math.round(((actual - proposed) / actual) * 100) }
}

export type TierShare = { cheap: number; middle: number; strong: number; other: number; total: number }

/** How the session's requests were spread over the tiers, by the model that answered. */
export function tierShare(ledger: Ledger, tierOf: (model: string) => 'cheap' | 'middle' | 'strong' | null): TierShare {
  const share: TierShare = { cheap: 0, middle: 0, strong: 0, other: 0, total: 0 }
  for (const [model, bucket] of Object.entries(ledger.byModel)) {
    if (model.includes('(classifier')) continue
    const tier = tierOf(model.replace(/ \((unconfirmed|classifier, as requested)\)$/, ''))
    share[tier ?? 'other'] += bucket.requests
    share.total += bucket.requests
  }
  return share
}

/** The current session's estimate folded into the log of earlier ones (bounded). */
export function logSavings(log: SavingsEntry[], entry: SavingsEntry): SavingsEntry[] {
  return [...log.filter(e => e.sessionId !== entry.sessionId), entry].slice(-200)
}

export type Lifetime = { usd: number; percent: number | null; sessions: number; failedPhases: number; compactionUsd: number }

/**
 * All sessions' cache-aware estimates added up, routing and the router's
 * compactions together. Entries from before 0.8.1 priced the same volumes,
 * which overstates savings on long conversations; they are left out of the
 * total (and counted, so nothing vanishes silently).
 */
export function lifetime(log: SavingsEntry[]): Lifetime & { legacy: number } {
  const current = log.filter(e => e.method === 'cache-aware')
  const routed = current.reduce((s, e) => s + e.routedUsd, 0)
  const baseline = current.reduce((s, e) => s + e.baselineUsd + (e.compactionSavedUsd ?? 0), 0)
  const compaction = current.reduce((s, e) => s + (e.compactionSavedUsd ?? 0) - (e.compactionCostUsd ?? 0), 0)
  const saved = current.reduce((s, e) => s + e.baselineUsd - e.routedUsd, 0) + compaction
  return {
    usd: saved,
    compactionUsd: compaction,
    percent: baseline > 0 ? Math.round((saved / baseline) * 100) : null,
    sessions: current.filter(e => e.requests > 0).length,
    failedPhases: current.reduce((s, e) => s + e.failedPhases, 0),
    legacy: log.length - current.length,
  }
}

// --- the cache-aware estimate ----------------------------------------------

export const CACHE_AWARE_LABEL = 'Estimated difference — cache-aware, same output'

export function emptyPath(): PathSim {
  return { caches: {}, prompt: null, model: null }
}

export function emptyCacheAware(): CacheAware {
  return { actualUsd: 0, stayUsd: 0, followUsd: 0, priced: 0, unpriced: 0, lastActual: null, stay: emptyPath(), follow: emptyPath() }
}

function rowFor(price: ModelPrice, prompt: number): PriceRow {
  return prompt > 100_000 && price.over100k ? price.over100k : price
}

function costOf(price: ModelPrice, u: { input: number; read: number; write: number; output: number }, ttl: '5m' | '1h'): number {
  const r = rowFor(price, u.input + u.read + u.write)
  const w = ttl === '1h' ? r.cacheWrite1h : r.cacheWrite5m
  return (u.input * r.input + u.read * r.cacheRead + u.write * w + u.output * r.output) / 1_000_000
}

export type CacheAwareStep = {
  role: 'main' | 'subagent' | 'classifier' | string
  /** The model that answered. */
  answered: string
  /** The model Claude Code asked for: the "stay" path. */
  asked: string
  /** The router's proposal (applied or not): the "follow" path; null when it made none. */
  proposed: string | null
  usage: Tokens
  at: number
}

/**
 * One main-loop request on a path: in step with what really ran (same model
 * now and before), it costs what the request cost; otherwise the path's model
 * reads what its own cache still holds of the path's conversation and writes
 * the rest. The conversation on a path grows as the real one does.
 */
function pathStep(
  path: PathSim,
  model: string,
  price: ModelPrice,
  step: CacheAwareStep,
  actualUsd: number,
  prev: CacheAware['lastActual'],
  ttl: '5m' | '1h',
): { path: PathSim; usd: number } {
  const u = step.usage
  const cacheable = u.cacheRead + u.cacheWrite
  const reset = prev !== null && prev.model === step.answered && cacheable < 0.5 * prev.prompt
  const inStep = model === step.answered && path.model === (prev?.model ?? null)
  if (inStep || path.prompt === null) {
    const usd = inStep ? actualUsd : costOf(price, { input: u.input, read: 0, write: cacheable, output: u.output }, ttl)
    return { path: { caches: { ...path.caches, [model]: { size: cacheable, at: step.at } }, prompt: cacheable, model }, usd }
  }
  const growth = prev === null ? cacheable : prev.model === step.answered ? Math.max(0, cacheable - prev.prompt) : 0
  const prompt = reset ? cacheable : path.prompt + growth
  const slot = path.caches[model]
  const ttlMs = ttl === '1h' ? 3_600_000 : 300_000
  const warm = !reset && slot !== undefined && step.at - slot.at <= ttlMs
  const read = warm ? Math.min(slot.size, prompt) : 0
  const write = prompt - read
  const usd = costOf(price, { input: u.input, read, write, output: u.output }, ttl)
  return { path: { caches: { ...path.caches, [model]: { size: prompt, at: step.at } }, prompt, model }, usd }
}

/**
 * Adds one request to the cache-aware estimate. Classifier calls are part of
 * routing: they count where routing runs (as it ran, and following the
 * proposals), not on the path that stays put. Subagents start with a fresh
 * context on any model, so their paths are the same volumes priced at each
 * path's model. A request with no price for a model on any path is left out
 * of all three and counted.
 */
export function cacheAwareStep(ca: CacheAware, step: CacheAwareStep, prefs: Prefs): CacheAware {
  const ttl = cacheTtlOf(prefs)
  const follow = step.proposed ?? step.answered
  const pA = findPrice(step.answered, prefs.pricing)?.price
  const pR = findPrice(step.asked, prefs.pricing)?.price
  const pF = findPrice(follow, prefs.pricing)?.price
  const u = step.usage
  if (!pA || !pR || !pF) return { ...ca, unpriced: ca.unpriced + 1 }
  const actual = costOf(pA, { input: u.input, read: u.cacheRead, write: u.cacheWrite, output: u.output }, ttl)
  if (step.role === 'classifier') return { ...ca, actualUsd: ca.actualUsd + actual, followUsd: ca.followUsd + actual }
  if (step.role !== 'main') {
    const same = (p: ModelPrice) => costOf(p, { input: u.input, read: u.cacheRead, write: u.cacheWrite, output: u.output }, ttl)
    return { ...ca, actualUsd: ca.actualUsd + actual, stayUsd: ca.stayUsd + same(pR), followUsd: ca.followUsd + same(pF), priced: ca.priced + 1 }
  }
  const prev = ca.lastActual
  const stay = pathStep(ca.stay, step.asked, pR, step, actual, prev, ttl)
  const fol = pathStep(ca.follow, follow, pF, step, actual, prev, ttl)
  return {
    actualUsd: ca.actualUsd + actual,
    stayUsd: ca.stayUsd + stay.usd,
    followUsd: ca.followUsd + fol.usd,
    priced: ca.priced + 1,
    unpriced: ca.unpriced,
    lastActual: { model: step.answered, prompt: u.cacheRead + u.cacheWrite },
    stay: stay.path,
    follow: fol.path,
  }
}

/**
 * The session's estimate, as the band shows it. Routing ON (or any routed
 * request): what staying on Claude Code's model would have cost, minus what it
 * did ("saved", negative is "cost more"). Otherwise: what following the
 * router's proposals would have cost less ("could save").
 */
export function cacheAwareHeadline(ca: CacheAware | undefined, routed: boolean): (Headline & { kind: 'saved' | 'could' }) | null {
  if (!ca || ca.priced === 0) return null
  if (routed) {
    if (ca.stayUsd <= 0) return null
    const d = ca.stayUsd - ca.actualUsd
    return { kind: 'saved', usd: d, percent: Math.round((d / ca.stayUsd) * 100) }
  }
  if (ca.actualUsd <= 0) return null
  const d = ca.actualUsd - ca.followUsd
  return { kind: 'could', usd: d, percent: Math.round((d / ca.actualUsd) * 100) }
}

// --- the router's compactions ----------------------------------------------

/** Claude Code keeps this much of its window free and compacts on its own past the rest (/context shows 33k on 400k and 450k windows). */
export const CLAUDE_CODE_COMPACT_BUFFER = 33_000

export function emptyCompaction(): CompactionSavings {
  return { count: 0, costUsd: 0, savedUsd: 0, offset: 0, unpriced: 0 }
}

/**
 * The router compacted a conversation of `pre` tokens down to `post`. Its cost,
 * estimated: reading the conversation once, writing the summary (what `post`
 * holds beyond what every request carries anyway, `base`), and caching the
 * result. From here each request is `pre - post` tokens smaller.
 */
export function compactionDone(c: CompactionSavings, i: { pre: number; post: number; base: number; model: string | null; prefs: Prefs }): CompactionSavings {
  const found = i.model ? findPrice(i.model, i.prefs.pricing) : null
  const offset = Math.max(0, i.pre - i.post)
  if (!found) return { ...c, count: c.count + 1, offset: 0, unpriced: c.unpriced + 1 }
  const row = rowFor(found.price, i.pre)
  const write = cacheTtlOf(i.prefs) === '1h' ? row.cacheWrite1h : row.cacheWrite5m
  const cost = (i.pre * row.cacheRead + Math.max(0, i.post - i.base) * row.output + i.post * write) / 1_000_000
  return { ...c, count: c.count + 1, costUsd: c.costUsd + cost, offset }
}

/**
 * A main-conversation request after a router compaction: the cache reads it
 * avoided. Without the compaction it would carry `offset` more tokens, unless
 * that took it past `point`, where Claude Code would have compacted on its own;
 * from there on the two conversations are alike and nothing more is counted.
 * With `point` unknown nothing is counted.
 */
export function compactionStep(c: CompactionSavings, i: { promptTokens: number; model: string; point: number | null; prefs: Prefs }): CompactionSavings {
  if (c.offset <= 0 || i.point === null) return c
  const found = findPrice(i.model, i.prefs.pricing)
  const reaches = i.promptTokens + c.offset >= i.point
  const extra = reaches ? Math.max(0, i.point - i.promptTokens) : c.offset
  const offset = reaches ? 0 : c.offset
  if (!found) return { ...c, offset }
  const row = rowFor(found.price, i.promptTokens + extra)
  return { ...c, savedUsd: c.savedUsd + (extra * row.cacheRead) / 1_000_000, offset }
}

/** Any other compaction (Claude Code's own, a typed /compact): it would have happened anyway, so the router's no longer counts. */
export function compactionReset(c: CompactionSavings): CompactionSavings {
  return c.offset === 0 ? c : { ...c, offset: 0 }
}

/** The router's compactions, net: saved minus their cost. Null before the first. */
export function compactionNet(c: CompactionSavings | undefined): number | null {
  return c && c.count - c.unpriced > 0 ? c.savedUsd - c.costUsd : null
}

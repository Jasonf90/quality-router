// What the band, the pane and the text commands show. Pure: it formats a
// snapshot of the state layer and never reads `$` itself.
//
// Labels are explicit about what was observed (reported by the API or the
// provider) and what is inferred or estimated.

import type {
  Bucket,
  CheckKind,
  ExperimentArm,
  History,
  Ledger,
  Limits,
  Prefs,
  ProjectConfig,
  RouterMode,
  Runtime,
  Tier,
  Validation,
} from '../types'
import { allTokens, compact } from './accounting'
import { checkStatus, verdict } from './escalation'
import { formatSpan, formatWhen, isWeekly, kindLabel, limitLine, project, type Projection } from './limits'
import { CACHE_AWARE_LABEL, ESTIMATE_CAVEATS, ESTIMATE_LABEL, type SameVolume, sameVolumeEstimate, usd } from './savings'
import { TIER_LABEL, cacheTtlOf, shortModel } from './settings'

export type Snapshot = {
  prefs: Prefs
  rt: Runtime
  ledger: Ledger
  validation: Validation
  history: History
  limits: Limits
  project: ProjectConfig
  experiment: ExperimentArm | null
  now: number
}

export type Tone = 'success' | 'inactive' | 'warning' | 'error'

const GLYPH = {
  unicode: { on: '●', off: '○', dry: '◐', bad: '⚠', up: '⇡', pass: '✓', fail: '✗', stale: '~', none: '·', na: '?' },
  ascii: { on: '[ON]', off: '[OFF]', dry: '[DRY]', bad: '[!]', up: '^', pass: 'ok', fail: 'X', stale: '~', none: '-', na: '?' },
}

export function glyphs(prefs: Prefs) {
  return prefs.ui.ascii ? GLYPH.ascii : GLYPH.unicode
}

export function headline(s: Snapshot): { text: string; tone: Tone } {
  const g = glyphs(s.prefs)
  if (s.prefs.state === 'on') return { text: `${g.on} Router ON`, tone: 'success' }
  if (s.prefs.state === 'dry-run') return { text: `${g.dry} Router DRY RUN`, tone: 'warning' }
  return { text: `${g.off} Router OFF`, tone: 'inactive' }
}

/** The display name of each mode, so a mode on its own can be named too. */
export const MODE_LABEL: Record<RouterMode, string> = {
  'quality-first': 'Quality-first',
  balanced: 'Balanced',
  economy: 'Economy',
}

export function modeLabel(prefs: Prefs): string {
  return MODE_LABEL[prefs.mode]
}

export function isPausedView(s: Snapshot): boolean {
  return isPaused(s)
}

function isPaused(s: Snapshot): boolean {
  return s.rt.manual !== null && s.prefs.respectManual && s.prefs.override.kind === 'auto'
}

/**
 * The effort the next main request will carry (or, in DRY RUN, would carry):
 * the router's choice when it made one (automatic, or a per-tier setting),
 * otherwise the session's own, unchanged. Null when neither is known.
 */
export function nextEffort(s: Snapshot): { level: string; source: 'auto' | 'preference' | 'session'; reason: string | null; proposedOnly: boolean } | null {
  const d = s.rt.phase?.decision && s.rt.phase.decision.epoch === s.rt.epoch ? s.rt.phase.decision : null
  const routing = (s.prefs.state === 'on' || s.prefs.state === 'dry-run') && !isPaused(s)
  if (routing && d?.effort) {
    return { level: d.effort, source: d.effortSource ?? 'preference', reason: d.effortReason ?? null, proposedOnly: s.prefs.state === 'dry-run' }
  }
  return s.rt.sessionEffort ? { level: s.rt.sessionEffort, source: 'session', reason: null, proposedOnly: false } : null
}

/**
 * `effort low (auto: lowered for a mechanical change)`, `effort high (session
 * setting)`; with `, last applied medium` when Claude Code reported applying a
 * different level to the last request. In DRY RUN, what it would use.
 */
export function effortText(s: Snapshot): string | null {
  const n = nextEffort(s)
  if (!n) return null
  const applied = s.rt.lastEffort.applied
  const sent = s.rt.lastEffort.sent
  const lowered = applied && sent && applied !== sent ? `, last applied ${applied}` : ''
  const why = n.source === 'auto' ? `auto: ${n.reason ?? 'chosen by router'}` : n.source === 'preference' ? (n.reason ?? 'set by router') : 'session setting'
  if (n.proposedOnly) return `effort ${s.rt.sessionEffort ?? 'default'} now, would use ${n.level} (${why})`
  return `effort ${n.level} (${why}${lowered})`
}

/** The selection segment: what the next main request will use, or would use. */
export function selection(s: Snapshot): string {
  const d = s.rt.phase?.decision && s.rt.phase.decision.epoch === s.rt.epoch ? s.rt.phase.decision : null
  if (s.prefs.state === 'off') return 'Claude Code selects the model'
  if (isPaused(s)) return `Manual: ${shortModel(s.rt.manual?.model)} (router paused)`
  const name = d ? `${shortModel(d.model)} (${d.tier})` : 'decided at the next request'
  if (s.prefs.override.kind !== 'auto') return `Override: ${name}`
  return s.prefs.state === 'on' ? `Next: ${name}` : `Proposed: ${name}`
}

/** The model of a request in flight, as requested (the API reports the answering model after). */
export function active(s: Snapshot): string | null {
  const list = Object.values(s.rt.active).filter(a => !a.agentId)
  const a = list[list.length - 1]
  return a ? `Active: ${shortModel(a.model)}${a.effort ? ` · effort ${a.effort}` : ''} (requested${a.routed ? ', routed' : ''})` : null
}

export function observed(s: Snapshot): string | null {
  return s.rt.observedModel ? `Last answered by ${s.rt.observedModel} (observed)` : null
}

export function reason(s: Snapshot): string | null {
  const d = s.rt.phase?.decision
  if (!d || s.prefs.state === 'off' || !s.prefs.ui.showReason) return null
  return `why: ${d.reason}`
}

export function escalation(s: Snapshot): string | null {
  const n = s.rt.phase?.escalations ?? 0
  return n > 0 ? `${glyphs(s.prefs).up} escalated x${n}` : null
}

export function codeNow(s: Snapshot): { sourceVersion: number; testVersion: number } {
  return { sourceVersion: s.rt.code.source, testVersion: s.rt.code.test }
}

const KINDS: CheckKind[] = ['build', 'test', 'lint', 'typecheck', 'custom']

export function checksLine(s: Snapshot): string | null {
  const g = glyphs(s.prefs)
  const kinds = KINDS.filter(k => s.validation.checks[k] || s.validation.required.includes(k))
  if (kinds.length === 0) return null
  const mark = { passed: g.pass, failed: g.fail, stale: g.stale, 'not-run': g.none, unavailable: g.na } as const
  const parts = kinds.map(k => `${k} ${mark[checkStatus(s.validation, k, codeNow(s))]}`)
  const v = verdict(s.validation, codeNow(s))
  return `checks: ${parts.join(' ')} (${v})`
}

export function projections(s: Snapshot): Projection[] {
  return Object.values(s.limits.tracks).map(t => project(t, s.now))
}

export function weeklyLine(s: Snapshot): string | null {
  if (!s.prefs.ui.showLimits) return null
  const weekly = projections(s).filter(p => isWeekly(p.kind))
  const main = weekly.find(p => p.kind === 'seven_day') ?? weekly[0]
  return main ? limitLine(main) : null
}

export function degraded(s: Snapshot): string | null {
  return s.rt.degraded ? `${glyphs(s.prefs).bad} Degraded: ${s.rt.degraded}` : null
}

export function estimate(s: Snapshot): SameVolume {
  return sameVolumeEstimate(s.ledger, s.prefs, s.rt.sessionModel)
}

// --- text reports --------------------------------------------------------------

function tokensRow(label: string, b: Bucket): string {
  const t = b.tokens
  const unknown = b.unknown > 0 ? `, ${b.unknown} with usage not reported` : ''
  return `  ${label}: ${b.requests} req · in ${compact(t.input)} · out ${compact(t.output)} · cache read ${compact(t.cacheRead)} · cache write ${compact(t.cacheWrite)}${unknown}`
}

/** `engineWindow`: the window Claude Code compacts against, when a context reading has said. */
export function statusText(s: Snapshot, engineWindow: number | null = null): string {
  const lines = [`${headline(s).text} · ${modeLabel(s.prefs)} · ${selection(s)}`]
  for (const extra of [effortText(s), active(s), observed(s), reason(s), escalation(s), checksLine(s), degraded(s), weeklyLine(s)]) {
    if (extra) lines.push(`  ${extra}`)
  }
  const onlyOn = s.prefs.state === 'on' ? '' : ' (runs only while routing is ON)'
  const k = (n: number) => `${Math.round(n / 1000)}k`
  if (engineWindow) lines.push(`  Claude Code compacts on its own (mid-turn too) near ${k(engineWindow)}${engineWindow >= 900_000 ? ': CLAUDE_CODE_AUTO_COMPACT_WINDOW=450000 would cap long turns at about 417k' : ''}`)
  if (s.prefs.autoCompactSmart === 'on') {
    lines.push(`  auto-compact: smart, when work is finished from ${k(s.prefs.autoCompactBoundary)} tokens, mid-task past ${k(s.prefs.autoCompactCeiling)}${onlyOn}`)
  } else {
    if (s.prefs.autoCompactTokens !== null) lines.push(`  auto-compact at ${k(s.prefs.autoCompactTokens)} tokens${onlyOn}`)
    if (s.prefs.autoCompactSmart === 'watch') lines.push(`  smart auto-compact watching (would compact when work is finished from ${k(s.prefs.autoCompactBoundary)}, mid-task past ${k(s.prefs.autoCompactCeiling)}): /quality-router autocompact report`)
  }
  const floor = s.prefs.floor ? `floor ${s.prefs.floor}` : 'no floor'
  const o = s.prefs.override
  const override = o.kind === 'auto' ? 'automatic' : o.kind === 'tier' ? `override ${o.tier}` : `override ${o.model}`
  lines.push(`  models: cheap ${s.prefs.models.cheap} · middle ${s.prefs.models.middle} · strong ${s.prefs.models.strong} (${override}, ${floor})`)
  if (s.rt.reviewSuggested) lines.push(`  review suggested: ${s.rt.reviewSuggested} (/quality-router review now)`)
  if (s.project.loadedFrom) lines.push(`  project config: ${s.project.loadedFrom}${s.project.problems.length ? ` (${s.project.problems.join('; ')})` : ''}`)
  return lines.join('\n')
}

export function usageText(s: Snapshot): string {
  const l = s.ledger
  const lines = ['A. OBSERVED TOKEN USAGE (as the API reported it, this session)']
  lines.push(tokensRow('all requests', l.total))
  lines.push(`  combined volume ${compact(allTokens(l.total.tokens))} = input + output + cache read + cache write (a volume, not a cost: cache reads are billed far below input)`)
  for (const [model, b] of Object.entries(l.byModel)) lines.push(tokensRow(model, b))
  for (const role of ['main', 'subagent', 'classifier'] as const) {
    const b = l.byRole[role]
    if (b) lines.push(tokensRow(role === 'classifier' ? 'classifier overhead' : role, b))
  }
  for (const purpose of ['escalated', 'fallback', 'review'] as const) {
    const b = l.byPurpose[purpose]
    if (b) lines.push(tokensRow(`${purpose} requests`, b))
  }
  if (l.effortLowered + l.effortRaised > 0) {
    lines.push(`  effort: lowered on ${l.effortLowered} request(s), raised on ${l.effortRaised} (their effect is already in the output tokens above; it is not estimated separately)`)
  }
  if (l.aborted + l.noResponse > 0) lines.push(`  interrupted: ${l.aborted} · no response: ${l.noResponse}`)
  if (l.turnMismatches > 0) lines.push(`  ${l.turnMismatches} turn(s) whose own total differed from the sum of their requests (requests are what is counted)`)
  if (l.engineCostUsd !== null) lines.push(`  Claude Code's own /cost figure for the session: ${usd(l.engineCostUsd)} (all models; its pricing, not this mod's)`)

  const ca = s.ledger.cacheAware
  lines.push('', `B. ${CACHE_AWARE_LABEL.toUpperCase()} (the band's figure)`)
  if (!ca || ca.priced === 0) {
    lines.push('  not available yet (no priced request this session, or a session started before 0.8.1)')
  } else {
    const stayModel = s.rt.sessionModel ?? s.prefs.models.strong
    const saved = ca.stayUsd - ca.actualUsd
    lines.push(`  as it ran ${usd(ca.actualUsd)} vs staying on ${stayModel} ${usd(ca.stayUsd)}: ${usd(Math.abs(saved))} ${saved >= 0 ? 'lower' : 'HIGHER'}`)
    if (Math.abs(ca.followUsd - ca.actualUsd) >= 0.005) {
      const could = ca.actualUsd - ca.followUsd
      lines.push(`  following every router proposal: ${usd(ca.followUsd)} (${usd(Math.abs(could))} ${could >= 0 ? 'lower' : 'higher'} than as it ran)`)
    }
    lines.push(`  - each model switch is charged for caching the whole conversation on the new model, and again on the way back`)
    lines.push(`  - output tokens held equal; list prices; cache writes at the ${cacheTtlOf(s.prefs)} rate (${s.prefs.cacheTtl === 'auto' ? 'inferred' : 'your setting'})`)
    if (ca.unpriced > 0) lines.push(`  - ${ca.unpriced} request(s) without a price for one of the models are left out`)
  }

  const est = estimate(s)
  lines.push('', `B2. ${ESTIMATE_LABEL.toUpperCase()}`)
  lines.push('  - ignores re-caching on model switches: on long conversations it overstates savings, and can show a saving where routing cost more')
  if (est.status === 'unavailable') {
    lines.push(`  unavailable: ${est.notes.join('; ')}`)
  } else {
    const sign = est.differenceUsd >= 0 ? 'lower' : 'HIGHER'
    lines.push(`  routed ${usd(est.routedUsd)} (incl. classifier ${usd(est.classifierUsd)}) vs all at ${est.baselineModel} ${usd(est.baselineUsd)}: ${usd(Math.abs(est.differenceUsd))} ${sign}${est.status === 'partial' ? ' (partial)' : ''}`)
    for (const c of ESTIMATE_CAVEATS) lines.push(`  - ${c}`)
    for (const n of est.notes) lines.push(`  - ${n}`)
    for (const p of est.provenance) lines.push(`  price: ${p}`)
  }
  const phases = s.history.phases
  const failed = phases.filter(p => p.verdict === 'failed').length
  const verified = phases.filter(p => p.verdict === 'verified').length
  lines.push(`  validation of finished phases: ${verified} verified, ${failed} failed, ${phases.length - verified - failed} unverified`)
  if (failed > 0) lines.push('  phases that failed validation are not successful optimizations, whatever they cost')

  lines.push('', 'C. EXPERIMENTAL TOKEN REDUCTION')
  lines.push(s.experiment ? `  running: "${s.experiment.label}" (${s.experiment.arm}), ${s.experiment.requests} requests so far` : '  /quality-router experiment report <label> compares recorded runs; with none: No comparable baseline')
  return lines.join('\n')
}

export function limitsText(s: Snapshot): string {
  const ps = projections(s)
  if (ps.length === 0) {
    return 'Plan limits: no readings yet. The provider reports them on responses for subscription accounts; none have arrived this session.'
  }
  const lines = ['PLAN LIMITS (observed: as the provider reported them)']
  const latest = s.limits.latest.length > 0
    ? s.limits.latest
    : Object.values(s.limits.tracks).map(t => {
        const last = t.readings[t.readings.length - 1]
        return { kind: t.kind, percentUsed: last?.pct ?? 0, resetsAt: t.resetsAt, at: last?.t ?? 0 }
      })
  for (const l of latest) {
    const reset = l.resetsAt && Number.isFinite(Date.parse(l.resetsAt)) ? `, resets ${formatWhen(Date.parse(l.resetsAt))}` : ''
    const when = l.at > 0 ? ` (reading of ${formatWhen(l.at)})` : ''
    lines.push(`  ${kindLabel(l.kind)}: ${l.percentUsed}% used${reset}${when}`)
  }
  lines.push('', 'PROJECTION (estimate: when a window would reach 100% at the pace seen)')
  for (const p of ps) {
    lines.push(`  ${limitLine(p)}`)
    for (const pace of [p.primary, p.alternative]) {
      if (!pace) continue
      const basis = pace.method === 'recent-pace'
        ? `recent pace from ${pace.readings} readings over ${formatSpan(pace.spanMs)}`
        : `window average over ${formatSpan(pace.spanMs)} (${pace.assumption})`
      lines.push(`    ${pace === p.primary ? 'used' : 'also'}: ${pace.pctPerHour.toFixed(2)}%/h, ${basis}`)
    }
    lines.push(`    ${p.note}`)
  }
  lines.push('  Not a count of tasks or tokens remaining; usage elsewhere (other sessions, devices, claude.ai) moves it too.')
  return lines.join('\n')
}

export function historyText(s: Snapshot, max = 8): string {
  const rows = s.history.decisions.slice(-max).reverse()
  if (rows.length === 0) return 'No routing decisions yet.'
  return rows
    .map(d => `  ${formatWhen(d.at).slice(-5)} ${d.scope} → ${d.tier} ${shortModel(d.model)}${d.effort ? ` · effort ${d.effort}` : ''} [${d.source}${d.applied ? '' : ', not applied'}] ${d.reason}`.slice(0, 240))
    .join('\n')
}

export function configText(prefs: Prefs): string {
  const pricing = Object.entries(prefs.pricing).map(([m, p]) => `${m} (${p.source}, ${p.asOf})`)
  const shown = { ...prefs, pricing }
  return JSON.stringify(shown, null, 2)
}

export function tierName(tier: Tier): string {
  return TIER_LABEL[tier]
}

// The band's and the pane's content as plain data: meters with progress bars,
// the savings headline, work in progress and the top recommendation. Pure:
// register.tsx only turns these into elements, so every figure is tested here.

import type { Activity, AgentActivity, AgentStats, Recommendation, SavingsEntry, TaskItem } from '../types'
import { allTokens, compact } from './accounting'
import { agentSummary, listStartedAt, MAIN, phaseAgents, progress, taskList } from './activity'
import { type Estimate, agentEstimate, duration, etaText, overallAgentEta, taskEstimate } from './eta'
import { recommend } from './advisor'
import { verdict } from './escalation'
import { formatWhen, isWeekly, kindLabel, type Projection } from './limits'
import { cacheAwareHeadline, lifetime, tierShare } from './savings'
import { cacheTtlOf, shortModel, tierOfModel } from './settings'
import { type Snapshot, codeNow, effortText, glyphs, headline, isPausedView, modeLabel, projections, selection } from './view'

export type Tone = 'success' | 'inactive' | 'warning' | 'error' | 'accent' | 'brand' | 'text'

export type Bar = { fraction: number; tone: Tone }

export type Meter = {
  key: string
  label: string
  bar: Bar | null
  value: string
  valueTone: Tone
  note: string
}

export type BandModel = {
  head: { text: string; tone: Tone }
  selection: string
  effort: string | null
  mode: string
  active: string | null
  savings: Meter
  meters: Meter[]
  work: Meter[]
  /** One row per running subagent (up to three), each with its own estimate. */
  agentRows: Meter[]
  tip: Recommendation | null
  tipCount: number
  degraded: string | null
  why: string | null
  paused: boolean
}

export type View = Snapshot & { activity: Activity; savingsLog: SavingsEntry[]; agentStats: AgentStats; isWorking: boolean }

export const BAR_WIDTH = 12

/** Filled and empty cells for a fraction, never all-full below 100% nor empty above 0%. */
export function barCells(fraction: number, width: number): { filled: number; empty: number } {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  let filled = Math.round(f * width)
  if (f > 0 && filled === 0) filled = 1
  if (f < 1 && filled === width) filled = width - 1
  return { filled, empty: width - filled }
}

export function barChars(ascii: boolean): { full: string; empty: string } {
  return ascii ? { full: '#', empty: '-' } : { full: '━', empty: '─' }
}

/** Green below 60%, amber below 85%, red from there: for meters that fill up. */
export function fillTone(percent: number): Tone {
  return percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'
}

function usd(n: number): string {
  const v = Math.abs(n)
  return `$${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}`
}

export function contextMeter(v: View): Meter | null {
  const c = v.activity.context
  if (!c || c.percent === null) return null
  const used = c.tokens !== null ? `${compact(c.tokens)} / ${compact(c.window)}` : `of ${compact(c.window)}`
  return { key: 'context', label: 'Context', bar: { fraction: c.percent / 100, tone: fillTone(c.percent) }, value: `${c.percent}%`, valueTone: fillTone(c.percent), note: used }
}

export function weeklyMeter(v: View): Meter | null {
  const weekly = projections(v).filter(p => isWeekly(p.kind))
  const p = weekly.find(x => x.kind === 'seven_day') ?? weekly[0]
  if (!p) return null
  return limitMeter(p)
}

export function limitMeter(p: Projection): Meter {
  let note: string
  if (p.status === 'projected' && p.etaMs !== null) note = `est. limit ${formatWhen(p.etaMs)}`
  else if (p.status === 'exceeded') note = 'limit reached'
  else if (p.status === 'not-before-reset') note = 'on pace: not projected to hit it'
  else if (p.status === 'flat') note = 'no recent rise'
  else note = 'est. limit: not enough data yet'
  const reset = p.resetsAt && Number.isFinite(Date.parse(p.resetsAt)) ? ` · resets ${formatWhen(Date.parse(p.resetsAt))}` : ''
  const tone: Tone = p.status === 'projected' || p.status === 'exceeded' ? 'error' : fillTone(p.percentUsed)
  return {
    key: `limit-${p.kind}`,
    label: kindLabel(p.kind),
    bar: { fraction: p.percentUsed / 100, tone },
    value: `${p.percentUsed}%`,
    valueTone: tone,
    note: `${note}${reset}`,
  }
}

export type SessionSavings = {
  /** `saved`: requests were actually routed. `could`: what applying the proposals might have saved. */
  kind: 'saved' | 'could'
  usd: number
  percent: number | null
  baselineModel: string
}

/**
 * The session's savings figure, live after every request. Once anything was
 * routed (now or earlier in the session) it is the same-volume estimate of
 * what routing saved; before that, in DRY RUN or OFF, it is what applying the
 * router's proposals might have saved. Both are list-price estimates over the
 * recorded token volumes.
 */
/**
 * The session's savings, cache-aware: routing ON (or anything routed) is
 * compared with staying on Claude Code's model, otherwise the router's
 * proposals are priced as a what-if. Each model switch is charged for
 * re-caching the conversation on the new model and again on the way back.
 */
export function sessionSavings(v: View): SessionSavings | null {
  const routed = v.prefs.state === 'on' || v.ledger.routedRequests > 0
  const h = cacheAwareHeadline(v.ledger.cacheAware, routed)
  return h ? { kind: h.kind, usd: h.usd, percent: h.percent, baselineModel: v.rt.sessionModel ?? v.prefs.models.strong } : null
}

/**
 * The savings row: always present. Labelled "est.", negative (and red) when
 * routing cost more, with what the current turn added and the all-sessions
 * total, and marked when any task failed its checks.
 */
export function savingsMeter(v: View): Meter {
  const failed = v.history.phases.some(p => p.verdict === 'failed')
  const life = lifetime(v.savingsLog)
  const lifeNote = life.sessions > 0 ? `all sessions est. ${usd(Math.abs(life.usd))} ${life.usd >= 0 ? 'saved' : 'more'}` : null
  const s = sessionSavings(v)
  if (!s) {
    const why = v.ledger.total.requests === 0 ? 'no requests yet this session' : 'no price configured for the models used'
    return { key: 'savings', label: 'Savings', bar: null, value: '—', valueTone: 'inactive', note: [why, lifeNote].filter(Boolean).join(' · ') }
  }
  const more = s.usd < 0
  const mark = v.activity.savingsMark
  const delta = mark && mark.kind === s.kind ? s.usd - mark.usd : null
  const deltaNote = delta !== null && Math.abs(delta) >= 0.005 ? `${delta >= 0 ? '+' : '-'}${usd(Math.abs(delta))} this turn` : null
  const pctNote = s.percent !== null ? `${Math.abs(s.percent)}% ${more ? 'more' : 'less'} than all ${shortModel(s.baselineModel)}` : null
  const could = s.kind === 'could'
  const note = [
    could ? `this session if ON` : 'this session',
    deltaNote,
    pctNote,
    could ? 'list prices, re-caching included' : null,
    failed ? 'some checks failed' : null,
    lifeNote,
  ].filter(Boolean).join(' · ')
  return {
    key: 'savings',
    label: could ? 'Could save' : more ? 'Cost more' : 'Saved',
    bar: s.percent !== null && !more ? { fraction: s.percent / 100, tone: could ? 'accent' : 'success' } : null,
    value: `est. ${usd(Math.abs(s.usd))}`,
    valueTone: more ? 'error' : could ? 'accent' : 'success',
    note,
  }
}

export function taskMeter(list: TaskItem[], key = 'tasks', label = 'Tasks', startedAt: number | null = null, now = 0): Meter | null {
  const p = progress(list)
  if (!p) return null
  const done = p.done === p.total
  const est = taskEstimate(list, startedAt, now)
  const when = est?.status === 'estimate' ? etaText(est) : est?.status === 'estimating' ? 'time left: estimating' : null
  return {
    key,
    label,
    bar: { fraction: p.done / p.total, tone: done ? 'success' : 'accent' },
    value: `${p.done}/${p.total}`,
    valueTone: done ? 'success' : 'text',
    note: done ? 'all done' : [p.current ?? 'next up', when].filter(Boolean).join(' · '),
  }
}

export function agentsMeter(list: AgentActivity[], estimates: readonly Estimate[] = []): Meter | null {
  const s = agentSummary(list)
  if (!s) return null
  const overall = overallAgentEta(estimates)
  const parts = [
    s.running > 0 ? `${s.running} running` : null,
    s.failed > 0 ? `${s.failed} failed or stopped` : null,
    s.running > 0 ? (overall ? `all ${etaText(overall)}` : 'time left: see each agent') : null,
  ].filter(Boolean)
  const finished = s.done + s.failed
  return {
    key: 'agents',
    label: 'Agents',
    bar: { fraction: finished / s.total, tone: s.failed > 0 ? 'warning' : finished === s.total ? 'success' : 'accent' },
    value: `${finished}/${s.total}`,
    valueTone: s.failed > 0 ? 'warning' : 'text',
    note: parts.join(' · ') || 'all finished',
  }
}

/**
 * One agent's row: a progress bar from its estimate (its own task list, or
 * the typical duration of its type), its percentage and time left, and its
 * facts. With no basis for an estimate there is no bar and no percentage.
 */
export function agentRow(a: Activity, g: AgentActivity, now: number, stats: AgentStats = {}): Meter {
  const own = a.todos[g.id] ?? []
  const est = agentEstimate(g, own, a.listStarted[g.id] ?? null, stats, now)
  const elapsed = Math.max(0, (g.endedAt ?? now) - g.startedAt)
  const facts = `${shortModel(g.model)} · ${g.steps} steps · ${g.tools} tools · ${compact(allTokens(g.tokens))} tok${g.unknown > 0 ? ` (+${g.unknown} unreported)` : ''} · ${duration(elapsed)}`
  const mark = g.status === 'running' ? '▸' : g.status === 'done' ? '✓' : '✗'
  const ownProgress = progress(own)
  let value: string
  let when: string | null = null
  if (g.status !== 'running') value = g.status
  else if (est.status === 'overdue') value = 'over usual'
  else if (est.fraction !== null) value = ownProgress ? `${ownProgress.done}/${ownProgress.total}` : `~${Math.round(est.fraction * 100)}%`
  else value = 'working'
  if (g.status === 'running') {
    when = est.status === 'estimate' ? etaText(est) : est.status === 'estimating' ? 'time left: estimating' : null
  }
  const tone: Tone = g.status === 'failed' || g.status === 'stopped' ? 'error' : g.status === 'done' ? 'success' : est.status === 'overdue' ? 'warning' : 'accent'
  return {
    key: `agent-${g.id}`,
    label: `${mark} ${g.type}`,
    bar: est.fraction !== null ? { fraction: est.fraction, tone } : null,
    value,
    valueTone: tone,
    note: [g.description, when, facts, g.status === 'running' ? est.basis : null].filter(Boolean).join(' · '),
  }
}

export function recommendations(v: View): Recommendation[] {
  const rt = v.rt
  const phase = rt.phase
  const weekly = projections(v).find(p => p.kind === 'seven_day') ?? null
  const could = v.prefs.state !== 'on' && v.ledger.routedRequests === 0 ? cacheAwareHeadline(v.ledger.cacheAware, false) : null
  const potential = could ? { usd: could.usd, percent: could.percent } : null
  const phaseId = phase?.id ?? ''
  const dismissed = v.activity.dismissed.filter(d => d.endsWith(`@${phaseId}`)).map(d => d.slice(0, d.lastIndexOf('@')))
  return recommend({
    state: v.prefs.state,
    mode: v.prefs.mode,
    contextPercent: v.activity.context?.percent ?? null,
    promptTokens: v.activity.context?.tokens ?? rt.lastPromptTokens,
    isWorking: v.isWorking,
    idleMs: (v.rt.lastMainRequestAt ?? v.activity.lastRequestAt) === null ? null : v.now - ((v.rt.lastMainRequestAt ?? v.activity.lastRequestAt) as number),
    cacheTtlMs: cacheTtlOf(v.prefs) === '1h' ? 3_600_000 : 300_000,
    phaseVerdict: verdict(v.validation, codeNow(v)),
    phaseStartContext: phase?.startContext ?? 0,
    phaseOrdinal: phase?.ordinal ?? 0,
    weekly,
    potential: potential ? { usd: potential.usd, percent: potential.percent } : null,
    dismissed,
    planPrompt: phase?.planPrompt ?? false,
    tasksDone: (() => {
      const p = progress(taskList(v.activity, MAIN))
      return p !== null && p.done === p.total
    })(),
  })
}

export function band(v: View): BandModel {
  const g = glyphs(v.prefs)
  const head = headline(v)
  const d = v.rt.phase?.decision
  const list = taskList(v.activity, MAIN)
  const agents = phaseAgents(v.activity, v.rt.phase?.id ?? null)
  const estimates = agents.map(g => agentEstimate(g, v.activity.todos[g.id] ?? [], v.activity.listStarted[g.id] ?? null, v.agentStats, v.now))
  const running = agents.filter(g => g.status === 'running')
  const meters = [contextMeter(v), weeklyMeter(v)].filter((m): m is Meter => m !== null)
  const work = [taskMeter(list, 'tasks', 'Tasks', listStartedAt(v.activity, MAIN), v.now), agentsMeter(agents, estimates)].filter((m): m is Meter => m !== null)
  const tips = recommendations(v)
  const activeReq = Object.values(v.rt.active).find(a => !a.agentId)
  return {
    head: { text: head.text, tone: head.tone },
    selection: selection(v),
    effort: effortText(v),
    mode: modeLabel(v.prefs),
    active: v.isWorking && activeReq ? `${shortModel(activeReq.model)}${activeReq.effort ? ` · effort ${activeReq.effort}` : ''} working` : null,
    savings: savingsMeter(v),
    meters,
    work,
    agentRows: running.slice(0, 3).map(g => agentRow(v.activity, g, v.now, v.agentStats)),
    tip: tips[0] ?? null,
    tipCount: tips.length,
    degraded: v.rt.degraded ? `${g.bad} ${v.rt.degraded}` : null,
    why: d && v.prefs.state !== 'off' && v.prefs.ui.showReason ? d.reason : null,
    paused: v.prefs.state !== 'off' && isPausedView(v),
  }
}

export type TierBar = { tier: 'cheap' | 'middle' | 'strong' | 'other'; label: string; requests: number; fraction: number; tone: Tone }

/** How the session's requests spread over the tiers, for the pane's share bar. */
export function tierBars(v: View): TierBar[] {
  const s = tierShare(v.ledger, m => tierOfModel(m, v.prefs))
  if (s.total === 0) return []
  const rows: TierBar[] = [
    { tier: 'cheap', label: shortModel(v.prefs.models.cheap), requests: s.cheap, fraction: s.cheap / s.total, tone: 'success' },
    { tier: 'middle', label: shortModel(v.prefs.models.middle), requests: s.middle, fraction: s.middle / s.total, tone: 'accent' },
    { tier: 'strong', label: shortModel(v.prefs.models.strong), requests: s.strong, fraction: s.strong / s.total, tone: 'brand' },
    { tier: 'other', label: 'other', requests: s.other, fraction: s.other / s.total, tone: 'inactive' },
  ]
  return rows.filter(r => r.requests > 0)
}

export function taskLines(list: TaskItem[], ascii: boolean): { text: string; tone: Tone }[] {
  return list.slice(0, 12).map(t => ({
    text: `${t.status === 'completed' ? (ascii ? '[x]' : '✓') : t.status === 'in_progress' ? (ascii ? '[>]' : '▸') : ascii ? '[ ]' : '○'} ${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}`,
    tone: t.status === 'completed' ? 'inactive' : t.status === 'in_progress' ? 'accent' : 'text',
  }))
}

export function lifetimeLine(log: SavingsEntry[]): string {
  const l = lifetime(log)
  const legacy = l.legacy > 0 ? ` (${l.legacy} earlier session(s) priced the old way, which overstated savings, are not counted)` : ''
  if (l.sessions === 0) return `No sessions recorded with the cache-aware estimate yet${legacy}.`
  const pct = l.percent !== null ? ` (${Math.abs(l.percent)}% ${l.usd >= 0 ? 'less' : 'more'})` : ''
  const failed = l.failedPhases > 0 ? ` · ${l.failedPhases} task(s) failed their checks` : ''
  return `${l.sessions} session(s): est. ${usd(Math.abs(l.usd))} ${l.usd >= 0 ? 'lower' : 'higher'} at list prices, cache-aware${pct}${failed}${legacy}`
}

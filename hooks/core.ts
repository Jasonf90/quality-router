// Pure pieces of the adapter: initial values, the store's keys, the step
// plan, scope updates, phase and experiment outcomes, and fixed texts.
// The engine requires every use of `$` to stay inside the hooks module
// itself (register.tsx), so whatever can be computed without `$` lives here,
// where it is unit-tested directly.

import type {
  AgentRoute,
  CheckKind,
  Decision,
  Effort,
  ExperimentArm,
  History,
  Phase,
  PhaseOutcome,
  Prefs,
  ProjectConfig,
  Purpose,
  Role,
  RouterMode,
  RouterState,
  Runtime,
  ScopeRoute,
  Validation,
} from '../types'
import { zeroTokens } from './accounting'
import { checkStatus, scopeFloor, verdict } from './escalation'
import { decide } from './policy'
import { compareExperiment } from './savings'
import { tierOfModel } from './settings'

export const PANE = 'quality-router'
export const MAIN = 'main'

export const EMPTY_RUNTIME: Runtime = {
  epoch: 0,
  code: { source: 0, test: 0 },
  phase: null,
  agents: {},
  active: {},
  sessionModel: null,
  observedModel: null,
  sessionEffort: null,
  lastEffort: { sent: null, applied: null },
  lastPromptTokens: 0,
  lastRoutedTier: null,
  manual: null,
  degraded: null,
  unavailableModels: [],
  reviewSuggested: null,
  reviewsRequested: 0,
}

export const EMPTY_PROJECT: ProjectConfig = {
  checks: [],
  required: [],
  acceptance: [],
  riskPaths: [],
  floor: null,
  loadedFrom: null,
  problems: [],
}

export const EMPTY_HISTORY: History = { decisions: [], requests: [], phases: [] }

export const STORE = {
  prefs: 'prefs',
  /** The last settings a guarded copy wrote: what an older copy's overwrite is undone to. */
  prefsGood: 'prefs-good',
  /** When an older copy's overwrite was undone, and what it had changed. */
  prefsRestored: 'prefs-restored',
  limits: 'limits',
  experiments: 'experiments',
  ledgerIndex: 'ledger-index',
  ledger: (sessionId: string) => `ledger:${sessionId}`,
} as const

export const STATE_NOTE: Record<RouterState, string> = {
  on: 'Router ON: decisions apply from the next model request; a request already in flight is not changed.',
  off: 'Router OFF: Claude Code selects the model from the next request. Usage tracking and the band stay; nothing is cancelled or replayed.',
  'dry-run': 'Router DRY RUN: decisions are logged, never applied. Paid classifier calls stay off unless you enable them (/quality-router classifier dry-run on).',
}

/**
 * What each mode changes, as the tables in policy.ts, effort.ts and
 * escalation.ts actually define it. Shown when the mode is switched.
 */
export const MODE_NOTE: Record<RouterMode, string> = {
  'quality-first':
    'Quality-first mode: only mechanical, extraction, summarize and classify work runs on the cheap tier; a choice under 0.6 confidence moves up a tier; critical work gets at least high effort. Applies from the next model request.',
  balanced:
    'Balanced mode: docs join the cheap tier; a choice under 0.5 confidence moves up a tier; critical work gets at least medium effort. Applies from the next model request.',
  economy:
    'Economy mode: docs and questions join the cheap tier; strong-tier work that is not architecture, diagnosis or review drops to middle; a choice under 0.4 confidence moves up a tier; no effort floor. Applies from the next model request.',
}

export const REVIEW_PROMPT_HEAD = 'Quality Router review request: please do a security review'

/**
 * Claude Code in an SDK host (the desktop app, `-p`) refuses `$.session.compact`
 * and compacts only through the `/compact` command; its refusal says so.
 */
export function needsCompactCommand(refusal: string): boolean {
  return /headless|\bSDK\b/i.test(refusal)
}

/** Whether `/compact`'s own output reports that it did not compact. */
export function compactCommandFailed(output: string): boolean {
  return /error|fail|not enough|cannot|can't|nothing to compact/i.test(output)
}

/**
 * What a summary should keep, for every compaction the router starts or
 * shapes: the task's goal, decisions, files, open problems and next steps,
 * the plan in full when there is one, and what summaries tend to lose (the
 * person's stated preferences and constraints, approaches already rejected,
 * unresolved errors word for word).
 */
export function compactInstructions(category: string | null, keepPlan: boolean): string {
  const focus = category ? `the current ${category} task` : 'the current task'
  const plan = keepPlan ? ' Keep any plan in full: every phase or step, which are done, which is current and what comes next.' : ''
  return `Keep ${focus}: its goal, the decisions made, the files involved, open problems and next steps.${plan} Keep, in the person's own words where possible, the preferences and constraints they stated, the approaches already tried and rejected (and why), and any unresolved error messages verbatim. Drop superseded detail and finished side quests.`
}

export function reviewPrompt(files: string): string {
  return `${REVIEW_PROMPT_HEAD} of the changes just made${files ? ` to ${files}` : ''}. Check correctness, authentication, data handling and error paths. Report findings first; change code only to fix a defect you can demonstrate.`
}

export type StepPlan = {
  rewrite: boolean
  model: string
  effort?: Effort
  purpose: Purpose
  role: Role
  phaseId: string | null
  proposed: Decision | null
  /** The model the router chose (ON) or would have chosen (DRY RUN), as it would be sent. */
  proposedModel: string | null
}

export function passThrough(e: { model: string; agentId?: string }, phaseId: string | null = null): StepPlan {
  return { rewrite: false, model: e.model, purpose: 'normal', role: e.agentId ? 'subagent' : 'main', phaseId, proposed: null, proposedModel: null }
}

/**
 * Whether a request is rewritten, given the decision for its scope. Only ON
 * rewrites; never while the person's own model choice holds; never with a
 * decision from an older epoch; never to a model that failed this session.
 * A decision for the tier the session's own model already belongs to keeps
 * that exact model (its context-window variant included).
 */
export function planStep(args: {
  prefs: Prefs
  rt: Runtime
  e: { model: string; effort?: Effort | number; agentId?: string }
  decision: Decision | null
  applies: boolean
}): StepPlan {
  const { prefs, rt, e, decision } = args
  const plan = passThrough(e, rt.phase?.id ?? null)
  if (!decision) return plan
  plan.proposed = decision
  plan.purpose = decision.source === 'escalation' ? 'escalated' : 'normal'
  const sameTier = decision.source !== 'override' && tierOfModel(e.model, prefs) === decision.tier
  plan.proposedModel = sameTier ? e.model : decision.model
  if (prefs.state !== 'on' || !args.applies) return plan
  if (rt.unavailableModels.includes(decision.model)) return plan
  if (!e.agentId && decision.epoch !== rt.epoch) return plan
  const model = sameTier ? e.model : decision.model
  const effort = decision.effort
  const rewrite = model !== e.model || (effort !== undefined && effort !== e.effort)
  return { ...plan, rewrite, model, ...(effort ? { effort } : {}) }
}

export function isPaused(rt: Runtime, prefs: Prefs): boolean {
  return rt.manual !== null && prefs.respectManual && prefs.override.kind === 'auto'
}

/**
 * Applies a change to one scope: the main phase (whose decision is dropped so
 * the next request decides again, with the escalation) or one subagent (whose
 * decision is recomputed at once: a subagent has no phase boundary).
 */
export function withScope(
  r: Runtime,
  scopeId: string,
  prefs: Prefs,
  project: ProjectConfig,
  now: number,
  change: (s: ScopeRoute) => ScopeRoute,
  riskEdit: string | null,
): Runtime {
  if (scopeId === MAIN) {
    if (!r.phase) return r
    const before = r.phase.escalations
    const s = change(r.phase)
    const tierNow = r.phase.decision?.tier ?? tierOfModel(r.sessionModel, prefs)
    const editsBelowStrong =
      riskEdit && tierNow !== 'strong' ? [...new Set([...r.phase.editsBelowStrong, riskEdit])].slice(-6) : r.phase.editsBelowStrong
    const phase: Phase = { ...r.phase, ...s, editsBelowStrong, decision: s.escalations > before ? null : r.phase.decision }
    return { ...r, phase }
  }
  const agent = r.agents[scopeId]
  if (!agent) return r
  const s = change(agent)
  let decision = agent.decision
  if (s.escalations > agent.escalations && decision && decision.source !== 'explicit') {
    decision = decide({
      prefs,
      analysis: agent.analysis,
      verdict: null,
      escalations: s.escalations,
      escalationReason: s.escalationReasons[s.escalationReasons.length - 1],
      projectFloor: project.floor,
      scopeFloor: scopeFloor(s),
      previousTier: decision.tier,
      promptTokens: 0,
      epoch: r.epoch,
      now,
      sessionEffort: decision.baseEffort ?? r.sessionEffort,
    })
  }
  const next: AgentRoute = { ...agent, ...s, decision }
  return { ...r, agents: { ...r.agents, [scopeId]: next } }
}

export function newPhase(id: string, now: number, promptDigest: string, analysis: Phase['analysis'], startContext = 0, ordinal = 0): Phase {
  return {
    decision: null,
    escalations: 0,
    escalationReasons: [],
    sourceVersion: 0,
    testVersion: 0,
    startSourceVersion: 0,
    repair: {},
    riskTouched: [],
    tdd: analysis?.tdd ?? false,
    id,
    startedAt: now,
    promptDigest,
    analysis,
    classified: 'none',
    verdict: null,
    tokens: zeroTokens(),
    unknown: 0,
    editsBelowStrong: [],
    startContext,
    ordinal,
    requests: 0,
    analysisSource: 'prompt',
    planPrompt: false,
    tasksDigest: null,
    promptRisk: analysis?.risk ?? 'low',
  }
}

export function codeVersions(rt: Runtime): { sourceVersion: number; testVersion: number } {
  return { sourceVersion: rt.code.source, testVersion: rt.code.test }
}

export function phaseOutcome(phase: Phase, v: Validation, rt: Runtime): PhaseOutcome {
  return {
    phaseId: phase.id,
    tier: phase.decision?.tier ?? null,
    escalations: phase.escalations,
    verdict: verdict(v, codeVersions(rt)),
    requests: phase.requests,
    tokens: phase.tokens,
    unknown: phase.unknown,
  }
}

export function checkOutcome(v: Validation, rt: Runtime): ExperimentArm['outcome'] {
  const kinds = v.required.length > 0 ? v.required : (Object.keys(v.checks) as CheckKind[])
  const outcome = { passed: 0, failed: 0, notRun: 0 }
  for (const k of kinds) {
    const s = checkStatus(v, k, codeVersions(rt))
    if (s === 'passed') outcome.passed++
    else if (s === 'failed') outcome.failed++
    else outcome.notRun++
  }
  return outcome
}

export function emptyArm(
  args: Omit<ExperimentArm, 'tokens' | 'requests' | 'unknown' | 'classifierTokens' | 'escalations' | 'retries' | 'durationMs' | 'outcome' | 'endedAt'>,
): ExperimentArm {
  return {
    ...args,
    endedAt: null,
    tokens: zeroTokens(),
    requests: 0,
    unknown: 0,
    classifierTokens: zeroTokens(),
    escalations: 0,
    retries: 0,
    durationMs: 0,
    outcome: { passed: 0, failed: 0, notRun: 0 },
  }
}

export function experimentReport(list: ExperimentArm[], label: string): string {
  const c = compareExperiment(list, label)
  if (c.status === 'no-baseline') return `No comparable baseline: ${c.reason}.`
  if (c.status === 'not-comparable') return `No comparable baseline: ${c.reason} (${c.mismatched.join(', ')}).`
  const r = c.reduction
  const fmt = (n: number) => (n >= 0 ? `${n} fewer` : `${-n} MORE`)
  const lines = [
    `Experiment "${label}": ${c.runs.routed} routed run(s) vs ${c.runs.baseline} baseline run(s), mean per run`,
    `  input ${fmt(r.input)} · output ${fmt(r.output)} · cache read ${fmt(r.cacheRead)} · cache write ${fmt(r.cacheWrite)}`,
    `  combined volume: ${fmt(r.all)}${r.allPercent === null ? '' : ` (${r.allPercent}%)`} (negative means routing used more)`,
    `  routing overhead (classifier): in ${c.routed.classifierTokens.input} · out ${c.routed.classifierTokens.output}`,
    `  retries routed ${c.routed.retries} vs ${c.baseline.retries} · escalations ${c.routed.escalations} · duration ${Math.round(c.routed.durationMs / 1000)}s vs ${Math.round(c.baseline.durationMs / 1000)}s`,
    `  validation routed: passed ${c.routed.outcome.passed} failed ${c.routed.outcome.failed} not run ${c.routed.outcome.notRun}; baseline: passed ${c.baseline.outcome.passed} failed ${c.baseline.outcome.failed} not run ${c.baseline.outcome.notRun}`,
  ]
  if (c.routedFailedValidation) lines.push('  The routed runs failed validation where the baseline passed: this is not a successful optimization.')
  for (const l of c.limitations) lines.push(`  - ${l}`)
  return lines.join('\n')
}

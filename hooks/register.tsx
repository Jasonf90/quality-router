// Quality Router's hooks module: the native adapter and the one place that
// touches `$` (the engine requires every use of `$` to stay in this file).
// Decisions, accounting, validation, savings and limits are pure modules
// beside it; this file reads and writes state, listens to events and draws.
//
// Failure policy: the router fails OPEN. If its own work throws, the request,
// tool call or spawn proceeds exactly as Claude Code meant it to.
//
// State: session values in `$.state` (they survive a hot reload; the engine
// resets them on /clear and /resume, so preferences reload from the store),
// lasting values in `$.store`. Every write is a versioned read-modify-write
// (`update`), so concurrent subagents never overwrite each other's changes.

import { atom, read, update } from 'claude-code'
import type {
  AgentSpawnInput,
  AgentSpawnResult,
  EngineInterface,
  ModelCompleteResult,
  Register,
  ToolCallInput,
  ToolCallResult,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type {
  Activity,
  Analysis,
  CompactObservation,
  ActiveRequest,
  AgentStats,
  AgentRoute,
  Decision,
  DecisionLogEntry,
  ExperimentArm,
  Ledger,
  Limits,
  Prefs,
  ProjectConfig,
  RequestRecord,
  RouterMode,
  RouterState,
  Runtime,
  SavingsEntry,
  Tokens,
} from '../types'
import { addRequest, addTokens, emptyLedger, fromUsage, promptTokens, restoreLedger } from './accounting'
import {
  MAIN as MAIN_SCOPE,
  agentStep,
  agentTool,
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  applyTodoWrite,
  emptyActivity,
  endAgent,
  listStartedAt,
  phaseAgents,
  startAgent,
  progress,
  taskList,
} from './activity'
import { CLASSIFIER_SYSTEM, buildClassifierPrompt, digest, parseVerdict, shouldClassify } from './classifier'
import { autoCompactDue, smartCompactDue, watchReport } from './advisor'
import { type Action, HELP, parseCommand } from './commands'
import {
  EMPTY_HISTORY,
  EMPTY_PROJECT,
  EMPTY_RUNTIME,
  MAIN,
  MODE_NOTE,
  PANE,
  STATE_NOTE,
  STORE,
  type StepPlan,
  checkOutcome,
  codeVersions,
  compactInstructions,
  compactCommandFailed,
  emptyArm,
  experimentReport,
  isPaused,
  needsCompactCommand,
  newPhase,
  passThrough,
  phaseOutcome,
  planStep,
  reviewPrompt,
  withScope,
  REVIEW_PROMPT_HEAD,
} from './core'
import {
  applyCheck,
  applyCodeEdit,
  applyRisk,
  bashWritesCode,
  classifyOutcome,
  compileChecks,
  emptyValidation,
  isCodeFile,
  isDestructive,
  isTestPath,
  matchCheck,
  recordCheck,
  recordEdit,
  riskyPath,
  scopeFloor,
  verdict,
} from './escalation'
import { agentEstimate, recordRun } from './eta'
import { addReading } from './limits'
import { type Meter, type Tone, type View, agentRow, agentsMeter, band, barCells, barChars, contextMeter, lifetimeLine, limitMeter, recommendations, savingsMeter, sessionSavings, taskLines, taskMeter, tierBars } from './present'
import { CLAUDE_CODE_COMPACT_BUFFER, cacheAwareStep, compactionDone, compactionReset, compactionStep, emptyCacheAware, emptyCompaction, logSavings } from './savings'
import { analyzePrompt, analyzeSubagent, answerDemands, assessFromTasks, decide, isExecution, isFollowUp, isPlanPrompt, raisesTask, strongerAnalysis } from './policy'
import { type TtlEvidence, expectedPhaseRequests, resolveTtl, switchPays, ttlEvidence } from './economics'
import { DEFAULT_PREFS, cacheTtlOf, describePrefsChange, nextMode, normalizePrefs, parseProjectConfig, prefsStamp, routingChanged, shortModel, stampValid, tierOfModel, tierRank } from './settings'
import {
  MODE_LABEL,
  type Snapshot,
  checksLine,
  configText,
  historyText,
  limitsText,
  projections,
  statusText,
  usageText,
} from './view'

type Engine = EngineInterface

// --- state ---------------------------------------------------------------------

const prefsAtom = atom({ plugin: 'quality-router', key: 'prefs' } as const, DEFAULT_PREFS)
const runtimeAtom = atom({ plugin: 'quality-router', key: 'runtime' } as const, EMPTY_RUNTIME)
const ledgerAtom = atom({ plugin: 'quality-router', key: 'ledger' } as const, emptyLedger('', 0))
const validationAtom = atom({ plugin: 'quality-router', key: 'validation' } as const, emptyValidation(null, null))
const historyAtom = atom({ plugin: 'quality-router', key: 'history' } as const, EMPTY_HISTORY)
const limitsAtom = atom({ plugin: 'quality-router', key: 'limits' } as const, { tracks: {}, latest: [] } as Limits)
const projectAtom = atom({ plugin: 'quality-router', key: 'project' } as const, EMPTY_PROJECT)
const experimentAtom = atom({ plugin: 'quality-router', key: 'experiment' } as const, null as ExperimentArm | null)
const activityAtom = atom({ plugin: 'quality-router', key: 'activity' } as const, emptyActivity())
const savingsLogAtom = atom({ plugin: 'quality-router', key: 'savingsLog' } as const, [] as SavingsEntry[])
const agentStatsAtom = atom({ plugin: 'quality-router', key: 'agentStats' } as const, {} as AgentStats)

const AGENT_STATS = 'agent-stats'

const SAVINGS_LOG = 'savings-log'

/**
 * The text of the current phase's prompt, in memory only, until the
 * classifier has read it or the phase ends. Never stored or logged.
 */
const pendingText = new Map<string, string>()

/** Per main turn, the usage its requests reported, checked against the turn's own total. */
const turnTotals = new Map<string, Tokens>()

/** Runs the router's own bookkeeping; a failure there never reaches the session. */
async function safe(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // Fail open: the event proceeds as Claude Code meant it to.
  }
}

/**
 * Preferences as they stand. When the session's state holds none yet (a new
 * session, or the engine reset it on /clear), they come from the store and,
 * outside a render, are written back into the session's state.
 */
/** What idle gaps have shown about the prompt cache's lifetime (economics.ttlEvidence), kept across sessions. */
const TTL_EVIDENCE = 'cache-ttl-evidence'
let ttlEv: TtlEvidence | null = null

async function loadTtlEvidence($: Engine): Promise<TtlEvidence> {
  if (ttlEv) return ttlEv
  const raw = (await $.store.get(TTL_EVIDENCE)) as Partial<TtlEvidence> | undefined
  ttlEv = { longReads: Number(raw?.longReads) || 0, expiries: Number(raw?.expiries) || 0 }
  return ttlEv
}

/** Preferences with the cache lifetime resolved ('auto' → what idle gaps showed), for pricing and switch economics. */
async function priced($: Engine, prefs: Prefs): Promise<Prefs> {
  return { ...prefs, cacheTtl: resolveTtl(prefs.cacheTtl, await loadTtlEvidence($)) }
}

async function getPrefs($: Engine, canWrite = true): Promise<Prefs> {
  const held = await $.state.get({ plugin: 'quality-router', key: 'prefs' })
  if (held.version > 0 && held.value) return held.value
  const stored = normalizePrefs((await $.store.get(STORE.prefs)) ?? {})
  if (canWrite) await update($, prefsAtom, () => stored)
  return stored
}

/**
 * THE preference setter: the band's buttons, every command and session
 * loading come through here. A routing-relevant change bumps the epoch, which
 * drops current decisions (the next request is assessed afresh) and voids any
 * classifier call still in flight.
 */
async function setPrefs($: Engine, change: (p: Prefs) => Prefs): Promise<Prefs> {
  await guardPrefs($)
  const before = await getPrefs($)
  // Settings are shared by every session. The change is applied to what is
  // stored now, not to this session's copy, which another session may have
  // made stale: a change here then never undoes one made there. Stored fields
  // this version does not know (a newer copy's) are kept too.
  const stored = await $.store.get(STORE.prefs)
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  const latest = stored === undefined ? before : normalizePrefs(raw)
  const after = normalizePrefs(change(latest))
  await update($, prefsAtom, () => after)
  await writePrefs($, { ...raw, ...after })
  if (routingChanged(before, after)) {
    await update($, runtimeAtom, rt => ({
      ...rt,
      epoch: rt.epoch + 1,
      phase: rt.phase
        ? { ...rt.phase, decision: null, classified: rt.phase.classified === 'pending' ? 'none' : rt.phase.classified }
        : null,
    }))
  }
  return after
}

/** Stores settings stamped, and keeps them as the reference an older copy's overwrite is undone to. */
async function writePrefs($: Engine, raw: Record<string, unknown>): Promise<void> {
  const body: Record<string, unknown> = { ...raw }
  delete body.stamp
  body.stamp = prefsStamp(body)
  await $.store.set(STORE.prefs, body)
  await $.store.set(STORE.prefsGood, body)
}

/**
 * Settings are shared, and a session still running an older copy of the
 * router saves its own stale copy over them: one set Economy and switched
 * auto-compact off. Every write from this version is stamped and kept as the
 * reference; stored settings whose stamp does not match came from an older
 * copy, and the reference is put back, with a notice saying what was undone.
 */
async function guardPrefs($: Engine): Promise<void> {
  const stored = await $.store.get(STORE.prefs)
  if (stored === undefined || stampValid(stored)) return
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  const good = await $.store.get(STORE.prefsGood)
  if (!good || typeof good !== 'object' || Array.isArray(good) || !stampValid(good)) {
    // The first run of a guarded copy: what is stored becomes the reference.
    await writePrefs($, raw)
    return
  }
  const changes = describePrefsChange(normalizePrefs(good), normalizePrefs(raw))
  await writePrefs($, good as Record<string, unknown>)
  const restored = normalizePrefs(good)
  const held = await $.state.get({ plugin: 'quality-router', key: 'prefs' })
  if (held.version > 0 && held.value) {
    await update($, prefsAtom, () => restored)
    if (routingChanged(held.value, restored)) {
      await update($, runtimeAtom, rt => ({ ...rt, epoch: rt.epoch + 1, phase: rt.phase ? { ...rt.phase, decision: null } : null }))
    }
  }
  if (changes.length === 0) return
  const at = await $.clock.now()
  const log = await $.store.get(STORE.prefsRestored)
  await $.store.set(STORE.prefsRestored, [...(Array.isArray(log) ? log : []), { at, changes }].slice(-20))
  await notify(
    $,
    `Quality Router: an older copy of the router in another session changed the shared settings (${changes.join(', ')}). They were put back. If you made that change on purpose, make it again here. Sessions started before this version was installed still run the old copy; restarting them stops this.`,
    'warning',
    20_000,
  )
}

function patchRuntime($: Engine, change: (rt: Runtime) => Runtime): Promise<Runtime> {
  return update($, runtimeAtom, change)
}

function patchActivity($: Engine, change: (a: Activity) => Activity): Promise<Activity> {
  return update($, activityAtom, change)
}

/** The savings of earlier sessions, from the store when the session's state holds none yet. */
async function loadSavingsLog($: Engine, canWrite = true): Promise<SavingsEntry[]> {
  const held = await $.state.get({ plugin: 'quality-router', key: 'savingsLog' })
  if (held.version > 0 && held.value) return held.value
  const raw = await $.store.get(SAVINGS_LOG)
  const log = Array.isArray(raw) ? (raw as SavingsEntry[]) : []
  if (canWrite) await update($, savingsLogAtom, () => log)
  return log
}

/** Finished subagent runs per type (for estimates), from the store when the session's state holds none. */
async function loadAgentStats($: Engine, canWrite = true): Promise<AgentStats> {
  const held = await $.state.get({ plugin: 'quality-router', key: 'agentStats' })
  if (held.version > 0 && held.value) return held.value
  const raw = await $.store.get(AGENT_STATS)
  const stats = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AgentStats) : {}
  if (canWrite) await update($, agentStatsAtom, () => stats)
  return stats
}

/** Folds this session's current estimate into the savings log and stores it. */
async function recordSavings($: Engine): Promise<void> {
  const ledger = await read($, ledgerAtom)
  const comp = ledger.compaction
  const compacted = comp !== undefined && comp.count - comp.unpriced > 0
  if (!ledger.sessionId || (ledger.routedRequests === 0 && !compacted)) return
  const ca = ledger.cacheAware
  if (!ca || ca.priced === 0 || ca.stayUsd <= 0) return
  const routed = ledger.routedRequests > 0
  const phases = (await read($, historyAtom)).phases
  const entry: SavingsEntry = {
    sessionId: ledger.sessionId,
    at: await $.clock.now(),
    method: 'cache-aware',
    // Not routed: what ran is what staying would have cost.
    routedUsd: ca.actualUsd,
    baselineUsd: routed ? ca.stayUsd : ca.actualUsd,
    requests: ledger.total.requests,
    routedRequests: ledger.routedRequests,
    failedPhases: phases.filter(p => p.verdict === 'failed').length,
    verifiedPhases: phases.filter(p => p.verdict === 'verified').length,
    ...(compacted && comp ? { compactionCostUsd: comp.costUsd, compactionSavedUsd: comp.savedUsd } : {}),
  }
  await loadSavingsLog($)
  const next = await update($, savingsLogAtom, log => logSavings(log, entry))
  await $.store.set(SAVINGS_LOG, next)
}

async function logDecision($: Engine, entry: DecisionLogEntry): Promise<void> {
  await update($, historyAtom, h => ({ ...h, decisions: [...h.decisions, entry].slice(-40) }))
}

/**
 * Counts one request, once: the ledger refuses a key it has seen. Only an
 * accepted request reaches the history and a running experiment.
 */
async function recordRequest($: Engine, rec: RequestRecord): Promise<boolean> {
  let added = false
  await update($, ledgerAtom, l => {
    const r = addRequest(l, rec)
    added = r.added
    return r.ledger
  })
  if (!added) return false
  if (rec.usage) {
    const usage = rec.usage
    const prefs = await priced($, await getPrefs($))
    const step = {
      role: rec.role,
      answered: rec.observedModel ?? rec.requestedModel,
      asked: rec.engineModel ?? rec.requestedModel,
      proposed: rec.proposedModel,
      usage,
      at: rec.at,
    }
    await update($, ledgerAtom, l => ({ ...l, cacheAware: cacheAwareStep(l.cacheAware ?? emptyCacheAware(), step, prefs) }))
    if (rec.role === 'main' && (await read($, ledgerAtom)).compaction?.offset) {
      const window = (await read($, activityAtom)).context?.window ?? null
      const point = window && window > CLAUDE_CODE_COMPACT_BUFFER * 3 ? window - CLAUDE_CODE_COMPACT_BUFFER : null
      const model = rec.observedModel ?? rec.requestedModel
      await update($, ledgerAtom, l => ({ ...l, compaction: compactionStep(l.compaction ?? emptyCompaction(), { promptTokens: promptTokens(usage), model, point, prefs }) }))
    }
  }
  await update($, historyAtom, h => ({ ...h, requests: [...h.requests, rec].slice(-60) }))
  await update($, experimentAtom, x =>
    x
      ? {
          ...x,
          requests: x.requests + 1,
          unknown: x.unknown + (rec.usage === null ? 1 : 0),
          tokens: rec.usage ? addTokens(x.tokens, rec.usage) : x.tokens,
          classifierTokens: rec.role === 'classifier' && rec.usage ? addTokens(x.classifierTokens, rec.usage) : x.classifierTokens,
          retries: x.retries + (rec.purpose === 'fallback' ? 1 : 0),
        }
      : x,
  )
  return true
}

/**
 * This session's ledger. One kept for another session (after /clear or a
 * resume moved on) is stored away; this session's is restored from the store
 * when a restarted process resumes it.
 */
async function ensureLedger($: Engine): Promise<Ledger> {
  const sessionId = await $.session.id()
  const current = await read($, ledgerAtom)
  if (current.sessionId === sessionId) return current
  // A ledger not yet tied to a session (the engine reset the state on /clear
  // and requests were counted since) belongs to this session: keep its counts.
  if (!current.sessionId && current.total.requests > 0) {
    return update($, ledgerAtom, l => ({ ...l, sessionId }))
  }
  if (current.sessionId) await persistLedger($, current)
  const restored = restoreLedger(await $.store.get(STORE.ledger(sessionId)), sessionId, await $.clock.now())
  return update($, ledgerAtom, () => restored)
}

/** Keeps the ledgers of the last 20 sessions; older ones are deleted from the store. */
async function persistLedger($: Engine, ledger: Ledger): Promise<void> {
  // A session that made no request (a quick command, a headless check) has
  // nothing to keep, and would push a real session out of the 20 kept.
  if (!ledger.sessionId || ledger.total.requests === 0) return
  await $.store.set(STORE.ledger(ledger.sessionId), ledger)
  const raw = await $.store.get(STORE.ledgerIndex)
  const index = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
  const next = [...index.filter(s => s !== ledger.sessionId), ledger.sessionId]
  for (const old of next.slice(0, Math.max(0, next.length - 20))) await $.store.delete(STORE.ledger(old))
  await $.store.set(STORE.ledgerIndex, next.slice(-20))
}

async function loadLimits($: Engine): Promise<void> {
  const held = await $.state.get({ plugin: 'quality-router', key: 'limits' })
  if (held.version > 0) return
  const raw = await $.store.get(STORE.limits)
  const tracks = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Limits['tracks']) : {}
  await update($, limitsAtom, l => ({ ...l, tracks: { ...tracks, ...l.tracks } }))
}

async function loadProject($: Engine): Promise<void> {
  let project: ProjectConfig = EMPTY_PROJECT
  try {
    const path = `${await $.session.root()}/.claude/quality-router.json`
    if (await $.fs.exists(path)) {
      const text = await $.fs.read(path)
      try {
        project = parseProjectConfig(JSON.parse(typeof text === 'string' ? text : ''), path)
      } catch {
        project = { ...EMPTY_PROJECT, loadedFrom: path, problems: ['not valid JSON; ignored'] }
      }
    }
  } catch {
    project = { ...EMPTY_PROJECT, problems: ['could not read the project file'] }
  }
  await update($, projectAtom, () => project)
}

async function view($: Engine, isWorking: boolean | null): Promise<View> {
  const s = await snapshot($, false)
  const activity = await read($, activityAtom)
  return {
    ...s,
    activity,
    savingsLog: await loadSavingsLog($, false),
    agentStats: await loadAgentStats($, false),
    isWorking: isWorking ?? Object.values(s.rt.active).some(a => !a.agentId),
  }
}

async function snapshot($: Engine, canWrite: boolean): Promise<Snapshot> {
  return {
    prefs: await priced($, await getPrefs($, canWrite)),
    rt: await read($, runtimeAtom),
    ledger: await read($, ledgerAtom),
    validation: await read($, validationAtom),
    history: await read($, historyAtom),
    limits: await read($, limitsAtom),
    project: await read($, projectAtom),
    experiment: await read($, experimentAtom),
    now: await $.clock.now(),
  }
}

// --- session and phases -----------------------------------------------------------

async function onSessionStart($: Engine): Promise<void> {
  await $.command.register({
    name: 'quality-router',
    description: 'Quality Router: routing on/off/dry-run, mode, overrides, usage, limits',
    argumentHint: 'on|off|toggle|dry-run|status|usage|limits|mode|model|floor|reset-task|help',
    immediate: true,
  })
  const prefs = await getPrefs($)
  if ((await $.store.get(STORE.prefs)) === undefined) await writePrefs($, { ...prefs })
  await guardPrefs($)
  await refreshPrefs($)
  await ensureLedger($)
  await ensureLoaded($)
  await refreshStatusLine($)
  // Idle time, elapsed times and time-left estimates move without any event: redraw every 30 seconds.
  $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
}

/** A model change the person made (or the engine's own fallback), as PostModelSwitch reports it. */
async function onModelSwitch($: Engine, e: { to_model: string; source: string }): Promise<void> {
  const now = await $.clock.now()
  if (e.source === 'command' || e.source === 'picker' || e.source === 'sdk') {
    await patchRuntime($, rt => ({
      ...rt,
      epoch: rt.epoch + 1,
      manual: { model: e.to_model, source: e.source, at: now },
      phase: rt.phase ? { ...rt.phase, decision: null } : null,
    }))
  } else if (e.source === 'auto') {
    await patchRuntime($, rt => ({ ...rt, degraded: `Claude Code switched to ${shortModel(e.to_model)} on its own (fallback)` }))
  }
}

/** A new prompt starts a phase, unless it only continues the current one ("yes", "go on"). */
/** Reads the project file and stored history into this session's state, once (again after /clear resets the state). */
async function ensureLoaded($: Engine): Promise<void> {
  if ((await read($, runtimeAtom)).loaded) return
  await patchRuntime($, r => ({ ...r, loaded: true }))
  await loadLimits($)
  await loadProject($)
  await loadSavingsLog($)
  await loadAgentStats($)
}

/** Takes up settings another session changed since this one read them (they are shared). */
async function refreshPrefs($: Engine): Promise<void> {
  await guardPrefs($)
  const held = await getPrefs($)
  const stored = await $.store.get(STORE.prefs)
  if (stored === undefined) return
  const latest = normalizePrefs(stored)
  if (JSON.stringify(latest) === JSON.stringify(held)) return
  await update($, prefsAtom, () => latest)
  if (routingChanged(held, latest)) {
    await update($, runtimeAtom, rt => ({ ...rt, epoch: rt.epoch + 1, phase: rt.phase ? { ...rt.phase, decision: null } : null }))
  }
}

async function onTurnStart($: Engine, e: { text: string; turnId: string }): Promise<void> {
  await refreshPrefs($)
  await ensureLedger($)
  await ensureLoaded($)
  await patchRuntime($, r => (r.turnCommitted ? { ...r, turnCommitted: false } : r))
  const current = sessionSavings(await view($, true))
  await patchActivity($, a => ({ ...a, savingsMark: current ? { kind: current.kind, usd: current.usd } : null }))
  const rt = await read($, runtimeAtom)
  if (rt.phase) {
    const asked = analyzePrompt(e.text)
    if (isFollowUp(e.text, asked)) {
      // The same task goes on. A follow-up that asks for more (a wider change,
      // a riskier one) raises it; nothing a follow-up says lowers it.
      const prefs = await getPrefs($)
      const current = rt.phase.analysis
      let next = current
      if (next && e.text.trim().length > 0 && raisesTask(next, asked, prefs.mode)) next = strongerAnalysis(next, asked, prefs.mode)
      // "Yes", "do it", "let's start working the plan": the work is what the
      // last answer proposed, which these words do not say. When that is high
      // risk or design work (iCloud sync, a schema deployed to production), the
      // task runs at what it demands.
      const proposed = rt.lastAnswer ?? null
      if (next && proposed && isExecution(e.text) && raisesTask(next, proposed, prefs.mode)) next = strongerAnalysis(next, proposed, prefs.mode)
      if (next !== current) {
        const raised = next
        await patchRuntime($, r => (r.phase ? { ...r, phase: { ...r.phase, analysis: raised, decision: null }, lastAnswer: null } : r))
      } else if (proposed) {
        await patchRuntime($, r => ({ ...r, lastAnswer: null }))
      }
      return
    }
  }
  const now = await $.clock.now()
  const ordinal = rt.phase ? rt.phase.ordinal + 1 : 0
  const phase = { ...newPhase(e.turnId, now, digest(e.text), analyzePrompt(e.text), rt.phase ? rt.lastPromptTokens : 0, ordinal), planPrompt: isPlanPrompt(e.text) }
  if (rt.lastAnswer) await patchRuntime($, r => ({ ...r, lastAnswer: null }))
  if (rt.phase) await closePhase($, rt)
  pendingText.clear()
  if (e.text.length > 0) pendingText.set(phase.id, e.text.slice(0, 4000))
  const isReview = e.text.startsWith(REVIEW_PROMPT_HEAD)
  await patchRuntime($, r => ({ ...r, phase, reviewSuggested: null, reviewsRequested: isReview ? 1 : 0 }))
  const project = await read($, projectAtom)
  await update($, validationAtom, () => emptyValidation(phase.id, project))
}

async function closePhase($: Engine, rt: Runtime): Promise<void> {
  if (!rt.phase) return
  const outcome = phaseOutcome(rt.phase, await read($, validationAtom), rt)
  await update($, historyAtom, h => ({ ...h, phases: [...h.phases, outcome].slice(-30) }))
}

/** `/quality-router reset-task`: routing state starts over; usage history stays. */
async function resetTask($: Engine): Promise<void> {
  await closePhase($, await read($, runtimeAtom))
  pendingText.clear()
  await patchRuntime($, r => ({
    ...r,
    epoch: r.epoch + 1,
    phase: null,
    agents: {},
    degraded: null,
    unavailableModels: [],
    reviewSuggested: null,
    reviewsRequested: 0,
  }))
  const project = await read($, projectAtom)
  await update($, validationAtom, () => emptyValidation(null, project))
  await refreshStatusLine($)
}

// --- classification and decisions -------------------------------------------------

/**
 * One classifier call for a phase. It claims the phase first (so concurrent
 * steps do not each call it), records its own usage whatever happens, and
 * applies the verdict only if routing is still wanted on the same epoch and
 * phase when the reply arrives. Error, timeout or a malformed reply: null,
 * and the rules decide conservatively. `$.model.complete` is not a turn
 * step, so it never passes through this router's own `turn.step` hook.
 */
async function classify($: Engine, phaseId: string, text: string, prefs: Prefs, epoch: number, signal: AbortSignal): Promise<void> {
  let claimed = false
  await patchRuntime($, r => {
    if (r.phase?.id !== phaseId || r.epoch !== epoch || r.phase.classified !== 'none') return r
    claimed = true
    return { ...r, phase: { ...r.phase, classified: 'pending' } }
  })
  if (!claimed) return
  const t0 = await $.clock.now()
  let reply: ModelCompleteResult | null = null
  try {
    reply = await $.model.complete(
      { model: prefs.models.cheap, system: CLASSIFIER_SYSTEM, prompt: buildClassifierPrompt(text), maxTokens: 200, effort: 'low', timeoutMs: prefs.classifier.timeoutMs },
      { signal },
    )
  } catch {
    reply = null
  }
  const t1 = await $.clock.now()
  const known = reply !== null && (reply.isAnswered || reply.reason === 'api-error' || reply.reason === 'empty-reply')
  await recordRequest($, {
    key: `classifier:${phaseId}:${epoch}`,
    at: t1,
    role: 'classifier',
    purpose: 'classifier',
    phaseId,
    requestedModel: prefs.models.cheap,
    observedModel: null,
    routed: false,
    proposedModel: null,
    usage: known && reply ? fromUsage(reply.usage) : null,
    durationMs: t1 - t0,
    status: reply?.isAnswered ? 'ok' : reply && !reply.isAnswered && reply.reason === 'aborted' ? 'aborted' : 'no-response',
  })
  const parsed = reply?.isAnswered ? parseVerdict(reply.text) : null
  const now = await getPrefs($)
  const stillWanted = now.state === 'on' || (now.state === 'dry-run' && now.classifier.inDryRun)
  let applied = false
  await patchRuntime($, r => {
    if (r.phase?.id !== phaseId) return r
    if (r.epoch !== epoch || !stillWanted) return { ...r, phase: { ...r.phase, classified: 'none' } }
    applied = true
    return { ...r, phase: { ...r.phase, verdict: parsed, classified: parsed ? 'done' : 'failed' } }
  })
  if (applied) pendingText.delete(phaseId)
}

/** The main loop's decision for this phase: cached until the epoch moves or an escalation drops it. */
async function decideMain($: Engine, e: TurnStepInput, signal: AbortSignal): Promise<Decision | null> {
  let prefs = await getPrefs($)
  let rt = await read($, runtimeAtom)
  const first = rt.phase
  if (!first || !first.analysis) return null
  if (first.decision && first.decision.epoch === rt.epoch && (first.decision.baseEffort ?? null) === rt.sessionEffort) return first.decision
  const text = pendingText.get(first.id)
  if (!first.verdict && first.classified === 'none' && text !== undefined && shouldClassify({ prefs, analysis: first.analysis, textLength: text.length, alreadyClassified: false, planPrompt: first.planPrompt })) {
    await classify($, first.id, text, prefs, rt.epoch, signal)
    prefs = await getPrefs($)
    rt = await read($, runtimeAtom)
    if (prefs.state === 'off') return null
  }
  const phase = rt.phase
  if (!phase || phase.id !== first.id || !phase.analysis) return null
  const project = await read($, projectAtom)
  const now = await $.clock.now()
  const validation = await read($, validationAtom)
  const economics = await switchContext($, rt, await priced($, prefs), phase.requests, e.model)
  let decision = decide({
    prefs,
    analysis: phase.analysis,
    verdict: phase.verdict,
    escalations: phase.escalations,
    escalationReason: phase.escalationReasons[phase.escalationReasons.length - 1],
    projectFloor: project.floor,
    scopeFloor: scopeFloor(phase),
    previousTier: rt.lastRoutedTier ?? tierOfModel(rt.sessionModel ?? e.model, prefs),
    promptTokens: rt.lastPromptTokens,
    epoch: rt.epoch,
    now,
    sessionEffort: rt.sessionEffort,
    phaseFailed: Object.values(validation.checks).some(c => c.status === 'failed'),
    fallback: phase.classified === 'failed',
    holdCheck: (toTier, toModel) => {
      const v = switchPays({ ...economics.base, toModel })
      return v.pays === null ? null : { hold: !v.pays, reason: v.reason }
    },
    holdEffortLowering: economics.base.cacheWarm && rt.lastPromptTokens >= 100_000,
  })
  if (phase.classified === 'failed' && decision.source === 'rules') {
    decision = { ...decision, source: 'fallback', reason: `classifier unavailable; ${decision.reason}`.slice(0, 200) }
  }
  let stored = false
  await patchRuntime($, r => {
    if (!r.phase || r.phase.id !== phase.id || r.epoch !== decision.epoch) return r
    stored = true
    return { ...r, phase: { ...r.phase, decision } }
  })
  if (stored) {
    await logDecision($, { at: now, scope: MAIN, tier: decision.tier, model: decision.model, ...(decision.effort ? { effort: decision.effort } : {}), source: decision.source, applied: prefs.state === 'on', reason: decision.reason })
  }
  return decision
}

/**
 * What a model switch would be weighed against: the model the cache is on,
 * the prompt size, whether the cache is still warm, the requests this phase
 * is expected to make (this session's median phase) and the average output.
 */
async function switchContext($: Engine, rt: Runtime, prefs: Prefs, phaseRequests: number, sessionModel: string) {
  const history = await read($, historyAtom)
  const ledger = await read($, ledgerAtom)
  const now = await $.clock.now()
  const ttlMs = cacheTtlOf(prefs) === '1h' ? 3_600_000 : 300_000
  const lastMain = rt.lastMainRequestAt ?? null
  const cacheWarm = lastMain !== null && now - lastMain < ttlMs
  const expected = expectedPhaseRequests(history.phases.map(p => p.requests ?? 0), phaseRequests)
  const main = ledger.byRole.main
  const known = main ? main.requests - main.unknown : 0
  const avgOutput = main && known > 0 ? main.tokens.output / known : 1500
  return {
    base: {
      prefs,
      fromModel: rt.observedModel ?? rt.sessionModel ?? sessionModel,
      toModel: sessionModel,
      promptTokens: rt.lastPromptTokens,
      expectedRequests: expected.n,
      expectedSource: expected.source,
      avgOutput,
      cacheWarm,
    },
  }
}

/** What to send for one model request (see core.planStep for the rules). */
async function prepareStep($: Engine, e: TurnStepInput, signal: AbortSignal): Promise<StepPlan> {
  const prefs = await getPrefs($)
  let rt = await read($, runtimeAtom)
  const effortNow = e.effort === undefined ? null : String(e.effort)
  if (!e.agentId && (rt.sessionModel !== e.model || rt.sessionEffort !== effortNow)) {
    rt = await patchRuntime($, r => ({ ...r, sessionModel: e.model, sessionEffort: effortNow }))
  }
  if (prefs.state === 'off') return passiveProposal($, e, prefs, rt)
  if (!e.agentId) {
    const decision = await decideMain($, e, signal)
    const now = await getPrefs($)
    rt = await read($, runtimeAtom)
    return planStep({ prefs: now, rt, e, decision, applies: !isPaused(rt, now) })
  }
  const agent = rt.agents[e.agentId]
  if (!prefs.subagents || !agent || !agent.decision) return passThrough(e, rt.phase?.id ?? null)
  return planStep({ prefs, rt, e, decision: agent.decision, applies: agent.applied && agent.decision.source !== 'explicit' })
}

/**
 * OFF: nothing is rewritten, but the deterministic rules still name the model
 * they would pick, so the band can show what routing could save. No
 * classifier call, no logged decision, no change to the request.
 */
async function passiveProposal($: Engine, e: TurnStepInput, prefs: Prefs, rt: Runtime): Promise<StepPlan> {
  const plan = passThrough(e, rt.phase?.id ?? null)
  if (e.agentId || !rt.phase?.analysis) return plan
  const project = await read($, projectAtom)
  const d = decide({
    prefs,
    analysis: rt.phase.analysis,
    verdict: rt.phase.verdict,
    escalations: 0,
    projectFloor: project.floor,
    scopeFloor: scopeFloor(rt.phase),
    previousTier: rt.lastRoutedTier ?? tierOfModel(rt.sessionModel ?? e.model, prefs),
    promptTokens: rt.lastPromptTokens,
    epoch: rt.epoch,
    now: await $.clock.now(),
  })
  const sameTier = d.source !== 'override' && tierOfModel(e.model, prefs) === d.tier
  return { ...plan, proposedModel: sameTier ? e.model : d.model }
}

/** Requests recorded since the usage record was last saved to the store, and when that was. */
const sincePersist = { requests: 0, at: 0 }

/** Records a finished request and what it says about the session. */
async function finishStep(
  $: Engine,
  e: TurnStepInput,
  plan: StepPlan,
  res: TurnStepResult,
  t0: number,
  attempt: number,
  aborted: boolean,
  status?: RequestRecord['status'],
): Promise<void> {
  const t1 = await $.clock.now()
  const usage = res.usage ? fromUsage(res.usage) : null
  // What Claude Code itself asked for: the request's own model, or for an
  // agent the router re-modelled at spawn, the model the Agent call named.
  const agentRoute = e.agentId ? (await read($, runtimeAtom)).agents[e.agentId] : undefined
  const spawnRouted = agentRoute?.applied === true && agentRoute.askedModel != null && agentRoute.askedModel !== e.model
  const engineModel = spawnRouted ? (agentRoute?.askedModel as string) : e.model
  const added = await recordRequest($, {
    key: `${e.turnId}:${e.agentId ?? MAIN}:${e.index}:${attempt}`,
    at: t1,
    role: plan.role,
    purpose: plan.purpose,
    ...(e.agentId ? { agentId: e.agentId } : {}),
    phaseId: plan.phaseId,
    requestedModel: plan.model,
    observedModel: res.usage?.model ?? null,
    engineModel,
    routed: plan.rewrite || spawnRouted,
    proposedModel: plan.proposedModel,
    effortSent: plan.rewrite && plan.effort ? plan.effort : e.effort === undefined ? null : String(e.effort),
    effortSession: e.effort === undefined ? null : String(e.effort),
    usage,
    durationMs: t1 - t0,
    status: status ?? (usage ? 'ok' : aborted ? 'aborted' : 'no-response'),
  })
  if (!added) return
  // Long stretches of work without a reply to the person (a 30-minute agentic
  // turn) would otherwise keep the usage record only in memory until the turn
  // ends: save it every 25 requests or 10 minutes as well.
  sincePersist.requests++
  if (sincePersist.requests >= 25 || t1 - sincePersist.at >= 10 * 60_000) {
    sincePersist.requests = 0
    sincePersist.at = t1
    await persistLedger($, await read($, ledgerAtom))
  }
  const agentId = e.agentId
  await patchActivity($, a => {
    const stepped = agentId ? agentStep(a, agentId, usage, res.usage?.model ?? null) : a
    return { ...stepped, lastRequestAt: t1 }
  })
  if (plan.role === 'main' && usage) turnTotals.set(e.turnId, addTokens(turnTotals.get(e.turnId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usage))
  const prefs = await getPrefs($)
  if (plan.role === 'main' && usage) {
    // A request after an idle gap shows how long the cache lasted.
    const before = await read($, runtimeAtom)
    const last = before.lastMainRequestAt ?? null
    const answered = res.usage?.model ?? plan.model
    if (last !== null) {
      const ev = await loadTtlEvidence($)
      const next = ttlEvidence(ev, t0 - last, usage, before.observedModel === answered)
      if (next !== ev) {
        ttlEv = next
        await $.store.set(TTL_EVIDENCE, next)
      }
    }
  }
  await patchRuntime($, r => {
    const phase =
      r.phase && r.phase.id === plan.phaseId
        ? { ...r.phase, tokens: usage ? addTokens(r.phase.tokens, usage) : r.phase.tokens, unknown: r.phase.unknown + (usage ? 0 : 1) }
        : r.phase
    if (plan.role !== 'main') return { ...r, phase }
    const counted = phase && phase.id === plan.phaseId ? { ...phase, requests: phase.requests + 1 } : phase
    const sent = plan.rewrite && plan.effort ? plan.effort : e.effort === undefined ? null : String(e.effort)
    return {
      ...r,
      phase: counted,
      lastEffort: { sent, applied: r.lastEffort.sent === sent ? r.lastEffort.applied : null },
      observedModel: res.usage?.model ?? r.observedModel,
      lastPromptTokens: usage ? promptTokens(usage) : r.lastPromptTokens,
      lastMainRequestAt: t1,
      basePrompt: usage && (r.basePrompt === undefined || promptTokens(usage) < r.basePrompt) ? promptTokens(usage) : r.basePrompt,
      lastRoutedTier: tierOfModel(plan.model, prefs) ?? r.lastRoutedTier,
    }
  })
}

/**
 * The routed model sent nothing back (no content, no stop, no usage) and the
 * person did not interrupt: the model is set aside for the session and the
 * request goes out again exactly as the engine meant it.
 */
async function markUnavailable($: Engine, model: string, fallback: string): Promise<void> {
  await patchRuntime($, r => ({
    ...r,
    unavailableModels: [...new Set([...r.unavailableModels, model])].slice(-6),
    degraded: `${shortModel(model)} did not answer; sent on ${shortModel(fallback)} instead`,
  }))
  await notify($, `Quality Router: ${model} did not answer; using ${fallback} for now`, 'warning')
}

/** The fallback failed too: the problem was not the routed model, which is not set aside. */
async function clearUnavailable($: Engine, model: string): Promise<void> {
  await patchRuntime($, r => ({
    ...r,
    unavailableModels: r.unavailableModels.filter(m => m !== model),
    degraded: 'model requests are failing (not specific to the routed model)',
  }))
}

async function recordAppliedEffort($: Engine, e: { agent_id?: string; effort?: { level: string } }): Promise<void> {
  const level = e.effort?.level
  if (e.agent_id || typeof level !== 'string' || level.length === 0 || level.length > 20) return
  await patchRuntime($, r => (r.lastEffort.applied === level ? r : { ...r, lastEffort: { ...r.lastEffort, applied: level } }))
}

async function setActive($: Engine, key: string, a: ActiveRequest): Promise<void> {
  await patchRuntime($, r => {
    const activeNow = { ...r.active, [key]: a }
    const keys = Object.keys(activeNow)
    for (const k of keys.slice(0, Math.max(0, keys.length - 12))) delete activeNow[k]
    return { ...r, active: activeNow }
  })
}

async function clearActive($: Engine, key: string): Promise<void> {
  await patchRuntime($, r => {
    if (!r.active[key]) return r
    const activeNow = { ...r.active }
    delete activeNow[key]
    return { ...r, active: activeNow }
  })
}

// --- subagents ---------------------------------------------------------------------

/**
 * Picks a built-in subagent's model as it starts. A model the Agent call
 * named, forks, teammates, workflow agents and plugin-defined agents (whose
 * definitions may set their own model) are left exactly as they are.
 */
async function onAgentSpawn($: Engine, e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> {
  const res = await routeSpawn($, e, next)
  if (!('deny' in res && res.deny !== undefined) && res.agentId) {
    const id = res.agentId
    const at = await $.clock.now()
    const phaseId = (await read($, runtimeAtom)).phase?.id ?? null
    await safe(() => patchActivity($, a => startAgent(a, { id, description: e.description, type: e.subagentType, model: res.model ?? null, at, phaseId, background: e.background })))
  }
  return res
}

async function routeSpawn($: Engine, e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> {
  const prefs = await getPrefs($)
  if (prefs.state === 'off' || !prefs.subagents || e.fork || e.isTeammate || e.provider.plugin !== 'engine') return next(e)
  // Claude Code lets a hook only refuse a workflow's agent, not change its
  // model at spawn: the decision is made here and applied to each of its
  // requests instead, from the first (a fresh context, so no cache is lost).
  const perRequest = e.workflow !== undefined
  const rt = await read($, runtimeAtom)
  const now = await $.clock.now()
  const analysis = analyzeSubagent(e.prompt, e.subagentType, rt.phase?.analysis?.risk ?? 'low')
  const project = await read($, projectAtom)
  const explicit = e.model !== undefined
  const decision: Decision = explicit
    ? {
        tier: tierOfModel(e.model, prefs) ?? 'strong',
        model: e.model as string,
        source: 'explicit',
        confidence: 1,
        reason: 'model named by the Agent call',
        category: analysis.category,
        risk: analysis.risk,
        epoch: rt.epoch,
        at: now,
      }
    : decide({ prefs, analysis, verdict: null, escalations: 0, projectFloor: project.floor, previousTier: null, promptTokens: 0, epoch: rt.epoch, now, sessionEffort: rt.sessionEffort })
  const apply = !explicit && prefs.state === 'on' && !isPaused(rt, prefs) && !rt.unavailableModels.includes(decision.model)
  const res = await next(apply && !perRequest ? { ...e, model: decision.model } : e)
  if ('deny' in res && res.deny !== undefined) return res
  const agentId = res.agentId
  if (agentId) {
    const route: AgentRoute = {
      decision,
      escalations: 0,
      escalationReasons: [],
      sourceVersion: 0,
      testVersion: 0,
      startSourceVersion: 0,
      repair: {},
      riskTouched: [],
      tdd: analysis.tdd,
      agentId,
      subagentType: e.subagentType,
      askedModel: e.model ?? e.parentModel ?? null,
      analysis,
      applied: apply,
      startedAt: now,
      done: false,
    }
    await patchRuntime($, r => {
      const agents = { ...r.agents, [agentId]: route }
      const ids = Object.keys(agents)
      for (const id of ids.slice(0, Math.max(0, ids.length - 30))) delete agents[id]
      return { ...r, agents }
    })
  }
  await logDecision($, { at: now, scope: `agent ${e.subagentType}`, tier: decision.tier, model: decision.model, ...(decision.effort ? { effort: decision.effort } : {}), source: decision.source, applied: apply, reason: decision.reason })
  return res
}

// --- tool results: validation and escalation ----------------------------------------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Reads a finished tool call. Edits move the code state, checks are recorded
 * against it, failures feed the escalation tracker. Nothing here runs, blocks
 * or repeats a tool: the result passes on unchanged.
 */
async function onToolResult($: Engine, e: ToolCallInput, ran: ToolCallResult): Promise<void> {
  const tool = String(e.tool)
  await trackActivity($, e, tool, ran)
  const isEdit = EDIT_TOOLS.has(tool)
  if (!isEdit && tool !== 'Bash') return
  const prefs = await getPrefs($)
  const project = await read($, projectAtom)
  const input = e as unknown as Record<string, unknown>
  const scopeId = e.agentId ?? MAIN
  const routing = prefs.state !== 'off' && prefs.override.kind === 'auto'
  const ok = ran.deny === undefined && ran.isError !== true
  const now = await $.clock.now()
  const escalations: string[] = []

  if (isEdit) {
    if (!ok) return
    const path = String(input.file_path ?? input.notebook_path ?? '')
    const risky = riskyPath(path, project)
    const riskEdit = risky && routing ? `edited ${risky}` : null
    await patchRuntime($, r => {
      escalations.length = 0
      const code = isTestPath(path) ? { ...r.code, test: r.code.test + 1 } : { ...r.code, source: r.code.source + 1 }
      return withScope({ ...r, code }, scopeId, prefs, project, now, scope => {
        let s = recordEdit(scope, path)
        const tierNow = scope.decision?.tier ?? (scopeId === MAIN ? r.lastRoutedTier : null) ?? tierOfModel(r.sessionModel, prefs) ?? 'middle'
        if (riskEdit) {
          const res = applyRisk(s, riskEdit, tierRank(tierNow))
          s = res.scope
          if (res.escalate) escalations.push(res.escalate)
        }
        if (routing && escalations.length === 0 && isCodeFile(path)) {
          const res = applyCodeEdit(s, scope.decision?.category ?? 'unknown', tierRank(tierNow), path)
          s = res.scope
          if (res.escalate) escalations.push(res.escalate)
        }
        return s
      }, riskEdit)
    })
  } else {
    const command = String(input.command ?? '')
    const result = (ran.result ?? {}) as Record<string, unknown>
    // A run sent to the background returns at once: it says nothing about the checks yet.
    const backgrounded = typeof result.backgroundTaskId === 'string' || result.backgroundedByUser === true
    const kind = backgrounded ? null : matchCheck(command, compileChecks(project))
    const outcome = classifyOutcome({
      denied: ran.deny !== undefined,
      isError: ran.isError === true,
      interrupted: result.interrupted === true,
      timedOut: typeof result.timedOutAfterMs === 'number',
      text: ran.text ?? ran.deny ?? '',
      isCheck: kind !== null,
    })
    const notes: string[] = []
    if (kind) {
      const rt = await read($, runtimeAtom)
      await update($, validationAtom, v => recordCheck(v, kind, outcome, command, now, codeVersions(rt)))
      if (outcome === 'check-failed' && rt.phase?.decision?.effort && rt.phase.decision.effortSource === 'auto') {
        const lowered = (rt.phase.decision.baseEffort ?? null) !== null && rt.phase.decision.effortReason?.startsWith('lowered')
        if (lowered) await patchRuntime($, r => (r.phase ? { ...r, phase: { ...r.phase, decision: null } } : r))
      }
    }
    const destructive = ok && isDestructive(command)
    const wroteCode = ok ? bashWritesCode(command) : null
    if (ok && scopeId === MAIN && /\bgit\b[^;&|\n]*\bcommit\b/.test(command)) {
      await patchRuntime($, r => ({ ...r, turnCommitted: true }))
    }
    if (wroteCode) {
      // A source file written from the shell is an edit like any other: it moves the code version.
      await patchRuntime($, r => {
        const code = isTestPath(wroteCode) ? { ...r.code, test: r.code.test + 1 } : { ...r.code, source: r.code.source + 1 }
        return withScope({ ...r, code }, scopeId, prefs, project, now, scope => recordEdit(scope, wroteCode), null)
      })
    }
    if (routing && (kind || destructive || wroteCode)) {
      await patchRuntime($, r => {
        escalations.length = 0
        notes.length = 0
        return withScope(r, scopeId, prefs, project, now, scope => {
          let s = scope
          if (kind) {
            const res = applyCheck(s, kind, outcome, prefs.mode, prefs.maxEscalationsPerPhase)
            s = res.scope
            if (res.note) notes.push(res.note)
            if (res.escalate) escalations.push(res.escalate)
          }
          const tierNow = s.decision?.tier ?? (scopeId === MAIN ? r.lastRoutedTier : null) ?? tierOfModel(r.sessionModel, prefs) ?? 'middle'
          if (destructive) {
            const res = applyRisk(s, 'destructive command', tierRank(tierNow))
            s = res.scope
            if (res.escalate) escalations.push(res.escalate)
          }
          if (wroteCode && escalations.length === 0) {
            const res = applyCodeEdit(s, s.decision?.category ?? 'unknown', tierRank(tierNow), wroteCode)
            s = res.scope
            if (res.escalate) escalations.push(res.escalate)
          }
          return s
        }, null)
      })
    }
    if (prefs.state === 'on') for (const n of notes) $.ui.log(`Quality Router: ${n}`)
  }

  for (const why of escalations) {
    await update($, experimentAtom, x => (x ? { ...x, escalations: x.escalations + 1 } : x))
    const rt = await read($, runtimeAtom)
    const agent = scopeId === MAIN ? undefined : rt.agents[scopeId]
    await logDecision($, {
      at: now,
      scope: agent ? `agent ${agent.subagentType}` : MAIN,
      tier: agent?.decision?.tier ?? 'strong',
      model: agent?.decision?.model ?? '(next main request)',
      source: 'escalation',
      applied: prefs.state === 'on',
      reason: why,
    })
    if (prefs.state === 'on') await notify($, `Quality Router: escalating (${why})`, 'info')
  }
}

/**
 * A phase whose prompt said too little ("start phase 3") is re-judged from
 * the task list Claude wrote for it, whenever the list's tasks change. The
 * decision is dropped so the next request decides again, under the same
 * switching economics and safety floors.
 */
async function reassessFromTasks($: Engine): Promise<void> {
  const rt = await read($, runtimeAtom)
  const phase = rt.phase
  if (!phase?.analysis) return
  // A prompt that said too little ("start phase 3", an unclear ask) is judged
  // from its task list instead; any other prompt keeps its own judgement, and
  // the task list can only raise it. Either way the prompt's own risk stays.
  const vague = phase.analysisSource === 'tasks' || phase.planPrompt || phase.analysis.category === 'unknown' || phase.analysis.confidence < 0.6
  const list = taskList(await read($, activityAtom), MAIN_SCOPE)
  const subjects = list.map(t => t.subject)
  const key = digest(subjects.join('\n'))
  if (subjects.length === 0 || key === phase.tasksDigest) return
  const assessed = assessFromTasks(subjects)
  const prefs = await getPrefs($)
  await patchRuntime($, r => {
    if (!r.phase || r.phase.id !== phase.id || !r.phase.analysis) return r
    if (!assessed) return { ...r, phase: { ...r.phase, tasksDigest: key } }
    if (!vague) {
      if (!raisesTask(r.phase.analysis, assessed, prefs.mode)) return { ...r, phase: { ...r.phase, tasksDigest: key } }
      return { ...r, phase: { ...r.phase, analysis: strongerAnalysis(r.phase.analysis, assessed, prefs.mode), tasksDigest: key, decision: null, verdict: null } }
    }
    const promptRisk = r.phase.promptRisk ?? 'low'
    const keepsRisk = promptRisk === 'high' || (promptRisk === 'medium' && assessed.risk === 'low')
    const analysis: Analysis = keepsRisk
      ? { ...assessed, risk: promptRisk, tier: promptRisk === 'high' ? 'strong' : assessed.tier === 'cheap' ? 'middle' : assessed.tier }
      : assessed
    return { ...r, phase: { ...r.phase, analysis, analysisSource: 'tasks', tasksDigest: key, decision: null, verdict: null } }
  })
}

/** Agents' tool counts and the task lists, from what the tools were given and returned. */
async function trackActivity($: Engine, e: ToolCallInput, tool: string, ran: ToolCallResult): Promise<void> {
  const agentId = e.agentId
  const ok = ran.deny === undefined && ran.isError !== true
  const input = e as unknown
  const scope = agentId ?? MAIN
  const now = await $.clock.now()
  await patchActivity($, a => {
    let next = agentId ? agentTool(a, agentId) : a
    if (!ok) return next
    if (tool === 'TodoWrite') next = applyTodoWrite(next, scope, input, now)
    else if (tool === 'TaskCreate') next = applyTaskCreate(next, input, ran.result, now)
    else if (tool === 'TaskUpdate') next = applyTaskUpdate(next, input, now)
    else if (tool === 'TaskList') next = applyTaskList(next, ran.result, now)
    return next
  })
  if (ok && !agentId && (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TaskList')) {
    await reassessFromTasks($)
  }
}

// --- turn end, limits, review, session end --------------------------------------------

async function onTurnComplete($: Engine, e: { agentId?: string; turnId: string; reason?: string; answer?: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }): Promise<void> {
  if (e.agentId) {
    const id = e.agentId
    const at = await $.clock.now()
    await patchRuntime($, r => {
      const agent = r.agents[id]
      return agent ? { ...r, agents: { ...r.agents, [id]: { ...agent, done: true } } } : r
    })
    const after = await patchActivity($, a => endAgent(a, id, e.reason ?? 'answer', at))
    const run = after.agents[id]
    if (run && run.status === 'done' && run.endedAt !== null) {
      await loadAgentStats($)
      const stats = await update($, agentStatsAtom, st => recordRun(st, run.type, (run.endedAt as number) - run.startedAt, run.steps))
      await $.store.set(AGENT_STATS, stats)
    }
    return
  }
  // What the answer proposes, kept as a verdict only (never the text), for a reply that sets it going.
  const demands = answerDemands(typeof e.answer === 'string' ? e.answer : '')
  await patchRuntime($, r => (r.lastAnswer === demands ? r : { ...r, lastAnswer: demands }))
  const summed = turnTotals.get(e.turnId)
  turnTotals.delete(e.turnId)
  if (summed && e.usage) {
    const t = fromUsage(e.usage)
    if (t.input !== summed.input || t.output !== summed.output || t.cacheRead !== summed.cacheRead || t.cacheWrite !== summed.cacheWrite) {
      await update($, ledgerAtom, l => ({ ...l, turnMismatches: l.turnMismatches + 1 }))
    }
  }
  const usage = await $.session.usage()
  await recordContext($, usage.context)
  await maybeAutoCompact($, e.reason ?? 'answer', usage.context.tokens ?? null)
  await recordLimits($, usage.rateLimits, usage.cost?.usd ?? null)
  await maybeReview($)
  await persistLedger($, await ensureLedger($))
  await recordSavings($)
  await refreshStatusLine($)
}

async function recordContext($: Engine, c: { tokens?: number; window: number; percent?: number }): Promise<void> {
  const at = await $.clock.now()
  await patchActivity($, a => ({ ...a, context: { tokens: c.tokens ?? null, window: c.window, percent: c.percent ?? null, at } }))
}

async function recordLimits($: Engine, windows: readonly { kind: string; percentUsed: number; resetsAt?: string }[], costUsd: number | null): Promise<void> {
  if (costUsd !== null) await update($, ledgerAtom, l => ({ ...l, engineCostUsd: costUsd }))
  if (windows.length === 0) return
  await loadLimits($)
  const now = await $.clock.now()
  const next = await update($, limitsAtom, l => {
    const tracks = { ...l.tracks }
    for (const w of windows) tracks[w.kind] = addReading(tracks[w.kind], w, now)
    return { tracks, latest: windows.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt ?? null, at: now })) }
  })
  await $.store.set(STORE.limits, next.tracks)
}

/**
 * Stronger review, selectively: only when sensitive files were edited while
 * the phase ran below the strong tier. `suggest` (the default) shows it;
 * `auto` submits one review prompt per phase, which runs as its own turn.
 */
async function maybeReview($: Engine): Promise<void> {
  const prefs = await getPrefs($)
  const rt = await read($, runtimeAtom)
  const phase = rt.phase
  if (!phase || prefs.review === 'off' || prefs.state !== 'on' || phase.editsBelowStrong.length === 0) return
  const files = phase.editsBelowStrong.map(f => f.replace(/^edited /, '')).join(', ')
  await patchRuntime($, r => ({ ...r, reviewSuggested: `sensitive files changed below the strong tier: ${files}` }))
  if (prefs.review === 'auto' && rt.reviewsRequested === 0) {
    await patchRuntime($, r => ({ ...r, reviewsRequested: r.reviewsRequested + 1 }))
    await $.prompt.submit({ text: reviewPrompt(files) })
  }
}

async function finishExperiment($: Engine): Promise<string> {
  const x = await read($, experimentAtom)
  if (!x) return 'No experiment is running.'
  const now = await $.clock.now()
  const outcome = checkOutcome(await read($, validationAtom), await read($, runtimeAtom))
  const done: ExperimentArm = { ...x, endedAt: now, durationMs: now - x.startedAt, outcome }
  const raw = await $.store.get(STORE.experiments)
  await $.store.set(STORE.experiments, [...(Array.isArray(raw) ? raw : []), done].slice(-50))
  await update($, experimentAtom, () => null)
  return `Experiment "${x.label}" (${x.arm}) recorded: ${done.requests} requests; checks passed ${outcome.passed}, failed ${outcome.failed}, not run ${outcome.notRun}.`
}

async function finishedExperiments($: Engine): Promise<ExperimentArm[]> {
  const raw = await $.store.get(STORE.experiments)
  return Array.isArray(raw) ? (raw as ExperimentArm[]) : []
}

// --- controls: buttons and commands share these -----------------------------------------

/** The one routing-state setter the buttons and the commands share. */
async function setRouterState($: Engine, state: RouterState): Promise<string> {
  await setPrefs($, p => ({ ...p, state }))
  await refreshStatusLine($)
  return STATE_NOTE[state]
}

/** The one mode setter the button and the command share. */
async function setMode($: Engine, mode: RouterMode): Promise<string> {
  await setPrefs($, p => ({ ...p, mode }))
  await refreshStatusLine($)
  return MODE_NOTE[mode]
}

async function resumeAuto($: Engine): Promise<string> {
  await setPrefs($, p => ({ ...p, override: { kind: 'auto' } }))
  await patchRuntime($, r => ({ ...r, manual: null, epoch: r.epoch + 1, phase: r.phase ? { ...r.phase, decision: null } : null }))
  await refreshStatusLine($)
  return 'Automatic model selection resumed: the router decides again from the next request.'
}

async function openPane($: Engine): Promise<string> {
  const placed = await $.ui.open({ id: PANE, title: 'Quality Router' })
  return placed.isPlaced ? 'Opened the Quality Router pane.' : `The pane could not be placed here; the report follows.\n\n${usageText(await snapshot($, true))}`
}

async function refreshStatusLine($: Engine): Promise<void> {
  const prefs = await getPrefs($)
  if (!prefs.ui.statusLine) {
    $.ui.status(undefined)
    return
  }
  const rt = await read($, runtimeAtom)
  const word = prefs.state === 'on' ? 'ON' : prefs.state === 'dry-run' ? 'DRY' : 'OFF'
  const model = prefs.state !== 'off' && rt.phase?.decision ? ` ${shortModel(rt.phase.decision.model)}` : ''
  $.ui.status(`QR ${word}${model}`)
}

/**
 * Automatic compaction, when the person turned it on: a moment after a turn
 * that ended at or above their threshold (compaction cannot run inside a
 * turn). If they have typed again by then, compaction is refused by Claude
 * Code and skipped; the next turn end tries again.
 */
const WATCH_LOG = 'autocompact-watch'

/** Why the work counts as finished, in a few words. */
function finishedWhy(committed: boolean, verified: boolean, tasksDone: boolean): string {
  return committed ? 'the work was committed' : verified ? 'the checks pass' : tasksDone ? 'the task list is done' : 'the task is finished'
}

async function loadWatchLog($: Engine): Promise<CompactObservation[]> {
  const raw = await $.store.get(WATCH_LOG)
  return Array.isArray(raw) ? (raw as CompactObservation[]).slice(-100) : []
}

/**
 * At the end of a main-loop turn: compact, or (watching) note when smart
 * auto-compact would have. Smart 'on' compacts when work is finished past the
 * boundary size, or past the ceiling; otherwise the plain threshold decides.
 */
async function maybeAutoCompact($: Engine, turnReason: string, contextTokens: number | null): Promise<void> {
  const prefs = await getPrefs($)
  const rt = await read($, runtimeAtom)
  const activity = await read($, activityAtom)
  const validation = await read($, validationAtom)
  const now = await $.clock.now()
  const tokens = contextTokens ?? rt.lastPromptTokens
  const agentsRunning = Object.values(activity.agents).filter(g => g.status === 'running').length
  const tasks = progress(taskList(activity, MAIN_SCOPE))
  const checks = verdict(validation, codeVersions(rt))
  const failingCheck = checks === 'failed'
  const tasksDone = tasks !== null && tasks.total > 0 && tasks.done === tasks.total
  const finished = rt.turnCommitted === true || checks === 'verified' || tasksDone
  const midTask = failingCheck || !finished
  const smart = smartCompactDue({
    state: prefs.state,
    smart: prefs.autoCompactSmart,
    promptTokens: tokens,
    turnReason,
    agentsRunning,
    lastAt: prefs.autoCompactSmart === 'watch' ? activity.lastWatchAt ?? null : activity.lastAutoCompactAt,
    now,
    boundaryTokens: prefs.autoCompactBoundary,
    ceilingTokens: prefs.autoCompactCeiling,
    finished,
    failingCheck,
  })
  const plain =
    prefs.autoCompactSmart !== 'on' &&
    autoCompactDue({ state: prefs.state, threshold: prefs.autoCompactTokens, promptTokens: tokens, turnReason, agentsRunning, lastAutoCompactAt: activity.lastAutoCompactAt, now })
  const size = Math.round(tokens / 1000)

  if (prefs.autoCompactSmart === 'watch' && (smart || plain)) {
    const entry: CompactObservation = { at: now, tokens, smart, plain, midTask }
    await $.store.set(WATCH_LOG, [...(await loadWatchLog($)), entry].slice(-100))
    if (smart) {
      await patchActivity($, a => ({ ...a, lastWatchAt: now }))
      if (!plain) {
        const why = smart === 'boundary' ? finishedWhy(rt.turnCommitted === true, checks === 'verified', tasksDone) : `past the ${Math.round(prefs.autoCompactCeiling / 1000)}k ceiling`
        await notify($, `Quality Router: smart auto-compact (watching) would compact now: ${why}, ${size}k tokens. Nothing was changed. (/quality-router autocompact report)`, 'info')
      }
    }
  }

  const act = prefs.autoCompactSmart === 'on' ? smart : plain ? 'plain' : null
  if (!act) return
  await patchActivity($, a => ({ ...a, lastAutoCompactAt: now }))
  const why =
    act === 'boundary' ? finishedWhy(rt.turnCommitted === true, checks === 'verified', tasksDone) : act === 'ceiling' ? `past the ${Math.round(prefs.autoCompactCeiling / 1000)}k ceiling` : midTask ? 'past the threshold, with a task still open' : 'past the threshold'
  await scheduleCompaction($, 'auto', 1500, async r => {
    await notify($, r.ok ? `Quality Router: auto-compacted a ${size}k-token conversation (${why}), keeping the plan and current task. ${r.text} (/quality-router autocompact off to stop)` : `Quality Router: auto-compact skipped: ${r.text}`, r.ok ? 'success' : 'warning')
  })
}

/**
 * After any compaction of the main conversation: each request now re-sends
 * far less, and the new prompt is not cached yet, so the size and warmth the
 * next decision weighs start over, and the task's decision is made afresh.
 */
async function onCompacted($: Engine, tokensAfter: number | null): Promise<void> {
  await patchRuntime($, r => ({
    ...r,
    // Unknown (a /compact run as a command does not report it): what every
    // request carries anyway plus a summary, never zero, which would make a
    // model switch look free.
    lastPromptTokens: tokensAfter ?? (r.basePrompt ?? 60_000) + 25_000,
    lastMainRequestAt: null,
    phase: r.phase ? { ...r.phase, decision: null } : r.phase,
  }))
}

/** A compaction this process scheduled or started and has not finished: one at a time, and the band says so. */
let compactingSince: number | null = null
const LAST_COMPACT = 'last-compact'

/**
 * Runs a compaction a moment from now, from a timer. Claude Code refuses one
 * from inside the hook that asks for it (a command, a button press: it would
 * compact under the turn that hook holds), so the asking hook only schedules
 * it. Records how it ended, for `/quality-router status`.
 */
async function scheduleCompaction($: Engine, source: 'button' | 'command' | 'auto', delayMs: number, done: (r: CompactOutcome) => Promise<void>): Promise<boolean> {
  if (compactingSince !== null) return false
  compactingSince = await $.clock.now()
  $.ui.invalidate('ui.render')
  $.clock.after(delayMs, async () => {
    const r = await compactNow($, source === 'auto')
    await $.store.set(LAST_COMPACT, { at: await $.clock.now(), source, ok: r.ok, text: r.text.slice(0, 300) })
    await done(r)
  })
  return true
}

type CompactOutcome = {
  ok: boolean
  text: string
  /** The focus the compaction was given, for a `/compact` typed by hand instead. */
  instructions: string
  /** Claude Code refused the call itself (not a hook's skip): why, as it said. */
  refused?: string
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  return (raw || 'no reason given').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Compacts now, with the current task as the focus; scheduleCompaction runs it, between turns. */
async function compactNow($: Engine, automatic = false): Promise<CompactOutcome> {
  let instructions = 'Keep the current task: its goal, the decisions made, the files involved, open problems and next steps.'
  // What the conversation was before, for the estimate of what compacting saves.
  // Only the router's own choice counts: one asked for by button or command was the person's.
  const before = await read($, runtimeAtom)
  const counted = async (after: number | null) => {
    if (!automatic) return
    const rt = await read($, runtimeAtom)
    const prefs = await priced($, await getPrefs($))
    await update($, ledgerAtom, l => ({
      ...l,
      compaction: compactionDone(l.compaction ?? emptyCompaction(), {
        pre: before.lastPromptTokens,
        post: after ?? rt.lastPromptTokens,
        base: rt.basePrompt ?? 17_000,
        model: before.observedModel ?? before.sessionModel,
        prefs,
      }),
    }))
  }
  try {
    const rt = await read($, runtimeAtom)
    instructions = compactInstructions(rt.phase?.analysis ?? null, rt.phase?.planPrompt === true || automatic)
    $.ui.status('Quality Router: compacting…')
    const r = await $.session.compact({ instructions }).catch(async (err: unknown) => {
      // An SDK host (the desktop app, -p) compacts only through the /compact
      // command, as a turn of its own: run that, as if typed, with the same focus.
      if (!needsCompactCommand(errorText(err))) throw err
      return { viaCommand: await $.command.run({ command: 'compact', args: instructions }) }
    })
    if ('viaCommand' in r) {
      const out = (r.viaCommand.text ?? '').replace(/\s+/g, ' ').trim()
      if (compactCommandFailed(out)) return { ok: false, text: `/compact said: ${out.slice(0, 200).replace(/[.\s]+$/, '')}`, instructions }
      await patchActivity($, a => ({ ...a, compactions: a.compactions + 1 }))
      await onCompacted($, null)
      await counted(null)
      return { ok: true, text: 'Conversation compacted (through /compact), with the current task kept in focus.', instructions }
    }
    if ('skip' in r && r.skip !== undefined) return { ok: false, text: `skipped: ${r.skip}`, instructions }
    await patchActivity($, a => ({ ...a, compactions: a.compactions + 1 }))
    await onCompacted($, r.tokensAfter ?? null)
    await counted(r.tokensAfter ?? null)
    const sizes = r.tokensBefore && r.tokensAfter ? ` (${Math.round(r.tokensBefore / 1000)}k → ${Math.round(r.tokensAfter / 1000)}k tokens)` : ''
    return { ok: true, text: `Conversation compacted${sizes}, with the current task kept in focus.`, instructions }
  } catch (err) {
    const why = errorText(err)
    return { ok: false, text: `Claude Code did not compact: ${why}`, instructions, refused: why }
  } finally {
    compactingSince = null
    $.ui.status(undefined)
    await refreshStatusLine($)
    $.ui.invalidate('ui.render')
  }
}

/**
 * The Compact button and `/quality-router compact`: answers at once that the
 * compaction is starting (a large conversation takes a minute or two); a
 * notification says how it ended. When Claude Code refuses it, `/compact`
 * with the same focus is typed into the prompt instead, for the person to send.
 */
async function compactFromUser($: Engine, source: 'button' | 'command'): Promise<string> {
  const started = await scheduleCompaction($, source, 250, async r => {
    let text = r.ok ? r.text : `not compacted: ${r.text}.`
    if (r.refused) {
      const filled = await $.prompt.fill({ text: `/compact ${r.instructions}`, mode: 'replace' }).catch(() => null)
      text = filled?.isFilled
        ? `${r.text}. Typed /compact into the prompt with the same focus: press Enter to run it.`
        : `${r.text}. Type /compact to compact.`
    }
    await notify($, `Quality Router: ${text}`, r.ok ? 'success' : r.refused ? 'warning' : 'error', 10_000)
  })
  return started
    ? 'Quality Router: compacting now, with the current task in focus. A large conversation takes a minute or two; a notification says when it is done.'
    : 'Quality Router: a compaction is already running.'
}

const NOTICE_MS = 3 * 60_000
const CONFIRM_MS = 2 * 60_000

/** Says what happened: a notification, and a line in the band for a few minutes (the desktop app may not show notifications). */
async function notify($: Engine, text: string, tone: 'success' | 'warning' | 'error' | 'info', timeoutMs = 8000): Promise<void> {
  $.ui.toast(text, { timeoutMs })
  const at = await $.clock.now()
  await patchActivity($, a => ({ ...a, notice: { text: text.replace(/^Quality Router: /, '').slice(0, 300), tone, at } }))
}

/**
 * Start fresh: puts /clear in the prompt box for the person to send. Where
 * there is no prompt box to type into (the desktop app), the band asks for a
 * second press instead, and only that press runs /clear.
 */
async function prepareNewSession($: Engine): Promise<string> {
  const filled = await $.prompt.fill({ text: '/clear', mode: 'replace' }).catch(() => null)
  if (filled?.isFilled) return 'Typed /clear into the prompt: press Enter to start fresh. It clears this conversation; usage history and settings are kept.'
  const now = await $.clock.now()
  await patchActivity($, a => ({ ...a, pendingClear: now }))
  return 'Start fresh clears this conversation (usage history and settings are kept). Press "Clear now" in the band to confirm.'
}

/** The confirming press: runs /clear a moment later, outside the press (as typed). */
async function confirmClear($: Engine): Promise<void> {
  await patchActivity($, a => ({ ...a, pendingClear: null }))
  $.clock.after(250, async () => {
    try {
      await $.command.run({ command: 'clear' })
    } catch (err) {
      await notify($, `Quality Router: could not run /clear (${errorText(err)}). Type /clear to start fresh.`, 'error')
    }
  })
}

async function runTip($: Engine, action: string | null): Promise<void> {
  let text: string | null = null
  if (action === 'compact') text = await compactFromUser($, 'button')
  else if (action === 'new-session') text = await prepareNewSession($)
  else if (action === 'economy') text = await setMode($, 'economy')
  else if (action === 'enable') text = await setRouterState($, 'on')
  else if (action === 'smart-compact') {
    await setPrefs($, p => ({ ...p, autoCompactSmart: 'on' }))
    text = 'Smart auto-compact on: compacts when a piece of work is finished, and mid-task only past the ceiling.'
  }
  if (text) await notify($, text, action === 'compact' ? 'info' : 'success')
}

async function dismissTip($: Engine, id: string): Promise<void> {
  const phaseId = (await read($, runtimeAtom)).phase?.id ?? ''
  await patchActivity($, a => ({ ...a, dismissed: [...a.dismissed.filter(d => d !== `${id}@${phaseId}`), `${id}@${phaseId}`].slice(-50) }))
}

const TIP_LABEL: Record<string, string> = {
  compact: 'Compact now',
  'new-session': 'Start fresh',
  economy: 'Economy mode',
  enable: 'Turn on',
  'smart-compact': 'Smart compaction',
}

function tipsText(v: View): string {
  const tips = recommendations(v)
  if (tips.length === 0) return 'No recommendations right now: context, cache and pace look fine.'
  return tips.map(t => `${t.severity === 'urgent' ? '!!' : t.severity === 'warn' ? '!' : '-'} ${t.title}\n  ${t.detail}${t.action ? `\n  (${TIP_LABEL[t.action]}: ${t.action === 'compact' ? '/quality-router compact' : t.action === 'new-session' ? '/clear' : t.action === 'economy' ? '/quality-router mode economy' : t.action === 'smart-compact' ? '/quality-router autocompact smart' : '/quality-router on'})` : ''}`).join('\n')
}

function savingsText(v: View): string {
  const m = savingsMeter(v)
  const lines = [`${m.label}: ${m.value} · ${m.note}`]
  for (const t of tierBars(v)) lines.push(`  ${t.label}: ${t.requests} request(s), ${Math.round(t.fraction * 100)}%`)
  lines.push(`  All sessions: ${lifetimeLine(v.savingsLog)}`)
  lines.push('  Estimates use list prices and are cache-aware: each model switch is charged for re-caching the conversation, and output is held equal. /quality-router usage has the detail.')
  return lines.join('\n')
}

async function runCommand($: Engine, args: string): Promise<string> {
  const action: Action = parseCommand(args)
  switch (action.kind) {
    case 'help':
      return HELP
    case 'error':
      return `Quality Router: ${action.message}`
    case 'status':
      return statusText(await snapshot($, true), (await read($, activityAtom)).context?.window ?? null)
    case 'set-state':
      return setRouterState($, action.state)
    case 'toggle':
      return setRouterState($, (await getPrefs($)).state === 'on' ? 'off' : 'on')
    case 'usage':
      return openPane($)
    case 'limits':
      return limitsText(await snapshot($, true))
    case 'config':
      return configText(await getPrefs($))
    case 'tips':
      return tipsText(await view($, null))
    case 'compact':
      return compactFromUser($, 'command')
    case 'autocompact-report': {
      const p = await getPrefs($)
      const mode = p.autoCompactSmart === 'on' ? 'on' : p.autoCompactSmart === 'watch' ? 'watching' : 'off'
      const head = `Smart auto-compact: ${mode} · when work is finished from ${Math.round(p.autoCompactBoundary / 1000)}k tokens · mid-task past ${Math.round(p.autoCompactCeiling / 1000)}k${p.autoCompactTokens !== null && p.autoCompactSmart !== 'on' ? ` · plain threshold ${Math.round(p.autoCompactTokens / 1000)}k in charge` : ''}`
      return [head, ...watchReport(await loadWatchLog($)).map(l => `  ${l}`), p.autoCompactSmart === 'watch' ? '  /quality-router autocompact smart switches to it.' : ''].filter(Boolean).join('\n')
    }
    case 'savings':
      return savingsText(await view($, null))
    case 'reset-task':
      await resetTask($)
      return 'Routing state reset: the next prompt starts a new phase and is assessed afresh. Usage history is kept.'
    case 'resume-auto':
      return resumeAuto($)
    case 'prefs': {
      const after = await setPrefs($, action.change)
      await refreshStatusLine($)
      return `Quality Router: ${action.summary}. ${after.state === 'on' ? 'Applies from the next request.' : `(Router is ${after.state === 'off' ? 'OFF' : 'in DRY RUN'}.)`}`
    }
    case 'review-now': {
      const prefs = await getPrefs($)
      const rt = await read($, runtimeAtom)
      const files = rt.phase?.editsBelowStrong.map(f => f.replace(/^edited /, '')).join(', ') ?? ''
      await $.prompt.submit({ text: reviewPrompt(files) })
      return prefs.state === 'on'
        ? 'Review requested: it runs as its own turn, on the strong tier.'
        : 'Review requested: it runs as its own turn on the session model (routing is not ON, so the router does not pick its model).'
    }
    case 'experiment-start': {
      const current = await read($, experimentAtom)
      if (current) return `Experiment "${current.label}" is already running; /quality-router experiment stop first.`
      const now = await $.clock.now()
      const sessionId = await $.session.id()
      const arm = emptyArm({
        label: action.label,
        arm: action.arm,
        spec: action.spec,
        startState: action.startState,
        validation: action.validation,
        environment: action.environment,
        sessionId,
        startedAt: now,
      })
      await update($, experimentAtom, () => arm)
      return `Recording experiment "${action.label}" (${action.arm}) from the next request. Run the task, let its checks run, then /quality-router experiment stop. The router never runs the other arm for you; run it yourself in an isolated worktree from the same starting commit.`
    }
    case 'experiment-stop':
      return finishExperiment($)
    case 'experiment-list': {
      const list = await finishedExperiments($)
      if (list.length === 0) return 'No recorded experiment runs.'
      return list.slice(-20).map(a => `${a.label} · ${a.arm} · ${a.requests} req · passed ${a.outcome.passed} failed ${a.outcome.failed}`).join('\n')
    }
    case 'experiment-report':
      return experimentReport(await finishedExperiments($), action.label)
  }
}

// --- drawing helpers ------------------------------------------------------------------------

const COLOR: Record<Tone, string> = {
  success: 'success',
  inactive: 'inactive',
  warning: 'warning',
  error: 'error',
  accent: 'suggestion',
  brand: 'claude',
  text: 'text',
}

function projectionsMeters(v: View): Meter[] {
  return projections(v)
    .sort((x, y) => (x.kind === 'seven_day' ? -1 : y.kind === 'seven_day' ? 1 : x.kind.localeCompare(y.kind)))
    .map(limitMeter)
}

// --- the hooks ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await safe(() => onSessionStart($))
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await safe(() => onModelSwitch($, e))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Claude Code reports the effort it actually applied (after lowering a
  // level the model does not take) on these settings-hook events.
  on('classic.PostToolUse', async ($, e, next) => {
    await safe(() => recordAppliedEffort($, e))
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    await safe(() => recordAppliedEffort($, e))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await safe(() => onTurnStart($, e))
    return next(e)
  })

  // Every model request, main loop and subagents: the only place a model or
  // effort is changed, and only on the way down. The response is never
  // altered. A routed request that brings back nothing at all (no content, no
  // stop, no usage) and was not interrupted is sent again exactly as the
  // engine meant it; content already streamed is never sent twice.
  on('turn.step', async function* ($, e, next) {
    let plan = passThrough(e)
    try {
      plan = await prepareStep($, e, next.signal)
    } catch {
      plan = passThrough(e)
    }
    const t0 = await $.clock.now()
    const key = `${e.turnId}:${e.agentId ?? MAIN}:${e.index}`
    const effort = plan.rewrite && plan.effort ? plan.effort : e.effort === undefined ? null : String(e.effort)
    await safe(() => setActive($, key, { model: plan.model, effort, routed: plan.rewrite, ...(e.agentId ? { agentId: e.agentId } : {}), startedAt: t0 }))
    try {
      if (!plan.rewrite) {
        const res: TurnStepResult = yield* next(e)
        await safe(() => finishStep($, e, plan, res, t0, 0, next.signal.aborted))
        return res
      }
      const stream = next({ ...e, model: plan.model, ...(plan.effort ? { effort: plan.effort } : {}) })
      const held: TurnStepChunk[] = []
      let hasContent = false
      let step = await stream.next()
      while (!step.done) {
        const chunk = step.value
        if (!hasContent && chunk.kind === 'engine') {
          held.push(chunk)
        } else {
          if (!hasContent) {
            hasContent = true
            for (const h of held.splice(0)) yield h
          }
          yield chunk
        }
        step = await stream.next()
      }
      const res = step.value
      if (!hasContent && res.stopReason === null && res.usage === null && !next.signal.aborted) {
        await safe(() => finishStep($, e, plan, res, t0, 0, false, 'failed-fallback'))
        await safe(() => markUnavailable($, plan.model, e.model))
        const t1 = await $.clock.now()
        const again: TurnStepResult = yield* next(e)
        await safe(() => finishStep($, e, { ...plan, rewrite: false, model: e.model, purpose: 'fallback' }, again, t1, 1, next.signal.aborted))
        if (again.stopReason === null && again.usage === null && !next.signal.aborted) await safe(() => clearUnavailable($, plan.model))
        return again
      }
      for (const h of held) yield h
      await safe(() => finishStep($, e, plan, res, t0, 0, next.signal.aborted))
      return res
    } finally {
      await safe(() => clearActive($, key))
    }
  })

  on('agent.spawn', ($, e, next) => onAgentSpawn($, e, next)).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await safe(() => onToolResult($, e, ran))
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await safe(() => onTurnComplete($, e))
    return result
  })

  // Any compaction of the main conversation (a typed /compact, Claude Code's
  // own): what each request re-sends starts over. The router's own calls do
  // not pass through here; compactNow records those itself.
  on('session.compact', async ($, e, next) => {
    // Claude Code's own compactions (at its threshold, mid-turn included, a
    // summary computed ahead for one, or a bare /compact) get the same
    // instructions as the router's, so they keep what summaries tend to lose.
    let input = e
    if (e.agentId === undefined && !e.instructions && e.trigger !== 'plugin') {
      try {
        const rt = await read($, runtimeAtom)
        input = { ...e, instructions: compactInstructions(rt.phase?.analysis ?? null, true) }
      } catch {
        input = e
      }
    }
    const r = await next(input)
    if (e.trigger !== 'precompute' && e.agentId === undefined && !('skip' in r && r.skip !== undefined)) {
      await safe(() => onCompacted($, r.tokensAfter ?? null))
      // Claude Code's own, or a typed /compact: the router's last compaction no longer counts from here.
      if (compactingSince === null) await safe(async () => { await update($, ledgerAtom, l => (l.compaction ? { ...l, compaction: compactionReset(l.compaction) } : l)) })
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await safe(() => recordContext($, e.context))
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      await safe(() => recordLimits($, e.rateLimits, e.cost?.usd ?? null))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await safe(async () => {
      if (await read($, experimentAtom)) await finishExperiment($)
      await persistLedger($, await read($, ledgerAtom))
    })
    return next(e)
  })

  on('command.run', { command: 'quality-router' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  // The band above the prompt. Text rows first (state and model, savings,
  // meters, work in progress, the top recommendation), then one row holding
  // every button, so no button ever shares a row with text it could cover.
  // Other plugins' band content stays below it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const v = await view($, e.props.isWorking)
    if (v.prefs.ui.band === 'off') return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = band(v)
    const cols = e.props.bodyColumns
    const ascii = v.prefs.ui.ascii
    const chars = barChars(ascii)
    const width = cols >= 130 ? 12 : cols >= 96 ? 10 : 6
    const state = v.prefs.state

    const bar = (fraction: number, tone: Tone, w: number) => {
      const c = barCells(fraction, w)
      return (
        <Box flexDirection="row" flexShrink={0}>
          {c.filled > 0 && <Text color={COLOR[tone]}>{chars.full.repeat(c.filled)}</Text>}
          {c.empty > 0 && <Text color="inactive">{chars.empty.repeat(c.empty)}</Text>}
        </Box>
      )
    }
    const meter = (m: Meter, showNote: boolean) => (
      <Box key={`m-${m.key}`} flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text color="subtle">{m.label}</Text>
        {m.bar && bar(m.bar.fraction, m.bar.tone, width)}
        <Text color={COLOR[m.valueTone]} bold>{m.value}</Text>
        {showNote && m.note.length > 0 && <Text color="subtle">{m.note}</Text>}
      </Box>
    )
    const tip = b.tip
    const compacting = compactingSince !== null
    const tipButton = tip?.action && !(tip.action === 'compact' && (v.isWorking || compacting))
    const notice = v.activity.notice && v.now - v.activity.notice.at < NOTICE_MS ? v.activity.notice : null
    const confirming = v.activity.pendingClear != null && v.now - v.activity.pendingClear < CONFIRM_MS
    const noticeLine = notice && (
      <Text color={notice.tone === 'error' ? 'error' : notice.tone === 'warning' ? 'warning' : notice.tone === 'success' ? 'success' : 'suggestion'} wrap="wrap">
        {notice.text}
      </Text>
    )
    const confirmRow = confirming && (
      <Box flexDirection="column">
        <Text color="warning" wrap="wrap">Start fresh clears this conversation; usage history and settings are kept.</Text>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Button key="qr-clear-confirm" label="Clear now" variant="primary" onPress={() => confirmClear($)} />
          <Button key="qr-clear-cancel" label="Cancel" onPress={() => patchActivity($, a => ({ ...a, pendingClear: null }))} />
        </Box>
      </Box>
    )
    const compactingLine = compacting && <Text color="claude">Compacting… (a minute or two on a large conversation)</Text>
    const buttons = (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {tip && tipButton && <Button key="qr-tip" label={TIP_LABEL[tip.action as string] ?? 'Do it'} variant="primary" onPress={() => runTip($, tip.action)} />}
        {tip && <Button key="qr-dismiss" label="Dismiss" onPress={() => dismissTip($, tip.id)} />}
        {state === 'dry-run' && <Button key="qr-enable" label="Enable" variant={tip ? undefined : 'primary'} onPress={() => setRouterState($, 'on')} />}
        {state === 'on' && <Button key="qr-off" label="Turn off" onPress={() => setRouterState($, 'off')} />}
        {state === 'dry-run' && <Button key="qr-off" label="Turn off" onPress={() => setRouterState($, 'off')} />}
        {state === 'off' && <Button key="qr-on" label="Turn on" variant={tip ? undefined : 'primary'} onPress={() => setRouterState($, 'on')} />}
        {state !== 'dry-run' && <Button key="qr-dry" label="Dry run" onPress={() => setRouterState($, 'dry-run')} />}
        <Button key="qr-mode" label={`${MODE_LABEL[nextMode(v.prefs.mode)]} mode`} onPress={() => setMode($, nextMode(v.prefs.mode))} />
        {b.paused && <Button key="qr-auto" label="Resume auto" onPress={() => resumeAuto($)} />}
        <Button key="qr-usage" label="Usage" hotkey="u" onPress={() => openPane($)} />
      </Box>
    )
    const tipText = tip && (
      <Text color={tip.severity === 'urgent' ? 'error' : tip.severity === 'warn' ? 'warning' : 'suggestion'} bold>
        {tip.severity === 'info' ? (ascii ? '*' : '◆') : ascii ? '!' : '▲'} {tip.title}
        {b.tipCount > 1 ? ` (+${b.tipCount - 1} more in Usage)` : ''}
      </Text>
    )
    const status = (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text color={COLOR[b.head.tone]} bold>{b.head.text}</Text>
        <Text bold={state === 'on'} dimColor={state === 'off'}>{b.selection}</Text>
        {b.effort && <Text color="suggestion">· {b.effort}</Text>}
        <Text color="subtle">· {b.mode}</Text>
        {b.active && <Text color="claude">· {b.active}</Text>}
      </Box>
    )

    if (v.prefs.ui.band === 'compact') {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {status}
            {meter(b.savings, false)}
          </Box>
          {tipText}
          {noticeLine}
          {compactingLine}
          {confirmRow}
          {buttons}
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={COLOR[b.head.tone]} paddingX={1}>
          {status}
          {b.why && <Text color="subtle">why: {b.why}</Text>}
          {b.degraded && <Text color="error">{b.degraded}</Text>}
          {meter(b.savings, true)}
          {b.meters.length > 0 && (
            <Box flexDirection="row" columnGap={3} flexWrap="wrap">
              {b.meters.map(m => meter(m, cols >= 100))}
            </Box>
          )}
          {b.work.length > 0 && (
            <Box flexDirection="row" columnGap={3} flexWrap="wrap">
              {b.work.map(m => meter(m, true))}
            </Box>
          )}
          {b.agentRows.map(m => (
            <Box key={`ar-${m.key}`} paddingLeft={2}>
              {meter(m, true)}
            </Box>
          ))}
          {tipText}
          {noticeLine}
          {compactingLine}
          {confirmRow}
          {buttons}
        </Box>
        {below}
      </Box>
    )
  })

  // The detail pane: now (meters), savings, tasks, agents, recommendations,
  // checks, then the full usage report and recent decisions. As in the band,
  // buttons sit on rows of their own.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await view($, null)
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = band(v)
    const ascii = v.prefs.ui.ascii
    const chars = barChars(ascii)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const width = cols >= 100 ? 20 : 12
    const state = v.prefs.state

    const bar = (fraction: number, tone: Tone, w: number) => {
      const c = barCells(fraction, w)
      return (
        <Box flexDirection="row" flexShrink={0}>
          {c.filled > 0 && <Text color={COLOR[tone]}>{chars.full.repeat(c.filled)}</Text>}
          {c.empty > 0 && <Text color="inactive">{chars.empty.repeat(c.empty)}</Text>}
        </Box>
      )
    }
    const row = (m: Meter) => (
      <Box key={`p-${m.key}`} flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box width={14} flexShrink={0}>
            <Text color="subtle">{m.label}</Text>
          </Box>
          {m.bar ? bar(m.bar.fraction, m.bar.tone, width) : <Box width={width} flexShrink={0} />}
          <Text color={COLOR[m.valueTone]} bold>{m.value}</Text>
        </Box>
        {m.note.length > 0 && (
          <Box paddingLeft={15}>
            <Text color="subtle" wrap="wrap">{m.note}</Text>
          </Box>
        )}
      </Box>
    )
    const section = (title: string, children: unknown) => (
      <Box flexDirection="column">
        <Text color="claude" bold>{title}</Text>
        {children as never}
      </Box>
    )

    const limits = Object.values(v.limits.tracks).length > 0 ? projectionsMeters(v) : []
    const ctx = contextMeter(v)
    const now = [ctx, ...limits].filter((m): m is Meter => m !== null)
    const list = taskList(v.activity, MAIN_SCOPE)
    const tasksMeter = taskMeter(list, 'tasks', 'Tasks', listStartedAt(v.activity, MAIN_SCOPE), v.now)
    const agents = phaseAgents(v.activity, v.rt.phase?.id ?? null)
    const agentsHead = agentsMeter(
      agents,
      agents.map(g => agentEstimate(g, v.activity.todos[g.id] ?? [], v.activity.listStarted[g.id] ?? null, v.agentStats, v.now)),
    )
    const tips = recommendations(v)
    const tiers = tierBars(v)
    const ca = v.ledger.cacheAware
    const stayModel = v.rt.sessionModel ?? v.prefs.models.strong
    const maxUsd = Math.max(ca?.actualUsd ?? 0, ca?.stayUsd ?? 0, 0.000001)

    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text color={COLOR[b.head.tone]} bold>{b.head.text}</Text>
            <Text bold>{b.selection}</Text>
            {b.effort && <Text color="suggestion">· {b.effort}</Text>}
            <Text color="subtle">· {b.mode}</Text>
          </Box>
          {b.why && <Text color="subtle" wrap="wrap">why: {b.why}</Text>}
          {b.degraded && <Text color="error">{b.degraded}</Text>}
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {state !== 'on' && <Button key="pane-on" label="Turn on" variant="primary" onPress={() => setRouterState($, 'on')} />}
            {state !== 'off' && <Button key="pane-off" label="Turn off" onPress={() => setRouterState($, 'off')} />}
            {state !== 'dry-run' && <Button key="pane-dry" label="Dry run" onPress={() => setRouterState($, 'dry-run')} />}
            <Button key="pane-mode" label={`${MODE_LABEL[nextMode(v.prefs.mode)]} mode`} onPress={() => setMode($, nextMode(v.prefs.mode))} />
            <Button key="pane-reset" label="Reset task" onPress={() => resetTask($)} />
            <Button key="pane-close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>

        {section('Savings', (
          <Box flexDirection="column">
            {row(savingsMeter(v))}
            {ca && ca.priced > 0 && ca.stayUsd > 0 && v.ledger.routedRequests > 0 && (
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Box width={14} flexShrink={0}><Text color="subtle">As routed</Text></Box>
                  {bar(ca.actualUsd / maxUsd, ca.actualUsd <= ca.stayUsd ? 'success' : 'error', width)}
                  <Text bold>${ca.actualUsd.toFixed(3)}</Text>
                </Box>
                <Box flexDirection="row" columnGap={1}>
                  <Box width={14} flexShrink={0}><Text color="subtle">Stay {shortModel(stayModel)}</Text></Box>
                  {bar(ca.stayUsd / maxUsd, 'brand', width)}
                  <Text bold>${ca.stayUsd.toFixed(3)}</Text>
                </Box>
                <Text color="subtle" wrap="wrap">Est. at list prices; each model switch charged for re-caching the conversation.</Text>
              </Box>
            )}
            {tiers.length > 0 && (
              <Box flexDirection="column">
                <Text color="subtle">Requests by answering model</Text>
                {tiers.map(t => (
                  <Box key={`tier-${t.tier}`} flexDirection="row" columnGap={1}>
                    <Box width={14} flexShrink={0}><Text color="subtle">{t.label}</Text></Box>
                    {bar(t.fraction, t.tone, width)}
                    <Text bold>{Math.round(t.fraction * 100)}%</Text>
                    <Text color="subtle">{t.requests} req</Text>
                  </Box>
                ))}
              </Box>
            )}
            <Text color="subtle" wrap="wrap">All sessions: {lifetimeLine(v.savingsLog)}</Text>
            <Text color="subtle" wrap="wrap">Estimated pricing difference — same recorded token volumes, list prices. It does not predict what other models would have used, cached or achieved, and it is not subscription quota.</Text>
          </Box>
        ))}

        {section('Now', now.length > 0 ? now.map(row) : <Text color="subtle">No context or plan-limit readings yet: they arrive with the first response.</Text>)}

        {section('Tasks', tasksMeter ? (
          <Box flexDirection="column">
            {row(tasksMeter)}
            {taskLines(list, ascii).map((t, i) => (
              <Text key={`task-${i}`} color={COLOR[t.tone]} wrap="wrap">  {t.text}</Text>
            ))}
          </Box>
        ) : <Text color="subtle">No task list in this session yet (Claude keeps one for multi-step work).</Text>)}

        {section('Agents', agentsHead ? (
          <Box flexDirection="column">
            {row(agentsHead)}
            {agents.slice(-8).map(g => row(agentRow(v.activity, g, v.now, v.agentStats)))}
          </Box>
        ) : <Text color="subtle">No subagents in this task.</Text>)}

        {section('Recommendations', tips.length > 0 ? (
          <Box flexDirection="column" rowGap={1}>
            {tips.map(t => (
              <Box key={`tip-${t.id}`} flexDirection="column">
                <Text color={t.severity === 'urgent' ? 'error' : t.severity === 'warn' ? 'warning' : 'suggestion'} bold wrap="wrap">{t.title}</Text>
                <Text color="subtle" wrap="wrap">{t.detail}</Text>
                <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                  {t.action && <Button key={`pane-tip-${t.id}`} label={TIP_LABEL[t.action] ?? 'Do it'} onPress={() => runTip($, t.action)} />}
                  <Button key={`pane-dismiss-${t.id}`} label="Dismiss" onPress={() => dismissTip($, t.id)} />
                </Box>
              </Box>
            ))}
          </Box>
        ) : <Text color="subtle">Nothing to do: context, cache and pace look fine.</Text>)}

        {section('Checks', <Text wrap="wrap">{checksLine(v) ?? 'No checks observed in this task yet.'}</Text>)}

        {section('Usage report', usageText(v).split('\n').map((line, i) => (
          <Text key={`u-${i}`} color={line.startsWith('  ') ? 'subtle' : 'text'} wrap="wrap">{line.length > 0 ? line : ' '}</Text>
        )))}

        {section('Recent decisions', historyText(v).split('\n').map((line, i) => (
          <Text key={`d-${i}`} color="subtle" wrap="wrap">{line}</Text>
        )))}
      </Box>
    )
  })
}

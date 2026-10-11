// Quality Router: the data contract shared by the hooks module, its pure
// policy modules and the `$.state` values the engine holds for the session.
// Self-contained on purpose: `claude plugin validate` reads it as the
// mod's state contract, so it imports nothing.

/** Capability tiers. Concrete model ids per tier are configuration. */
export type Tier = 'cheap' | 'middle' | 'strong'

/** ON applies decisions, DRY RUN only logs them, OFF passes everything through. */
export type RouterState = 'on' | 'off' | 'dry-run'

export type RouterMode = 'quality-first' | 'balanced' | 'economy'

/** The five effort levels this Claude Code build accepts (ModelEffort). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Override =
  | { kind: 'auto' }
  | { kind: 'tier'; tier: Tier }
  | { kind: 'model'; model: string }

export type ReviewPolicy = 'off' | 'suggest' | 'auto'

/** USD per million tokens, as a dated, sourced price list states them. */
export type PriceRow = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export type ModelPrice = PriceRow & {
  /**
   * Prices for a request whose prompt (input + cache read + cache write)
   * exceeds 100,000 tokens, where the price list has such a tier.
   */
  over100k?: PriceRow
  source: string
  asOf: string
}

export type Prefs = {
  version: 1 | 2
  state: RouterState
  mode: RouterMode
  models: Record<Tier, string>
  override: Override
  floor: Tier | null
  effort: Partial<Record<Tier, Effort>>
  /** Let the router choose effort per task (conservatively) when no per-tier effort is set. */
  autoEffort: boolean
  /**
   * Compact automatically when a turn ends with the prompt at or above this
   * many tokens (routing ON only); null = off, the band only suggests it.
   */
  autoCompactTokens: number | null
  /**
   * Smart auto-compaction. 'on': compact at a task boundary (the task list is
   * complete and no check is failing) once the prompt reaches
   * `autoCompactBoundary` tokens, and mid-task only past `autoCompactCeiling`;
   * the plain threshold above is then not used. 'watch': the plain threshold
   * stays in charge, and the band and `autocompact report` show when smart
   * would have compacted. 'off': neither.
   */
  autoCompactSmart: 'off' | 'watch' | 'on'
  autoCompactBoundary: number
  autoCompactCeiling: number
  classifier: {
    enabled: boolean
    /** Paid classifier calls while in DRY RUN: off unless explicitly enabled. */
    inDryRun: boolean
    timeoutMs: number
  }
  subagents: boolean
  /** Pause automatic routing when the person picks a model with /model. */
  respectManual: boolean
  review: ReviewPolicy
  /** Downgrades are held while the live prompt exceeds this many tokens. */
  downgradeContextLimit: number
  maxEscalationsPerPhase: number
  pricing: Record<string, ModelPrice>
  /** Cache-write TTL assumed when pricing cache writes. */
  /** The prompt cache's lifetime: 'auto' infers it from what requests read after idle gaps (1h until there is evidence of 5m). */
  cacheTtl: '5m' | '1h' | 'auto'
  /** Model the same-volume estimate compares against; null = the session's own. */
  baselineModel: string | null
  ui: { ascii: boolean; showReason: boolean; showLimits: boolean; statusLine: boolean; band: 'full' | 'compact' | 'off' }
}

export type Risk = 'low' | 'medium' | 'high'

export type Category =
  | 'extraction'
  | 'summarize'
  | 'classify'
  | 'mechanical'
  | 'question'
  | 'docs'
  | 'implement'
  | 'debug'
  | 'test'
  | 'refactor'
  | 'review'
  | 'architecture'
  | 'diagnosis'
  | 'security'
  | 'unknown'

/** What the deterministic rules concluded about a task; never holds its text. */
export type Analysis = {
  category: Category
  risk: Risk
  ambiguity: Risk
  breadth: 'single' | 'few' | 'broad'
  readOnly: boolean
  tdd: boolean
  tier: Tier
  confidence: number
  signals: string[]
}

export type ClassifierVerdict = {
  category: Category
  complexity: Risk
  risk: Risk
  verifiability: Risk
  tier: Tier
  confidence: number
  reason: string
}

export type DecisionSource =
  | 'rules'
  | 'classifier'
  | 'fallback'
  | 'override'
  | 'escalation'
  | 'explicit'
  | 'held'

export type Decision = {
  tier: Tier
  model: string
  effort?: Effort
  /** Who chose `effort`: the automatic policy, or a per-tier preference. Absent: the session's own effort is kept. */
  effortSource?: 'auto' | 'preference'
  effortReason?: string
  /** The session effort the decision was made against: a change (via /effort) invalidates it. */
  baseEffort?: string | null
  source: DecisionSource
  confidence: number
  reason: string
  category: Category
  risk: Risk
  epoch: number
  at: number
}

export type RepairTrack = {
  failedAttempts: number
  lastFailureSourceVersion: number | null
  envFailures: number
}

/** Routing state of one scope: the main loop's phase or one subagent. */
export type ScopeRoute = {
  decision: Decision | null
  escalations: number
  escalationReasons: string[]
  sourceVersion: number
  testVersion: number
  startSourceVersion: number
  repair: Record<string, RepairTrack>
  riskTouched: string[]
  tdd: boolean
}

export type Phase = ScopeRoute & {
  id: string
  startedAt: number
  promptDigest: string
  analysis: Analysis | null
  classified: 'none' | 'pending' | 'done' | 'failed' | 'skipped'
  verdict: ClassifierVerdict | null
  /** Usage of this phase's requests (main loop, subagents and classifier). */
  tokens: Tokens
  unknown: number
  /** Sensitive files edited while this phase ran below the strong tier. */
  editsBelowStrong: string[]
  /** Prompt tokens of the last request before this phase began: the context it inherited. */
  startContext: number
  /** How many phases this session had before this one. */
  ordinal: number
  /** Main-loop requests made in this phase so far. */
  requests: number
  /** Where the analysis came from: the prompt, or the phase's task list when the prompt said too little. */
  analysisSource: 'prompt' | 'tasks'
  /** The prompt starts a step of a plan ("start phase 3", "next step"). */
  planPrompt: boolean
  /** Digest of the task subjects the analysis was last taken from (re-assess only when they change). */
  tasksDigest: string | null
  /** The risk the prompt itself carried: a task list never lowers it. */
  promptRisk?: Risk
}

export type AgentRoute = ScopeRoute & {
  agentId: string
  subagentType: string
  /** The model the Agent call would have run on without the router (its own, else the parent's). */
  askedModel?: string | null
  analysis: Analysis
  applied: boolean
  startedAt: number
  done: boolean
}

export type ActiveRequest = {
  model: string
  effort: string | null
  routed: boolean
  agentId?: string
  startedAt: number
}

export type Runtime = {
  /** Bumped by every routing-relevant preference change: stale work checks it. */
  epoch: number
  /** Edits seen this session (source and test files): the code state checks are tied to. */
  code: { source: number; test: number }
  phase: Phase | null
  agents: Record<string, AgentRoute>
  active: Record<string, ActiveRequest>
  /** The session's own model as the engine resolved it for the last main request. */
  sessionModel: string | null
  /** The model the last main response reported (observed). */
  observedModel: string | null
  /** The session's own effort for main requests, as the engine resolved it (before any router change). */
  sessionEffort: string | null
  /** The last main request's effort: what was sent, and what Claude Code reported as applied. */
  lastEffort: { sent: string | null; applied: string | null }
  /** Prompt tokens of the last main request (input + cache read + cache write). */
  lastPromptTokens: number
  lastRoutedTier: Tier | null
  manual: { model: string; source: string; at: number } | null
  degraded: string | null
  unavailableModels: string[]
  reviewSuggested: string | null
  reviewsRequested: number
  /** When the last main-loop request ended: the main conversation's cache warmth (subagents have their own caches). Null after a compaction. */
  lastMainRequestAt?: number | null
  /** The session's project file and stored history have been read into this state (false again after /clear resets it). */
  loaded?: boolean
}

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Bucket = {
  requests: number
  /** Requests whose usage the API did not report: unknown, never zero. */
  unknown: number
  tokens: Tokens
  /** The part of `tokens` from requests whose prompt exceeded 100,000 tokens. */
  over100k: Tokens
}

export type Role = 'main' | 'subagent' | 'classifier'
export type Purpose = 'normal' | 'escalated' | 'fallback' | 'review' | 'classifier'

export type RequestRecord = {
  key: string
  at: number
  role: Role
  purpose: Purpose
  agentId?: string
  phaseId: string | null
  requestedModel: string
  observedModel: string | null
  /** The model Claude Code itself asked for (before any routing): the "stay" path's model. */
  engineModel?: string
  routed: boolean
  /** The model the router chose or proposed (dry run); null when it made no decision. */
  proposedModel: string | null
  /** The effort the request carried, and the session's own: tells lowered and raised requests apart. */
  effortSent?: string | null
  effortSession?: string | null
  usage: Tokens | null
  durationMs: number
  status: 'ok' | 'no-response' | 'aborted' | 'failed-fallback'
}

export type Ledger = {
  sessionId: string
  startedAt: number
  total: Bucket
  byModel: Record<string, Bucket>
  byRole: Record<string, Bucket>
  byPurpose: Record<string, Bucket>
  /** The same usage filed under the model the router chose or proposed (classifier excluded). */
  byProposed: Record<string, Bucket>
  /** Requests the router actually sent on a model other than the one Claude Code chose. */
  routedRequests: number
  /** Requests whose effort the router lowered or raised from the session's own. */
  effortLowered: number
  effortRaised: number
  /** Request keys already counted (bounded): the guard against double counting. */
  seen: string[]
  aborted: number
  noResponse: number
  /** Main-loop turns whose own total disagreed with the sum of their requests. */
  turnMismatches: number
  engineCostUsd: number | null
  /** The cache-aware estimate, built request by request (absent in ledgers from before 0.8.1). */
  cacheAware?: CacheAware
}

export type CheckKind = 'build' | 'test' | 'lint' | 'typecheck' | 'custom'
export type CheckStatus = 'passed' | 'failed' | 'not-run' | 'unavailable' | 'stale'

export type CheckRecord = {
  kind: CheckKind
  label: string
  status: 'passed' | 'failed' | 'unavailable'
  at: number
  sourceVersion: number
  testVersion: number
  detail: string
}

export type Validation = {
  phaseId: string | null
  checks: Record<string, CheckRecord>
  required: CheckKind[]
  acceptance: string[]
}

export type DecisionLogEntry = {
  at: number
  scope: string
  tier: Tier
  model: string
  effort?: string
  source: DecisionSource
  applied: boolean
  reason: string
}

export type History = {
  decisions: DecisionLogEntry[]
  requests: RequestRecord[]
  phases: PhaseOutcome[]
}

export type PhaseOutcome = {
  phaseId: string
  tier: Tier | null
  escalations: number
  /** Main-loop requests the phase made (what break-even switching expects of the next). */
  requests?: number
  verdict: 'verified' | 'failed' | 'unverified'
  tokens: Tokens
  unknown: number
}

export type LimitReading = { t: number; pct: number }

export type LimitTrack = {
  kind: string
  resetsAt: string | null
  readings: LimitReading[]
}

export type Limits = {
  tracks: Record<string, LimitTrack>
  latest: { kind: string; percentUsed: number; resetsAt: string | null; at: number }[]
}

export type ProjectConfig = {
  checks: { kind: CheckKind; pattern: string }[]
  required: CheckKind[]
  acceptance: string[]
  riskPaths: string[]
  floor: Tier | null
  loadedFrom: string | null
  problems: string[]
}

export type ExperimentArm = {
  label: string
  arm: 'routed' | 'baseline'
  spec: string
  startState: string
  validation: string
  environment: string
  sessionId: string
  startedAt: number
  endedAt: number | null
  tokens: Tokens
  requests: number
  unknown: number
  classifierTokens: Tokens
  escalations: number
  retries: number
  durationMs: number
  outcome: { passed: number; failed: number; notRun: number }
}

export type TaskItem = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  /** When the router first saw it in progress, and when completed (epoch ms). */
  startedAt?: number
  completedAt?: number
}

/** Durations and step counts of finished subagent runs, per agent type (bounded), kept across sessions. */
export type AgentStats = Record<string, { durations: number[]; steps: number[] }>

export type AgentActivity = {
  id: string
  description: string
  type: string
  /** The model the spawn resolved to, as Claude Code reported it. */
  model: string | null
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  steps: number
  tools: number
  tokens: Tokens
  unknown: number
  phaseId: string | null
  background: boolean
}

export type ContextReading = { tokens: number | null; window: number; percent: number | null; at: number }

/** What the session is doing, tracked in every routing state (OFF included). */
export type Activity = {
  agents: Record<string, AgentActivity>
  /** The session-wide task list (TaskCreate / TaskUpdate / TaskList). */
  tasks: TaskItem[]
  /** TodoWrite lists, per loop: `main` or a subagent's id. */
  todos: Record<string, TaskItem[]>
  /** When each list first had items: `tasks` for the session-wide list, else the loop's id. */
  listStarted: Record<string, number>
  context: ContextReading | null
  lastRequestAt: number | null
  dismissed: string[]
  compactions: number
  /** The session's savings figure when the current turn began: the band shows what this turn added. */
  savingsMark: { kind: 'saved' | 'could'; usd: number } | null
  /** When the router last compacted on its own (epoch ms): a cooldown between automatic compactions. */
  lastAutoCompactAt: number | null
  /**
   * The outcome of the last thing the router did on its own or at a press
   * (compaction, a fallback, an escalation), shown in the band for a few
   * minutes: the desktop app may not show notifications.
   */
  notice?: { text: string; tone: 'success' | 'warning' | 'error' | 'info'; at: number } | null
  /** When Start fresh was pressed where the prompt box cannot be typed into: the band asks to confirm /clear. */
  pendingClear?: number | null
  /** When smart auto-compact, watching, last noted a moment it would have compacted (one note per 10 minutes). */
  lastWatchAt?: number | null
}

/** One turn end at which smart auto-compact would have compacted, or the plain threshold did (watch mode). */
export type CompactObservation = {
  at: number
  tokens: number
  /** What smart auto-compact would have done here. */
  smart: 'boundary' | 'ceiling' | null
  /** The plain threshold compacted here. */
  plain: boolean
  /** A task was still open here: tasks in progress, or a check failing. */
  midTask: boolean
}

export type Recommendation = {
  id: string
  severity: 'info' | 'warn' | 'urgent'
  title: string
  detail: string
  action: 'compact' | 'new-session' | 'economy' | 'enable' | null
}

/** One session's estimate, kept so savings can be summed across sessions. */
/** One model's prompt cache along a simulated path: how much of the prompt it holds, and when it was last refreshed. */
export type CacheSlot = { size: number; at: number }

/** A path the session's requests could have taken, with each model's cache carried from request to request. */
export type PathSim = { caches: Record<string, CacheSlot>; prompt: number | null; model: string | null }

/**
 * The cache-aware estimate (savings.cacheAwareStep): the requests as they ran,
 * against the same requests had they stayed on the model Claude Code asked
 * for, and had they followed the router's proposals. Switching models makes
 * the new model cache the whole conversation, and coming back makes the old
 * one cache it again; this estimate charges those writes to the path that made
 * them. Output token counts are held equal on every path.
 */
export type CacheAware = {
  actualUsd: number
  stayUsd: number
  followUsd: number
  priced: number
  unpriced: number
  lastActual: { model: string; prompt: number } | null
  stay: PathSim
  follow: PathSim
}

export type SavingsEntry = {
  sessionId: string
  at: number
  /** 'cache-aware' for entries since 0.8.1; older entries priced the same volumes and overstate savings on long conversations. */
  method?: 'cache-aware'
  routedUsd: number
  baselineUsd: number
  requests: number
  routedRequests: number
  failedPhases: number
  verifiedPhases: number
}

declare module 'claude-code' {
  interface PluginState {
    'quality-router': {
      prefs: Prefs
      runtime: Runtime
      ledger: Ledger
      validation: Validation
      history: History
      limits: Limits
      project: ProjectConfig
      experiment: ExperimentArm | null
      activity: Activity
      savingsLog: SavingsEntry[]
      agentStats: AgentStats
    }
  }
}

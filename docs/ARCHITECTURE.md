# Quality Router: architecture, compatibility and limitations

## Layout

| File | Role | Uses `$` |
|---|---|---|
| `hooks/register.tsx` | The native adapter: hooks, the one state layer, commands, band and pane | yes (the only file) |
| `hooks/policy.ts` | Deterministic task analysis and the tier decision | no |
| `hooks/economics.ts` | Whether switching the main model repays the cache it discards (prices, prompt size, cache warmth, expected phase length) | no |
| `hooks/effort.ts` | Switching economics (warm/cold/small/long/no price), plan prompts, task-list re-judging, token-size compaction tips, effort hold, workflow-agent routing | ✓ | ✓ | replayed against your 12-hour session: still Opus (correct: vague prompts on 540k–886k warm contexts), urgent "compact before the next phase" from the first phase |
| Progress and time left: task pace, already-done items, agent history (none / under 3 / typical / over usual), agent rows | ✓ | ✓ | — |
| Automatic effort: lower only for narrow low-risk work, raise for high-risk work and failed repairs | no |
| `hooks/classifier.ts` | When to classify, the fenced prompt, strict reply parsing | no |
| `hooks/escalation.ts` | Tool-outcome classification, repair tracking, validation status | no |
| `hooks/accounting.ts` | Per-request ledger, deduplication, unknown-usage handling | no |
| `hooks/savings.ts` | Same-volume estimate, experiment comparison | no |
| `hooks/limits.ts` | Plan-limit readings and the weekly projection | no |
| `hooks/settings.ts` | Defaults, dated pricing, preference and project-file validation | no |
| `hooks/commands.ts` | `/quality-router` parsing | no |
| `hooks/core.ts` | Pure pieces of the adapter: step plan, scope updates, outcomes | no |
| `hooks/activity.ts` | Subagent lifecycle and task lists (`TodoWrite`, `TaskCreate`/`TaskUpdate`/`TaskList`) | no |
| `hooks/eta.ts` | Completion estimates: task-list pace, agent-type typical durations, time left | no |
| `hooks/advisor.ts` | Recommendations: compact, start fresh, weekly pace, enable routing | no |
| `hooks/present.ts` | Band and pane content: meters, bars, savings headline, agent rows | no |
| `hooks/view.ts` | Everything the band, pane and commands display | no |
| `types/index.d.ts` | The data contract, including the `$.state` keys | no |

Claude Code requires every use of `$` to stay in the hooks module itself: `claude plugin validate` refuses `$` passed across an import. The official pages don't mention this, but 2.1.293 enforces it. So `register.tsx` holds all I/O, and every decision that can be made without I/O sits in a pure module that's unit-tested directly.

## Event flow

| Event | What the router does |
|---|---|
| `session.start` | Registers `/quality-router`, loads preferences from `$.store`, restores this session's ledger and limit readings, reads `<project>/.claude/quality-router.json` |
| `turn.start` | A new prompt starts a **phase**: the rules analyse it and the text is kept in memory for a possible classifier call. Follow-ups such as "yes" or "go ahead" continue the current phase. |
| `turn.step` | For every model request (main loop and subagents): decide once per phase (and per epoch), then rewrite `model`/`effort` on the way down when ON. Records the API-reported usage. If a routed request returns nothing at all, it is re-sent unchanged. |
| `agent.spawn` | Picks a built-in subagent's model when it starts. Explicit models, forks, teammates, workflow agents and plugin-defined agents are left alone. |
| `tool.call` | After the tool runs: edits move the code state, checks are recorded against it, failures feed escalation, sensitive edits and destructive commands raise risk. Results pass through untouched. |
| `classic.PostToolUse`, `classic.Stop` | Read the effort level Claude Code reports as applied (main loop), shown beside the effort the router sent |
| `classic.PostModelSwitch` | A `/model` or picker change pauses routing (manual precedence). An engine fallback marks the router degraded. |
| `turn.complete` | Cross-checks the turn total against its requests, reads context fill, plan limits and `/cost`, may suggest a review, persists the ledger and the per-session savings estimate. A subagent's completion ends its activity row (done / failed / stopped). |
| `session.measure` | Records new plan-limit readings |
| `session.end` | Finishes a running experiment and persists the ledger |
| `ui.render` `AbovePrompt` / `Pane` | Band and detail pane. Another mod's band content is kept beneath the router's. |

## The decision

Order of precedence, highest first:

1. Your manual override.
2. Safety floors: high-risk work is strong-tier in every mode; then the configured and project floors.
3. Escalation steps.
4. The classifier's verdict, which can only move within the risk floor the rules set.
5. The rules.
6. A downgrade of the main conversation is held unless it pays for the cache it throws away (`economics.switchPays`): a one-time cost (new model's cache write plus the old model's rewrite on return; only the difference when the cache is already cold) against the per-request saving, over the phase's expected length, with a 1.5× margin. With no price for a model, the plain rule applies: no downgrade above `downgradeContextLimit` (80k).

Low confidence moves one tier up. A decision covering the tier the session's own model already belongs to keeps that exact model, including its context-window variant (e.g. `claude-opus-5-5[1m]`).

**Phase stability:** a phase's decision is cached until one of three things happens:
- the epoch changes (any routing-relevant preference change, ON/OFF, a manual model switch),
- an escalation drops it,
- a new phase starts.

Phase boundaries are heuristic: a new user prompt that isn't a continuation.

**Escalation** is bounded and evidence-based:
- **Repeated failed repairs.** A check fails after the source changed since its previous failure. Two such failures in quality-first and balanced (three in economy) raise the tier by one, at most `maxEscalationsPerPhase` (2) times.
- **Newly discovered risk.** An edit to a sensitive path or a destructive command moves straight to the strong tier.
- **Never counted:**
  - a red test before any implementation, or under TDD
  - the same failure re-run without an edit
  - environment problems and missing dependencies
  - timeouts
  - cancellations and permission denials
  - empty test runs
  - non-check commands

An escalation changes the next request's model. Nothing is replayed or re-run.

## Capability table (Claude Code 2.1.293, from the installed declarations)

| Capability | Status | Mechanism / note |
|---|---|---|
| Observe submitted prompts | Supported | `turn.start` (`prompt.submit` exists too) |
| Override main-agent model per request | Supported; **routed ID accepted by the API: needs live verification** | `turn.step` `next({...e, model})`. A live headless run confirmed the outgoing request was rewritten to `claude-haiku-5-5`, but auth failed before the API answered. |
| Override effort | Supported in the types; per-model support needs live verification | `turn.step` `effort`. The engine silently lowers effort a model doesn't take (hook docs). Unset by default. |
| Subagent model | Supported (mock-tested) | `agent.spawn` `{ model }` |
| Per-request usage | Supported | `turn.step` result `usage`: 4 counts plus the responding model. `null` → unknown. |
| Request duration | Partial | Measured by the mod with `$.clock` |
| Tool results and Bash status | Supported | `isError`, `text`, `deny`, `interrupted`, `timedOutAfterMs`. No numeric exit code in the record. |
| Manual model selection detection | Supported | `classic.PostModelSwitch` `source` |
| Persistent preferences | Supported | `$.store` (4 MiB, shared by all sessions) |
| Session/agent-scoped state | Supported | `$.state` with a contract; resets on `/clear` and `/resume` (prefs reload from the store) |
| Above-prompt band with buttons | Supported, terminal and desktop | `ui.render` `AbovePrompt` |
| Detail pane | Supported | `$.ui.open` + `ui.render` `Pane` |
| Slash command | Supported | `$.command.register` (`immediate`) + `command.run` |
| Compaction | Terminal: `$.session.compact`. SDK hosts (desktop app, `-p`): **refused**, so `$.command.run({ command: 'compact' })` | Verified live on 2.1.296: `$.session.compact` is refused from inside a `command.run` hook (it holds the turn) and in every SDK session ("not available in a headless (-p / SDK) session yet"). The router therefore schedules compaction on a timer, tries `$.session.compact`, and on the SDK refusal runs `/compact` with the same instructions. |
| Classifier with timeout | Supported | `$.model.complete({ timeoutMs })`. Its result has usage but no responding-model ID. |
| Provider plan limits | Supported (subscription only) | `session.measure` / `$.session.usage().rateLimits` |
| Model catalogue and per-model capabilities | **Unsupported** | Models are configuration |
| Price catalogue for plugins | **Unsupported** | Dated, sourced prices are configuration |
| Cache-write TTL per request | **Unsupported** (only `Pre/PostModelSwitch` carry `cache_ttl`, on manual switches) | Inferred (`cache-ttl auto`): a large cache read after a 5.5–55 min idle gap on the same model means the 1-hour cache; repeated full rewrites mean 5 minutes. 1 hour until then |
| Prompt box from a mod in an SDK host | **Refused** (`prompt.fill` → `no_composer`, verified on 2.1.296) | Start fresh asks for a second press in the band and runs `/clear` with `$.command.run` |
| Notifications in the desktop app | Sent (`ui_toast`), display not confirmed | Outcomes also stay as a line in the band for 3 minutes |
| Running validation commands | Deliberately not done | Would bypass the permission flow; checks are observed only |
| Global hotkey | Not used | Button hotkeys work only while the band has focus |

### Where the docs and the installed types differ

- The reference page is "as of v2.1.290", while the session runs 2.1.293. The installed declarations were treated as authoritative.
- The online docs don't state the "`$` stays in one file" rule that `claude plugin validate` enforces.
- Neither the docs nor the types say whether `turn.step` accepts aliases (`haiku`). The defaults are therefore full IDs.
- The terminal `claude` on the development machine was 2.1.283, older than the desktop app's bundled 2.1.293.

## Known limitations

- **Live API acceptance of routed models is unverified here.** The headless smoke test couldn't refresh OAuth from the sandbox. Verify with the dry-run → ON steps in [EVALUATION.md](EVALUATION.md) and check the pane's *observed* model.
- **Phase detection is heuristic.** A short reply that points at the work in hand ("ok implement it", "still failing") continues the task; a reply that names a file or brings its own high risk starts a new one. A genuinely new short task phrased like a follow-up stays on the current task's tier (a cost, never a quality loss).
- **The cache-aware savings estimate is a model.** It holds output tokens equal across paths and approximates the conversation's growth at a model switch (another model can encode the same history in fewer tokens). On the audited sessions two independent versions of it differed by $7–13 on a $220 session; both agreed on the direction.
- **A manual `/model` pause does not survive `/clear`** (the engine resets the mod's state). The project file and stored history are re-read after `/clear`.
- **Escalation is enforced, but signals are heuristic.** "Credible evidence" means observed checks failing after edits; the router can't see test intent beyond what the commands and file paths say. Insufficient confidence mid-task isn't detected from the model's text.
- **Code edits on the cheap tier are seen through edit tools and plain shell writes only.** A file written from inside a script (python, node) isn't seen, so a cheap-tier task that writes code that way isn't moved up.
- **Escalation applies to the next request.** A risky edit already made by a cheaper model isn't undone. Instead, a stronger review is suggested (`review suggest`), or submitted once per phase (`review auto`).
- **Switching models forfeits the prompt cache.** The downgrade hold limits this, but a switch in a long session can cost more than staying put. Subagents start with fresh context, so routing them is where the savings are cleanest.
- **Context windows.** If a routed model's window is smaller than the conversation, the request fails. The router then re-sends it on the session model and sets that model aside for the session.
- **Experiments and the ledger don't survive `/clear`.** The engine resets session state; the old ledger is stored on the next turn.
- **Classifier usage** is filed under the requested cheap model, labelled *as requested*, because `$.model.complete` doesn't report the responding model.
- **Automatic effort is a heuristic.** It lowers effort only for narrow, low-risk, unambiguous work. Its effect on quality is guarded by the checks it observes, not proven: a failed check stops lowering for the task. Claude Code may also lower a level the model doesn't take, and the band then shows "last applied …". Whether each routed model accepts each effort level has not been verified live.
- **Main-model switching is rare on long sessions, by design.** On large warm contexts a switch rarely repays the discarded cache. The economics assume you return to the session's model afterwards, and that the remaining requests are like the session's typical phase.
- **Task-list re-judging needs a task list.** If Claude doesn't write one for a phase (e.g. it hands the work to workflow agents), the phase stays on the strong tier, and the workflow agents are routed instead.
- **Time-left estimates are extrapolations.** Task time assumes the remaining tasks take about as long as the finished ones. Agent time assumes this run is like the typical past run of its type, and a different-sized job won't be. Both are labelled *est.*; neither is a promise.
- **Recommendations are heuristics with fixed thresholds** (70/90% context, 40k/60k/80k tokens, 5 min idle). They never act on their own: compaction needs a button press (or the opt-in auto-compact), and a new session needs you to press Enter on the `/clear` the button types.
- **Before 0.7.1 the Compact button, `/quality-router compact` and auto-compact never compacted.** The command path was refused because it ran inside the command hook; the desktop app refuses `$.session.compact` outright; and the error was swallowed. The test kit enforces neither rule, so the mock tests passed. 0.7.1 fixes this and reports the real reason when a compaction fails.
- **Agent progress** is a real percentage only when the agent keeps a task list; otherwise it is activity counts.
- **Plan-limit projection** is linear in time. Bursty use (a work day, then nothing) makes the recent-pace estimate pessimistic during work hours, and the window average assumes a fixed window length.

## Test coverage

`claude plugin test` runs 213 tests in 14 files (integration tests have a 30 s limit so they stay reliable on a busy machine) against the 2.1.293 engine's test kit.

| Area | Unit (pure) | Mock integration (native kit) | Live |
|---|---|---|---|
| Tiers: mechanical, scoped, architecture, security, low confidence | ✓ | ✓ (cheap/middle/strong sent) | rewrite of the outgoing request observed; API answer not observed |
| Floor, manual override, held downgrade, effort validation, unavailable model | ✓ | ✓ | — |
| Classifier: timeout, malformed, injection, no-recursion, cache, OFF/DRY RUN, pending disable | ✓ | ✓ | — |
| Escalation: TDD red, repeated repairs, environment, cancellations, bound, risk edits, no replay | ✓ | ✓ | — |
| State and UI: button = command, persistence, indicators, toggle mid-request, re-enable, manual pause, concurrent subagents, band coexistence, pane | — | ✓ (terminal + desktop surfaces) | the command and persistence ran live (headless) |
| Accounting: unknown ≠ 0, dedupe, cache categories, long prompts, interrupted, classifier overhead, reload, `/clear` | ✓ | ✓ | unknown-usage path observed live (auth failure) |
| Savings: estimate, negative, missing price, no baseline, failed validation | ✓ | — | — |
| Automatic effort: lowered / kept / raised, failed check stops lowering, /effort change, auto off, dry run | ✓ | ✓ | — |
| Weekly projection, including too-little-data cases | ✓ | ✓ | it ran on your real readings and correctly reported "not enough data yet" |
| Task and agent progress, bars, recommendations (compact / start fresh / dismiss), savings headline, band sizes | ✓ | ✓ (terminal + desktop surfaces) | `tips`, `savings` and `limits` ran live |

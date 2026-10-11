# Quality Router

A native Claude Code mod that picks the least expensive *capable* Claude model for each task phase. When in doubt it chooses the stronger model, and it escalates when there is evidence the work is going wrong. It reports token usage and savings honestly, shows when you're projected to hit your weekly limit, and puts an ON / OFF / DRY RUN control, with a one-button mode switch, above the prompt.

It changes models through the Mods API's own request hook (`turn.step`) and subagent hook (`agent.spawn`). It isn't a skill or a CLAUDE.md instruction, and it doesn't use a proxy or patch Claude Code.

```
╭────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ● Router ON Next: Sonnet 5.5 (middle) · effort high (session setting) · Quality-first          │
│ why: implement                                                                                 │
│ Saved ━━━━━━━━━━── est. $1.84 this session · +$0.12 this turn · 38% less than all Opus 5.5    │
│ Context ━━━━━━━━━─── 71% 141k / 200k   Weekly ━━━━──────── 41% est. limit Thu Oct 15 14:20   │
│ Tasks ━━━━━━────── 2/4 Writing tests for refresh   Agents ━━━━━━────── 1/2 1 running · …     │
│ ▲ Context 71% full: compact soon                                                               │
│ [ Compact now ] [ Dismiss ] [ Turn off ] [ Dry run ] [ Balanced mode ] [ Usage ]               │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**First install starts in DRY RUN.** In that mode it logs what it *would* pick and changes nothing.

## Requirements

- Claude Code **2.1.293** or newer. The mod was built and tested against 2.1.293's Mods API, which is early access and changes between releases. Check with `claude --version`.
  - On the development machine, the terminal `claude` was 2.1.283, older than the desktop app's 2.1.293. Update the terminal CLI before using it with this mod:

```bash
claude update
```

- Above-prompt band: terminal and desktop (Code tab) only. VS Code and mobile have no band, but the `/quality-router` command and the optional status line work there.

## Try it in dry-run mode (no install)

Load it for one terminal session only. Nothing is installed, and your settings are not changed:

```bash
claude --plugin-dir "/absolute/path/to/quality-router"
```

Then, in that session:

1. The band shows `◐ Router DRY RUN | Proposed: …`. Work normally.
2. `/quality-router status` shows what it would pick and why.
3. `/quality-router usage` (or the **Usage** button) opens the detail pane: observed usage, the estimate, plan limits, and the decision history.

*Verified:* loading with `--plugin-dir` and the `status` / `on` / `dry-run` commands were run live on 2.1.293 (headless).

### Desktop app (Code tab) and terminal: the recommended setup

Clone the repository:

```bash
git clone https://github.com/Jasonf90/quality-router.git
```

Then point Claude Code at the folder through the `env` block of `~/.claude/settings.json`. Every session reads this, whether the desktop app or a terminal starts it:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/quality-router" } }
```

The mod then loads as `quality-router@inline`, and `claude plugin list` shows it as *loaded*. There's one copy, so one set of settings and history.

Don't combine this with the marketplace install below. When a plugin comes from a local folder marketplace, the desktop app loads it under the *inline* identity, while terminal sessions use the installed identity. That gives two copies, each with its own settings and history.

To remove the mod, delete the `CLAUDE_CODE_PLUGIN_DIRS` entry.

## Install from GitHub

This repository is its own one-plugin marketplace (`.claude-plugin/marketplace.json`):

```bash
claude plugin marketplace add Jasonf90/quality-router
```

```bash
claude plugin install quality-router@quality-router
```

It starts in **DRY RUN**: it shows what it would do and changes nothing until you press **Enable** or run `/quality-router on`.

If you use the Claude Code desktop app, prefer cloning the repository and pointing `CLAUDE_CODE_PLUGIN_DIRS` at it (above): a marketplace install and a folder load must not be combined, or you get two copies with separate settings.

## Enabling, OFF, disabled, uninstalled

| | Router OFF | Plugin disabled | Plugin uninstalled |
|---|---|---|---|
| Model choice | Claude Code's own | Claude Code's own | Claude Code's own |
| Band, `/quality-router`, usage tracking | stay | gone | gone |
| Preferences and history in the plugin store | kept | kept | removed with the plugin (or left until cleanup) |
| How | **Turn off** button, or `/quality-router off` | `claude plugin disable quality-router@quality-router` | `claude plugin uninstall quality-router@quality-router` |

Re-enable a disabled plugin with:

```bash
claude plugin enable quality-router@quality-router
```

## The band and the Usage pane

The band above the prompt keeps its buttons on a row of their own at the bottom, so they never cover text. It has these parts:

- **State, model and effort:** ON / OFF / DRY RUN, the next model and its exact effort level, the mode and the reason.
  - The effort is labelled *set by router* (from `/quality-router effort <tier> <level>`) or *session setting* (the router left it alone).
  - When Claude Code reports applying a different level (it lowers a level the model doesn't take), the band adds *last applied …*.
- **The mode button:** one button steps Quality-first → Balanced → Economy → Quality-first. It is labelled with the mode it switches *to* (so **Balanced mode** means "switch to Balanced"), while the current mode stays in the state row. The Usage pane has the same button, and both go through the same setter as `/quality-router mode …`. Switching the mode never changes the routing state.
- **Savings, all session long:** its own row, updated after every request.
  - **Saved est. $X this session** (or **Cost more est. $X**), plus **+$Y this turn**, the percentage versus staying on Claude Code's own model, and the all-sessions total. It is *cache-aware*: each model switch is charged for caching the whole conversation on the new model, and again on the way back (see *Viewing usage and savings*).
  - Before anything is routed (OFF or DRY RUN) it reads **Could save est. $X this session if ON**, priced the same cache-aware way. That uses the deterministic rules only: no classifier calls and no change to any request.
- **What just happened:** the outcome of a button or of something the router did on its own (a compaction, an escalation, a fallback) stays as a line in the band for three minutes. The desktop app may not show notifications.
  - Once something was routed, the real estimate stays visible even after you turn routing off.
- **Meters with bars:**
  - **Context:** how full the context window is, as Claude Code reports it. Green, then amber at 60%, red at 85%.
  - **Weekly limit:** the provider's percentage, plus the estimated limit time.
- **Work in progress:**
  - **Tasks:** done/total from Claude's task list (`TodoWrite`, or `TaskCreate`/`TaskUpdate`), with the step in progress.
  - **Agents:** finished/total subagents for the current task, with what's running.
- **The top recommendation**, with its action button and **Dismiss**.

These are tracked in every routing state, OFF included.

The **Usage** button (or `/quality-router usage`) opens the full pane:
- Now: context, weekly and 5-hour limits
- Savings: routed vs. baseline cost bars, a requests-by-model share bar, an all-sessions total
- The task checklist
- Every agent with its model, steps, tool calls, tokens and time
- All recommendations
- Checks, the full usage report, and recent decisions

### Progress bars and time left

- **Task list:** completed/total, with time left once the first task finishes, e.g. `2/4 Writing tests · ~5m10s left · done ~14:32 (est.)`.
  - The pace is the time per task observed in *this* list.
  - The task in progress counts the time it has already run.
  - Tasks that were already done when the list was first seen don't set the pace.
  - Until a task finishes it says "time left: estimating".
- **Each running subagent gets its own row in the band** (up to three; all of them in the pane). Each row shows a bar, a percentage and time left:
  - **From its own task list**, when it keeps one; or
  - **From how long finished runs of the same agent type took on this machine**, once at least 3 have finished. The typical run is the median. These run times are kept across sessions.
- **Agents:** finished/total for the task, plus when they should all be done, once every running agent has an estimate.

Honesty rules:
- Every time figure is marked *est.*
- An agent with no basis for an estimate shows "working" and its live activity (steps, tools, tokens, time) with no percentage.
- An agent past its usual time shows "over usual" rather than a negative countdown.
- No running agent ever shows 100%.
- The band refreshes every 30 seconds so time left keeps moving.

`/quality-router band compact` shrinks the band to one row; `band off` hides it (routing continues); `band full` restores it.

### Recommendations (`/quality-router tips`)

| When | Suggests | Button |
|---|---|---|
| Context ≥ 70% (≥ 90% urgent) | Compact, keeping the current task in focus | **Compact now** compacts with focus instructions, a moment after you press it (between turns only) |
| A new task starts on ≥ 60k tokens of earlier context | A new session if it's unrelated, or compact if it builds on the earlier work | **Start fresh** |
| Checks passed and the prompt is ≥ 40k tokens | A new session for the next task | **Start fresh** |
| Idle past the cache's lifetime (an hour, or 5 minutes where that is observed) with a large prompt | The cache has likely expired, so this is the cheapest moment to switch | **Start fresh** |
| 5+ tasks in one session on ≥ 80k tokens | One session per task | **Start fresh** |
| Weekly limit projected before reset | Economy mode and fresher sessions | **Economy mode** |
| DRY RUN would have saved ≥ $0.10 | Turning routing on | **Turn on** |

**Auto-compact (opt-in)** comes in two kinds.

*Plain:* `/quality-router autocompact 300k` compacts a moment after a turn ends at or above that size, wherever the task is.

*Smart:* `/quality-router autocompact smart` picks the moment instead:
- **At a finished task:** when the task list is complete and no check is failing, once the conversation is past **150k** tokens. Little is lost then, and the next task starts small.
- **Mid-task only past 400k:** a long task is still trimmed, but a task in progress is otherwise left alone, because a summary written mid-task can drop the error messages and the fixes already tried.
- With no task list, only the 400k ceiling applies.
- Sizes: `autocompact boundary <size>`, `autocompact ceiling <size>`.

*Watching first:* `/quality-router autocompact watch` leaves the plain threshold in charge and changes nothing, but notes each moment smart *would* have compacted. A line appears in the band ("would compact now: the task is finished, 180k tokens"), and `/quality-router autocompact report` lists the moments, and how many plain compactions happened with a task still open. When the timing looks right, `autocompact smart` switches over.

Both kinds:
- run only while routing is ON;
- never run after an interrupted or failed turn, or while a subagent is still running;
- wait at least 10 minutes between automatic compactions;
- skip a turn end if you start typing first (Claude Code refuses it then), and try again at the next one;
- tell the summary to keep the plan, what's done and what's next, your stated preferences and constraints (in your words where possible), the approaches already tried and rejected, and unresolved error messages verbatim;
- say when they happened, in a notification and in the band.

Recorded sessions show what compaction saves (29–52% at 300k), but not whether a summary dropped something that mattered: that is what watching is for.

**How compaction runs.** A compaction takes a minute or two on a large conversation. **Compact now**, `/quality-router compact` and auto-compact all say at once that they started, show *Compacting…* in the band, and send a notification when it finishes or fails, with Claude Code's reason. In the terminal the router compacts directly. In the desktop app (an SDK session) Claude Code allows compaction only through the `/compact` command, so the router runs `/compact` for you with the same focus instructions; it appears in the transcript like a typed `/compact`.

**Start fresh** never clears on its own. In the terminal it *types* `/clear` into the prompt, and nothing is cleared until you press Enter. In the desktop app, where a mod cannot type into the prompt box, the band asks instead: **Clear now** runs `/clear`, **Cancel** drops it, and it lapses after two minutes. Usage history, settings and the project file survive `/clear`.

Token figures in tips are observed: the context size Claude Code reports, or the prompt size the API reported for the last request.

## Controls

The band's buttons and the commands both go through the same setter, and preferences persist across sessions.

| Command (`/quality-router …`) | Effect |
|---|---|
| `on` · `off` · `toggle` · `dry-run` | Routing state. Takes effect at the next model request; a request already in flight is never changed. |
| `status` · `usage` · `limits` · `config` | Show state, open the pane, plan limits, all preferences |
| `savings` · `tips` · `compact` | Savings summary, recommendations, compact now (focused on the current task) |
| `band full\|compact\|off` | Size of the band above the prompt |
| `autocompact <tokens>\|off` | Compact automatically when a turn ends this large, e.g. `300k`. Off by default. |
| `autocompact smart\|watch\|report` | Compact at finished tasks (from 150k) and mid-task only past 400k; or watch when it would, first; or list what watching saw |
| `autocompact boundary\|ceiling <tokens>` | Smart auto-compact's sizes |
| `mode quality-first\|balanced\|economy` | How willing the router is to go cheap (safety floors apply in every mode). The band and pane mode button cycles the same three. |
| `model auto\|cheap\|middle\|strong\|<model-id>` | Manual override. `auto` hands selection back to the router. |
| `floor none\|cheap\|middle\|strong` | Never route below this tier |
| `effort auto on\|off` | Automatic effort (on by default; see *Automatic effort*) |
| `effort <tier> low\|medium\|high\|xhigh\|max\|default` | A fixed effort for one tier; it overrides automatic effort |
| `models cheap=<id> middle=<id> strong=<id>` | The concrete model per tier |
| `price <id> input= output= write5m= write1h= read= source=<url> date=YYYY-MM-DD` · `price clear <id>` | Prices in USD per million tokens, with a source and date |
| `baseline session\|<id>` | Model the same-volume estimate compares against |
| `classifier on\|off` · `classifier dry-run on\|off` · `subagents on\|off` | Classifier and subagent routing |
| `review off\|suggest\|auto` · `review now` | Stronger-model review of sensitive changes |
| `resume-auto` · `reset-task` | Resume after a manual `/model` change; start routing afresh. Usage history is kept. |
| `ascii on\|off` · `statusline on\|off` · `cache-ttl 5m\|1h\|auto` | Display and pricing options. `auto` (the default) learns the prompt cache's lifetime from what requests read after idle gaps, and assumes 1 hour until it sees otherwise |
| `experiment start\|stop\|report\|list` | Record comparable runs (see [docs/EVALUATION.md](docs/EVALUATION.md)) |

The command is registered as `immediate`, so `/quality-router off` works mid-turn.

**Manual `/model` changes:** if you pick a model with `/model` or the model picker, the router pauses and the band shows `Manual: … (router paused)`. Press **Resume auto** or run `/quality-router resume-auto` to give selection back.

**Indicators** use text plus colour, never colour alone:
- `● Router ON` (green)
- `○ Router OFF` (dim)
- `◐ Router DRY RUN` (amber)
- `⚠ Degraded: …` (red)

`/quality-router ascii on` switches to `[ON]` / `[OFF]` / `[DRY]` / `[!]`. The band separates *Active* (the requested model of a request in flight) from *Next* or *Proposed*. The detail pane shows the model the API reported as the responder, labelled *observed*.

## Quality guarantees (tested)

`tests/guarantees.test.ts` checks these rules over every combination the router's decision can see: each task category, risk, ambiguity, breadth, rules tier, confidence, mode, session effort, and the escalation, classifier-fallback and failed-check flags (437,400 decisions per rule):

- High-risk work (auth, payments, privacy, migrations, security, production, sensitive data) always runs on the strongest tier, in every mode.
- Tasks judged to be code work (implementing, fixing, testing, refactoring, reviewing, design, diagnosis) never start on the cheap tier, in any mode. A *mechanical* edit is only one with no fix, refactor or behaviour change in it: "fix the typo" is mechanical, "bump the version and fix the crash" or "change the validation so…" is not.
- A task that did start on the cheap tier (a look-up, summary or question) and then writes code moves up to the middle tier for the rest of the task. This applies to an edit to a source file, or a shell command that plainly writes one (`sed -i`, a redirect, `tee`). Mechanical edits (typos, renames, version bumps) stay where they are. Unlike the rules above, this one is checked by its own tests, not the exhaustive sweep.
- In quality-first, the cheap tier gets only mechanical edits, look-ups, summaries and classification.
- Quality-first and balanced never route below the tier the rules judged a task needs. In quality-first a classifier verdict can only raise that tier (in balanced and economy it may lower it).
- After a failed repair, the next request runs on a stronger tier (or already the strongest), at effort `high` or above, and never below your own effort level. An escalation never lands below the tier the work was already running on.
- Effort is never lowered for code work, or when anything is uncertain: risk, ambiguity, a classifier fallback, a failed check, an escalation.
- Quality-first lowers effort by one step at most, and gives critical work (high risk, architecture, diagnosis, broad changes) at least `high`.
- A classifier verdict can't lower the safety floor: it can't move high-risk or medium-risk work, or code work in quality-first, onto the cheap tier.

These are checked by their own tests (`escalation.test.ts`, `policy.test.ts`):

- **Follow-ups carry the task on.** "ok implement it", "the test still fails, try a different approach", "go with option 2" and background tasks reporting back keep the task's risk, tier and escalations. A follow-up can raise the task ("…and do the same across the whole app"), never lower it. A reply that names a file, or brings its own high risk, is new work.
- **Risk found while working lasts.** Once a task touches a sensitive file (auth, payments, keychain…) or runs a destructive command, it stays on the strongest tier for the rest of the task, whatever is decided later. Two edits in one response are both seen.
- **A task list never lowers the prompt's risk.** A vague prompt ("start phase 3") is judged from the task list Claude writes; a risky prompt keeps its risk however routine the tasks sound, and any task can be raised by its list.
- **Checks it cannot see the end of don't count.** A test run sent to the background is not recorded as a pass. Repairs that only rewrite tests, or are written with `sed`, count as repair attempts.
- **Routine work doesn't escalate.** Deleting build output (`rm -rf build/ DerivedData …`), resetting simulator defaults, or editing a note whose name mentions purchases does not move the task to the strongest tier: those switches cost a full re-cache and add nothing to the quality of the code.

**What the modes trade:**

| Mode | What it may do that quality-first won't |
|---|---|
| quality-first (default) | (none) |
| balanced | Docs on the cheap tier; a task the rules are fairly sure about (confidence 0.5–0.6) isn't moved up a tier; effort to `low` for mechanical work and one step lower for docs and questions; critical work kept at least at `medium` effort |
| economy | All of balanced, and: work the rules put on the strongest tier for its size (broad implementations, fixes, tests and refactors) moves to the middle tier, unless it is high-risk, architecture, diagnosis or review; a task the rules are only fairly sure about (confidence 0.4–0.6) isn't moved up a tier; read-only questions go to the cheap tier; no effort floor for critical work |

Economy is the only mode that runs work below the tier the rules judged it needs. Choose it when the weekly limit matters more than the first attempt; failed checks still escalate.

## When switching models actually pays

Switching the *main conversation* to another model throws away the prompt cache. The new model has to cache the whole prompt, and coming back later makes the old one do it again. So the router weighs a downgrade before making it:

- It compares:
  - the one-time cost: the new model's cache write, plus the old model's rewrite on the way back
  - the per-request saving: cheaper cache reads and cheaper output
- It uses the dated official prices, the prompt size, whether the cache is still warm (last main-conversation request within the cache's lifetime), and how many requests your phases take in this session (the median once 3 phases have finished; 10 until then).
- **The cache's lifetime is learned, not assumed.** Claude Code doesn't report it per request, so with `cache-ttl auto` (the default) the router watches requests after idle gaps: a large cache read after more than 5 minutes means the 1-hour cache. Until it sees repeated expiries it assumes 1 hour, the conservative choice for switching (the desktop app's sessions observed so far all used it).
- It switches only when the saving repays the switch within the phase, with a 1.5× margin. The band then says why, e.g. `kept middle: switching pays back after ~60 requests at 602k tokens (warm cache)`.
- **Cold cache:** staying would write the cache once; switching writes the new model's cache now *and* the old model's again on the way back. So on a cold cache the new model's whole write is still a cost, though only half of the warm case. A small cold conversation pays quickly; a large one rarely does.
- **After a compaction** the conversation is small and uncached, so the next decision starts from the new size.
- **No price for the model** (e.g. `claude-opus-5`): it falls back to the plain rule of no downgrade above 80k tokens.
- **Upgrades for quality are never held.**

Practical upshot: on a long, warm, 500k-token conversation, the main model rarely changes, because it rarely pays. The savings there come from compacting and from subagents, which start with fresh context.

**Measured on real sessions (2026-10-11 audit):** in the one session that routed heavily (Economy mode, 1,450 requests, median prompt 460k tokens), switching the main conversation to Sonnet and Haiku cost about $7–20 *more* than staying on Opus. Each request on the cheaper models was cheaper, but every switch re-cached ~450k tokens, and every return to Opus did it again. Two bugs let that happen and are fixed in 0.8.1: the cache was assumed to last 5 minutes (it lasted an hour), and a cold-cache switch was treated as free. On the same sessions, compacting at 300k tokens would have cut the cost by 29–52%. That is the lever this mod now leans on (`/quality-router autocompact 300k`).

### Plan phases ("start phase 3")

- A short plan-step prompt says nothing about the work, so it skips the classifier, which can't see your plan.
- It starts on the strong tier. When Claude writes the phase's task list, the router re-judges the phase from those tasks and takes the hardest one (quality-first): a risky task anywhere means the strong tier.
- **Compaction tips use token size, not window percentage.** Between phases, once each request re-sends 150k+ tokens, the band offers **Compact now**, with instructions that keep the plan, what's done and what's next. It's urgent from 500k. Mid-phase it warns from 250k.
- Only one compaction tip shows at a time.

### Subagents

- Built-in agents get their model when they start.
- **Workflow agents:** Claude Code only lets a mod refuse one, not re-model it at spawn. So the router decides at spawn and applies the decision to each of the agent's requests, from its first (fresh context, so no cache is lost). A model named in the workflow script is kept.

## Automatic effort (on by default)

The router also picks **effort**, meaning how hard the model thinks, to save thinking tokens where they don't change the result. It works relative to your own `/effort` setting, and it's deliberately lopsided toward quality:

| Situation | Effort |
|---|---|
| Mechanical edits, look-ups, summaries, classification: low risk, unambiguous, confident | **Lowered**: one step in quality-first (high → medium), to `low` in balanced and economy |
| Docs and read-only questions (balanced and economy only) | One step lower |
| Implementing, debugging, tests, refactors, reviews | **Never lowered**: your session effort |
| Auth, payments, privacy, migrations, architecture, hard bugs, broad changes | **Raised** to at least `high` in quality-first (at least `medium` in balanced) |
| Repeated failed fixes | **Raised** (at least `high`), together with the stronger model |
| Unclear request, mixed signals, classifier fallback, or any failed check in the task | Your session effort, unchanged |

Other rules:
- A failed build or test in a task stops all lowering for the rest of that task.
- **Not lowered on a large warm context** (100k+ tokens, cache still warm): an effort change may re-send the prompt uncached, which would cost more than it saves. Raising for quality is unaffected.
- Changing `/effort` mid-task makes the router decide again against the new level.
- A per-tier setting (`/quality-router effort <tier> <level>`) always wins.
- `/quality-router effort auto off` keeps your session effort everywhere.
- The band shows the exact level and why, e.g. `effort medium (auto: lowered for a mechanical change)`. The Usage report counts requests with lowered or raised effort.
- The token effect of a lower effort is already inside the observed output tokens. It isn't credited as a separate saving, because the counterfactual can't be measured.

## Configuring models

The defaults are `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, the IDs on the official models page. Change them with `/quality-router models …`.

The mod doesn't assume an alias resolves to any particular version. What the API reports as the responding model is recorded as *observed*.

If a routed model returns nothing at all (no content, no usage) and you didn't interrupt, the request is re-sent unchanged on the session's model. That model is then set aside for the session and the band shows `⚠ Degraded`.

## Configuring validation (per project)

Copy [examples/quality-router.json](examples/quality-router.json) to `<project>/.claude/quality-router.json`. It is read when the session starts and can:

- add check patterns (build / test / lint / typecheck / custom),
- mark checks as required,
- list acceptance criteria,
- add sensitive paths,
- raise the floor.

Because it is repository content, it **cannot** turn routing on, choose models or lower a floor. Keys that try to are ignored and reported in `/quality-router status`.

Without that file, built-in patterns recognise:
- `xcodebuild` test/build, `swift test`/`build`
- Gradle test/lint/assemble
- `flutter test`/`analyze`/`build`
- npm/yarn/pnpm test/lint/build, `tsc`, eslint, swiftlint, ktlint, detox, maestro, fastlane scan

The router **observes** checks when the agent runs them; it never runs commands itself.

## Viewing usage and savings

The pane (and `/quality-router usage`) keeps three things separate:

- **A. Observed token usage.** Input, output, cache read and cache write as the API reported them. Broken down by model, by main / subagent / classifier, and by escalated, fallback and review requests. Requests with no reported usage are counted as *unknown*, never as zero. Claude Code's own `/cost` figure is shown separately and labelled.
- **B. "Estimated difference — cache-aware, same output"** (the band's figure). Request by request, what the session cost as it ran, against what it would have cost had every request stayed on the model Claude Code asked for, and (in DRY RUN) had it followed the router's proposals. Each path carries each model's prompt cache from request to request: a switch makes the new model cache the whole conversation, and coming back makes the old one cache it again, and those writes are charged to the path that made them. Output tokens are held equal. Subagents start fresh on any model, so theirs are the same volumes priced on each path. Checked against real sessions: it shows no difference on a session that was never routed, and on the Economy session it lands close to an independent re-pricing (routing cost about $19.5 more by this estimate, $19.8 by the other).
  - The default prices come from https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-09). Each estimate names its source and date.
  - Haiku 5.5's higher price for prompts over 100k tokens is applied per request.
  - Cache writes are priced at the inferred lifetime (`cache-ttl auto`), or at your setting.
  - Negative differences are shown as negative: **Cost more est. $X**.
  - The all-sessions total adds up only sessions recorded this way; older entries, priced the earlier way, are left out and counted.
- **B2. "Estimated pricing difference — same recorded token volumes."** The earlier method, kept for comparison: your recorded volumes priced at each responding model versus all priced at one baseline. It ignores re-caching on switches, so on long conversations it overstates savings and can show a saving where routing cost more.
- **C. Experimental token reduction.** Only from runs you record yourself under matching conditions. Otherwise it says *No comparable baseline*.

Finished phases are tallied as verified, failed or unverified. A phase that failed validation is never presented as a successful optimization.

## Weekly limit projection

When the provider reports plan-limit windows (subscription accounts), the band shows:

```
Weekly 41% · est. limit Thu Oct 15 14:20 · resets Fri Oct 16 09:00
```

- The percentage and reset time are **observed**, exactly as reported.
- No projection until there is enough data: readings spanning 3 hours, or a day into the window. Early in a fresh window it says "not enough data yet" rather than stretching one busy hour over the week.
- The limit time is an **estimate**. For the weekly window it is the window's average pace (percent used over the time since the window began) until the recent readings span 20 hours, because a few busy working hours stretched over nights and weekends fill the week far too early; the recent pace is shown beside it. The 5-hour window uses the trend of the recent readings.
- Readings are kept across sessions, and they already include usage from other sessions, devices and claude.ai.
- The window average assumes a 7-day window ending at the reset time, and it says so.
- If you'd reach the reset first, it shows "not projected to hit before reset". Otherwise it shows "not enough data yet".

It never claims a number of tasks or tokens remaining. `/quality-router limits` shows the basis: method, number of readings, time span and rate.

## Troubleshooting

- **No band:** it only appears on terminal and desktop. Run `/quality-router status`. If the command is unknown, the mod didn't load: run `claude --debug` and look for lines starting `quality-router:`, and check `claude plugin validate <folder>`.
- **Mod loaded but nothing routes:** check the state is `ON` (not DRY RUN), and that the band doesn't show `Manual: … (router paused)`.
- **`⚠ Degraded`:** a routed model didn't answer, or Claude Code fell back to another model on its own. `/quality-router reset-task` clears the set-aside models.
- **Phase keeps the same model:** that's deliberate. A decision stays fixed for a whole phase, and short follow-ups ("yes", "go ahead") continue it. A downgrade is also held while the prompt exceeds 80k tokens, because switching would resend it uncached. Start a new phase with a new prompt or `/quality-router reset-task`.
- **Headless `-p` warns about stdin:** add `< /dev/null`.

## Development

```bash
claude plugin validate ./quality-router
```

```bash
claude plugin test ./quality-router
```

Type-check with any TypeScript 5.4+ against the declaration file Claude Code writes. Once the mod has loaded from a folder you own, that's `.claude-plugin/types/`, and you can run `tsc -p ./quality-router`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the capability table, known limitations and test coverage, and [docs/EVALUATION.md](docs/EVALUATION.md) for a safe evaluation procedure.

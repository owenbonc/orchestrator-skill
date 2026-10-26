---
name: orchestrated-build
description: Owen's workflow for building and changing his projects. Grill him until SPEC.md is agreed, fan out parallel agents in worktrees, verify the real thing, review independently, ship reviewed PRs. Full phases for a new project or phase; change, bug or queue tracks for day-to-day work. Use for any build, feature, refactor or bug fix bigger than a quick edit, or when Owen says "build", "new project", "spec this", "grill me", "delegate to agents", "same workflow as auto-apply". Hackathons and hard demo deadlines: hackathon-build.
---

# Orchestrated build

You are the orchestrator: you own the spec, the contracts, the merges and the final verification. Agents write most of the code; the owner makes the decisions.

## Size the request first

| Request | Track |
|---|---|
| A quick edit or question: one obvious change, no design choice | Just do it. |
| One theme: a feature, a UI pass, a refactor | Change track |
| A bug | Bug track |
| Several independent changes at once | Queue: one session per change |
| A new project, a new phase, or several modules that share new contracts | Phases 0–6: read `phases.md` beside this file |

On a repo that lacks the scripts of `phases.md` Phase 2, do its "Adopting an existing repo" first.

## Skills

They're installed globally: plugins in `~/.claude/settings.json`, user skills in `~/.claude/skills/`. Invoke them with the Skill tool: plugin skills as `plugin:skill` (`mattpocock-skills:grilling`, `mattpocock-skills:diagnosing-bugs`, `ponytail:ponytail`, `ponytail:ponytail-review`, `pstack:poteto-mode` and the other `pstack:` skills, `impeccable:impeccable`), user skills by bare name (`emil-design-eng`, `break-ui`, `thermo-nuclear-code-quality-review`, …). Briefs tell subagents to do the same or, failing that, to read the skill's `SKILL.md` from `~/.claude/skills/<name>/` or the plugin cache under `~/.claude/plugins/`.

| For | Skill |
|---|---|
| Interview | `grilling` (grill-me) |
| All code | `ponytail` (full); pstack's `poteto-mode` principles: `typescript-best-practices`, `tdd`, `principle-model-the-domain`, `principle-boundary-discipline`, `principle-type-system-discipline`, `principle-make-operations-idempotent`, `principle-test-behavior-not-implementation`, `principle-prove-it-works`. Apply the principles; skip Cursor-only orchestration. |
| All UI | `impeccable` (PRODUCT.md, DESIGN.md, craft floor, audit, critique) plus Emil Kowalski's `emil-design-eng`, `pick-ui-library`, `review-animations`, `animate`, `break-ui`. The owner's visual brief is pinned; impeccable's "the brief wins" applies. |
| Bugs | `diagnosing-bugs`, then `tdd` |
| Review | a blind first pass on comment-stripped code (`templates/strip-comments.mjs`), then `thermo-nuclear-code-quality-review`, `ponytail-review` and a spec-conformance pass, and a mutation check of the safety guards; `templates/comment-sicko.md` on each PR and `templates/deslop.md` as the last step of each change (bundled copies of pstack's Comment Sicko and cursor-team-kit's deslop, so they work without those plugins); for UI, impeccable `audit`/`critique`, `review-animations`, `break-ui`. |
| Claude API code | `claude-api`: never guess SDK shapes or model ids |

Briefs always name the essential skills: `ponytail` (full), the pstack principles, `tdd` for logic, `diagnosing-bugs` for bugs. They name the specialist skills (`impeccable` and the Emil Kowalski UI set, `break-ui`, `review-animations`, `claude-api`) only when the task needs them: UI work, Claude API code.

## Quality gates

These never bend for tokens or time. Every efficiency rule below (models, reading, splitting builders, hand-overs, the retro) moves only inside them, and where its condition is unclear it takes the side the priority names (below), the quality side always on safety-critical work.

- SPEC agreed, and every behaviour change written into SPEC, before the code.
- `scripts/verify.sh` prints READY.
- The real thing exercised: the running app, the built artifact on a fixture, and once for real each thing its test harness emulates.
- The combined review's blind pass (in tokens first, on safety-critical pieces only), and the mutation check on safety-critical pieces (Review and merge).
- You read safety-critical diffs yourself.
- Merges only through the merge gate.

## Priority: quality first or tokens first

Owen sets it per request ("quality first", "tokens first") or per project with a `Priority:` line in its AGENTS.md; with neither it is **quality first**. Record it in the resume note so a hand-over keeps it, and name it in each brief. It turns only these dials; the quality gates hold in both, because a cheap build that ships a safety bug saves nothing.

| Dial | Quality first | Tokens first |
|---|---|---|
| A model choice whose condition is unclear (Token budget) | the stronger model | the cheaper one, except on safety-critical work |
| Effort | `medium` for settled, mechanical work; the default otherwise; `high` for Opus on an unsettled safety-critical design | `medium` for all settled work; the default otherwise |
| Builders | parallel where files are disjoint; a fresh fix agent unless the findings are local and mechanical | fewer, run in sequence where their reading overlaps; a builder takes its own fixes while under 50% context, unless one is safety-critical |
| Review of a PR with no safety-critical code | blind pass, then Comment Sicko and `ponytail-review` | one Sonnet pass on the real diff: Comment Sicko and `ponytail-review`, no blind pass (Owen, 26 October 2026) |
| UI polish | impeccable `audit` and `critique`, `review-animations`, `break-ui` | impeccable `audit` |
| End-to-end suite | the full suite each round | the sections a change touches each round, the full suite once before the PR |

Safety-critical work (anything a SPEC non-negotiable rule guards, plus credentials and writes to the owner's systems or accounts) gets the same models, review and mutation check in both, and the retro's asymmetry holds in both.

## Token budget

- **Connectors.** At the start of a coding session, turn off the connectors the work won't use (Gmail, the design plugin's servers, Figma, Chrome) with the ccd_connectors tools: their tools cost tokens on every turn and in every subagent.
- **Choose each agent's model from its task, not its role**: the cheapest model that can do this task right, judged by what a miss would cost. Decide it, and its effort, when you write the brief, and name the condition that decided it in the agent log.

  | Model | When any of these holds |
  |---|---|
  | **Opus** | It writes, fixes or reviews code a SPEC non-negotiable rule guards (approval and press gates, run state, credentials, writes to the owner's systems or accounts). The design isn't settled in its brief: new contracts or architecture, a cross-module change, a platform API nobody has tried here. It redoes work that already failed on a cheaper model (a review blocker in its code, a fix round that left gaps, a builder that couldn't finish). It is the orchestrator. |
  | **Sonnet** (`model: "sonnet"`) | None of the above, and it needs judgment: UI, wiring, routes, tests, docs, a large change whose design the brief settles and whose tests prove it, reviews of anything not safety-critical, mechanical fixes. |
  | **Haiku** (`model: "haiku"`) | It needs no judgment: opening PRs, merging, CI checks, reading logs, a rename the tests prove. |

  - **Effort** follows the same reading: `medium` for settled, mechanical work; the default for the rest; `high` for Opus on an unsettled safety-critical design.
  - **Split to keep Opus small.** A piece with an Opus-worthy core and a large settled bulk is split, so only the core runs on Opus.
  - **Escalate on evidence, never mid-run.** Start each piece at the lowest model these rules allow; a failure moves its next round up one model. Never switch a running agent: it throws away its work.
- **Read what you vouch for; delegate what you only need a fact from.** Read yourself the SPEC text you rewrite, the options you show the owner, safety-critical diffs and the review findings you accept or reject. A fact you only need (where something is defined, what a page's markup holds, whether a route exists) comes from a read-only subagent (`Explore`), and builders get file paths, never your reading of the files.
- **Size each builder before launching it.** Its brief names the exact files to read and to change. When it reaches into more than about two subsystems, or its reading alone would take a large share of its ~250k-token budget, split it at a contract both halves can test on their own (each against a fake of the other side), committing the contract first as their shared base. When correctness depends on one mind holding the whole piece (a state machine and its gate), don't split it: give it one Opus builder with a staged brief (the contract first, then the implementation in commits) and the progress report at the context line.
- **Keep the orchestrator's session for the build.** Answer side questions (status, the roadmap, costs) in a separate short session from the resume note: every orchestrator turn re-reads its whole history, so a question there costs as much as a build step and pushes it toward its hand-over.
- **Finish builders within the cache's hour where the work allows.** A report that lands after the session's prompt cache has expired is read back at full price; size a brief toward a report inside about an hour, but never split a piece that needs one mind (above) for it.
- **Log the spend.** Each agent's model, effort, the condition that chose them, and its tokens (the `subagent_tokens` its completion notice reports) go in the resume note's agent log when it finishes, with what it produced and how many review findings and fix rounds followed.

## Review and merge

Every PR, an agent's into a phase branch or a day-to-day one into main:

- **Combined review, blind pass first.** One fresh subagent, on Opus for safety-critical pieces (anything a SPEC non-negotiable rule guards, plus credentials and writes to the owner's systems or accounts), on Sonnet otherwise. A comment, commit message or report that says what the code does anchors a reviewer on the claim, so it reviews in two passes (in tokens first, a PR with no safety-critical code skips pass 1: one Sonnet reviewer runs pass 2 on the real diff):
  1. **Blind.** Run `node ~/.claude/skills/orchestrated-build/templates/strip-comments.mjs <base> <dir>` in the branch's worktree and give the reviewer that comment-stripped copy of every changed file, SPEC's rules and the contracts, and nothing else: no builder report, brief, commit messages, PR body or your own conclusions. It reads the connected code it needs from the stripped copy or the repo's unchanged files, and writes its correctness and safety findings (by file and symbol, since the copy's line numbers differ) before it opens the real diff.
  2. **Commented.** Comment Sicko (`templates/comment-sicko.md`, the diff, and the project's extra keeps below) and `ponytail-review` on the real diff, checking every comment's claim against what pass 1 found, then pass 1's findings mapped to real file:line.
- **Mutation check** on safety-critical pieces, by the same reviewer after pass 2: for each guard a SPEC non-negotiable rule depends on, break it in the branch's worktree (invert the condition, return early, drop the call), run that guard's tests, and restore the file with `git checkout -- <file>`; it ends with a clean `git status` and commits nothing. A break no test catches is a finding: the missing test is written before merge. The report lists each guard (file:line), the break, and the test that caught it.
- **Judge each Comment Sicko finding yourself.** A comment that admits a workaround gets its root cause fixed, or its constraint encoded as a type, test or lint. Keep SPEC section references (`SPEC §5.5`), safety-rule anchors and ponytail's `shortcut:` comments.
- **Fixes** on an agent's PR go back to its builder via SendMessage only when the findings are local and mechanical and it is under 50% context, the unit every hand-over threshold uses (a token count means a different share of each model's window); otherwise brief a fresh fix agent on top of `common.md`, its model chosen by the rules in Token budget: Opus when any finding it fixes is safety-critical or a fix round on the same piece already left gaps, Sonnet when every finding is mechanical (comment deletions, lint, renames, moves). A round with both splits only if the files are disjoint; otherwise it runs on Opus. On your own change, fix them yourself. Read safety-critical diffs yourself either way.
- **The PR body's `## Review` section** fills one line each: `- deslop:` (from the builder's report or your own pass), `- no-comments:` and `- ponytail-review:` (from the combined review; the ponytail-review line names the blind pass's findings and the mutation check's result).
- **Merge** only with `node scripts/merge-gate.mjs <pr> <owner/repo>` once CI is green, never `gh pr merge` directly.

## Day-to-day work

After the first phase, most work is a stream of single-theme changes. Each gets the lightest track that fits and ends in its own PR into main. Spec first still holds: when behaviour changes, SPEC.md changes in the same PR.

### Change track: one theme

1. Restate the change in a line or two. Ask only the questions whose answers change what you build, each with your recommended answer, all in one round; when there are none, say so and start. Before writing SPEC, show Owen the behaviour in a short summary and get his yes, so his refinements land once in the summary rather than as rewrites of SPEC.
2. Work in a worktree on its own branch, starting with `scripts/agent-setup.sh origin/main`, never in the main checkout.
3. Update SPEC.md first when behaviour changes.
4. Settle visual changes before code: show two or three options side by side (an Artifact, a scratch route or screenshots), let Owen pick, then build the pick, linking the option he picked in every brief that builds it and checking the result against it rather than against a description of it. The PR body carries before and after screenshots; in a private repo, push them to an orphan `pr-shots/<branch>` branch (`git hash-object -w`, `mktree`, `commit-tree`, so no checkout moves) and embed them by that commit's SHA.
5. Test the risky logic, then exercise the real thing.
6. Once `scripts/verify.sh` prints READY, follow `templates/deslop.md` on your diff against main, then run the combined review. Fix what holds up and fill the PR's `## Review` lines.
7. Open the PR and offer Auto-fix; merge through the gate once CI is green.

### Bug track

1. Reproduce it first, with a failing test that shows the bug (`diagnosing-bugs`, then `tdd`). If you can't reproduce it, report what you tried instead of guessing at a fix.
2. Grep every caller, then fix the root cause once, in the shared code.
3. Keep the test as the regression test, then finish with steps 6 and 7 of the change track.

### Queue: several independent changes

- When Owen lists several changes that touch different files, start one session per change, each in its own worktree. Its brief names its files, its track and what done looks like. Changes that touch the same files go one after another in a single session.
- This session keeps the queue in the resume note: each change's session, branch, PR and state.
- **The coordinator hands over too**, after every 3 merges or past 50% context, whichever comes first, from that note: it belongs to no stage, so nothing else makes it hand over, and it is the session most likely to run long.
- Merge in the order the PRs go green. When a later branch conflicts, merge main into it.

### Close each PR with a retro line

After each merge, ask: did anything in this change cost time that a script, hook, lint, test, AGENTS.md line or memory would have saved? If so, make it, as its own PR, or with Owen's OK when it lives outside the repo. (This is `phases.md` Phase 2's "same instruction twice" rule, applied at every merge.)

At the end of each part, also read the agent log (Token budget) and change the model, split and hand-over conditions only on its evidence, asymmetrically, so savings never cost quality:
- **Up on one failure.** A blocker in an agent's code, a fix round that left gaps, or a builder that couldn't finish moves that kind of task up a model or to a finer split.
- **Down only on a record.** A cheaper model, a coarser split or a later hand-over only after two or more parts at that level reviewed clean: no blockers and at most one fix round.

Name the log entries behind each change. Changes to this skill go to `owenbonc/orchestrator-skill` as a PR.

## Pausing and picking up

Long builds outlive one session's usage or context, so treat a hand-over as routine.

- **Keep a resume note current** (`templates/handover.md`) in the scratchpad or the shared notes folder, updated at each milestone: an agent launched or reported, a PR merged, an owner decision. An abrupt stop then loses minutes, not the plan.
- **Hand over at stage boundaries.** In Phases 0–6 (`phases.md`) an orchestrator session covers one stage of a part: **Decide** (grilling, SPEC, briefs), **Build** (launching builders and merging their branches) or **Ship** (review, fixes, PR, merge). It hands over at the end of its stage, and before that at the next milestone once its context passes 50%, because a long session works worse at length, the reason that holds even when usage looks fine, and second because it re-reads its whole history on every turn, which spends the owner's plan (caching makes that cheaper than it sounds). The change, bug and queue tracks have no stages: each runs in one session under the 50% and 70% rules alone (a queue's coordinator also by its own rule in Queue), since splitting a one-file fix into three sessions costs more than it saves. These conditions keep quality first:
  - **Measure it.** Check context with `get_usage` at each resume-note update. It comes from the Claude desktop app's session tools, so the terminal CLI and cloud sessions lack it; there, estimate context from the turn count and the size of what you have read, give the estimate in the status line at each milestone, and lean toward handing over early, since the thresholds do nothing in a session that can't check them.
  - **The note test.** Hand over only when a fresh session could carry on from the note and SPEC alone. When the next step depends on what the note can't hold (a bug half-diagnosed, a design discussion with the owner under way, a question being asked), finish that step, write its result down, then hand over.
  - **Running builders.** Builders are this session's background subagents (`phases.md` Phase 3), so their reports come back only to the session that launched them: while any is running, hand over only once all have reported, or once each one's brief has it write its report to a file the resume note names and the note's In flight table records its worktree and branch. Launching an agent is a milestone for the note, not a point to hand over, or a Build session past 50% would hand over right after launching and its builders' reports would reach no one.
  - **The ceiling.** At 70% context, hand over at once, finishing or backing out of the current step as in Pause safely, but first write what is known into the note's Step in progress: for a bug the repro, the hypotheses ruled out and the current suspect; for a design discussion the options and where Owen was leaning. With builders still running, first have each write its report to a file the note names (SendMessage, as in Pause safely), so the ceiling never strands their work. A partial diagnosis fits in a note only once someone writes it, and backing out without it throws the work away.
  - **When the app can't open a session** (Remote Control shows no card), ask the owner in one line to start one before launching builders; never launch them from a session past 50%.

  The next stage starts in a new session from the note, never in the same conversation.
- **Pause safely** before the limit, not at it, when usage or context runs low or the owner says to stop soon:
  1. Finish the current step or back out of it, and start nothing new.
  2. Ask each running agent to commit its finished work and write a progress section into its report (done, in progress with what's left, not started).
  3. Commit your own uncommitted edits; a broken tree goes in a `wip:` commit that says so in one line. Push nothing new just to pause.
  4. Bring the resume note up to date, then tell the owner where it is and the first step on resume.
- **Pick up** from a note:
  1. Read the note and every file it names.
  2. Rebuild the state from git and GitHub, not memory: `git worktree list`, each branch's log and status, open PRs and their CI.
  3. Take the note's decisions as settled; treat its "done" claims as claims until you check them on the real artifact.
  4. Resume at its next step, and redo nothing that finished.

## Standing rules

- Never code for backwards compatibility. Comments state the current truth only.
- Commit as `Owen Yan <100368790+owenbonc@users.noreply.github.com>` (repo-local `git config`), with no Claude co-author trailers and no "Generated with Claude Code" footers: Owen is the sole credited author. Push with `git -c credential.helper='!gh auth git-credential' push` when plain https auth fails.
- Never commit secrets, `.env`, local data, or personal content (CVs, emails, Notion pages). Fixtures are synthetic or trimmed public data.
- Outward actions (pushing, posting, sending, writing to the owner's Notion or email) need the owner's go-ahead the first time in a project. Say what you'll do before doing it.
- The owner's Notion: use the attached Notion connector (its `notion-*` tools); a second Notion MCP, such as makenotion's plugin, is the same hosted server again. Fetch a database's schema (`notion-fetch`) before writing a row, and use its exact property names and options. An app that reads Notion finds its databases by data source id and its properties by name, so never duplicate a database, rename a property or option, or move a database away from the page its integration is connected to without changing the app with it. Prefer trash (restorable for 30 days) to deletion, and back up before a bulk change.
- Keep the owner posted in short status lines while agents run, and never predict an agent's result before its report arrives.

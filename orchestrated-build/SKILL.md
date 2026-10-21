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
| Review | `thermo-nuclear-code-quality-review`, `ponytail-review` and a spec-conformance pass; `templates/comment-sicko.md` on each PR and `templates/deslop.md` as the last step of each change (bundled copies of pstack's Comment Sicko and cursor-team-kit's deslop, so they work without those plugins); for UI, impeccable `audit`/`critique`, `review-animations`, `break-ui`. |
| Claude API code | `claude-api`: never guess SDK shapes or model ids |

Briefs always name the essential skills: `ponytail` (full), the pstack principles, `tdd` for logic, `diagnosing-bugs` for bugs. They name the specialist skills (`impeccable` and the Emil Kowalski UI set, `break-ui`, `review-animations`, `claude-api`) only when the task needs them: UI work, Claude API code.

## Token budget

- **Connectors.** At the start of a coding session, turn off the connectors the work won't use (Gmail, the design plugin's servers, Figma, Chrome) with the ccd_connectors tools: their tools cost tokens on every turn and in every subagent.
- **Models.** Opus for the orchestrator (which writes the hand-over notes) and safety reviews, Sonnet (`model: "sonnet"`) for builders and the other PR reviews, Haiku (`model: "haiku"`) for mechanical steps: opening PRs, merging, CI checks, reading logs.
- **Effort.** Builders on mechanical tasks (renames, wiring, docs) run at `effort: "medium"`.

## Review and merge

Every PR, an agent's into a phase branch or a day-to-day one into main:

- **Combined review.** One fresh subagent runs Comment Sicko (`templates/comment-sicko.md`, the diff, and the project's extra keeps below) and `ponytail-review`: on Opus for safety-critical pieces (anything a SPEC non-negotiable rule guards, plus credentials and writes to the owner's systems or accounts), on Sonnet otherwise.
- **Judge each Comment Sicko finding yourself.** A comment that admits a workaround gets its root cause fixed, or its constraint encoded as a type, test or lint. Keep SPEC section references (`SPEC §5.5`), safety-rule anchors and ponytail's `shortcut:` comments.
- **Fixes** on an agent's PR go back to its builder via SendMessage only when the findings are local and mechanical and its context is under ~200k tokens; otherwise brief a fresh fix agent on top of `common.md`. On your own change, fix them yourself. Read safety-critical diffs yourself either way.
- **The PR body's `## Review` section** fills one line each: `- deslop:` (from the builder's report or your own pass), `- no-comments:` and `- ponytail-review:` (from the combined review).
- **Merge** only with `node scripts/merge-gate.mjs <pr> <owner/repo>` once CI is green, never `gh pr merge` directly.

## Day-to-day work

After the first phase, most work is a stream of single-theme changes. Each gets the lightest track that fits and ends in its own PR into main. Spec first still holds: when behaviour changes, SPEC.md changes in the same PR.

### Change track: one theme

1. Restate the change in a line or two. Ask only the questions whose answers change what you build, each with your recommended answer; when there are none, say so and start.
2. Work in a worktree on its own branch, starting with `scripts/agent-setup.sh origin/main`, never in the main checkout.
3. Update SPEC.md first when behaviour changes.
4. Settle visual changes before code: show two or three options side by side (an Artifact, a scratch route or screenshots), let Owen pick, then build the pick. The PR body carries before and after screenshots.
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
- Merge in the order the PRs go green. When a later branch conflicts, merge main into it.

### Close each PR with a retro line

After each merge, ask: did anything in this change cost time that a script, hook, lint, test, AGENTS.md line or memory would have saved? If so, make it, as its own PR, or with Owen's OK when it lives outside the repo. (This is `phases.md` Phase 2's "same instruction twice" rule, applied at every merge.)

## Pausing and picking up

Long builds outlive one session's usage or context, so treat a hand-over as routine.

- **Keep a resume note current** (`templates/handover.md`) in the scratchpad or the shared notes folder, updated at each milestone: an agent launched or reported, a PR merged, an owner decision. An abrupt stop then loses minutes, not the plan.
- **A fresh session per part.** After each part ships (its PR merged, the resume note current), the next part starts in a new session from the note, never in the same conversation: a long session re-reads its whole history on every turn, which costs more of the owner's plan than the work does.
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

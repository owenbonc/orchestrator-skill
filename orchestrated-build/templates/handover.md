# <PROJECT> <phase>: resume point (<date, time>)

Read this, then every file it names. Its decisions are settled; its "done" claims are checked on the real artifact before you build on them.

## Standing rules
- `AGENTS.md` and `SPEC.md` §<non-negotiable rules>.
- Project-specific: where the owner's live app runs and what never to touch there; how to push and merge; scratch-server ports; disk or cost limits.

## State
- Phase branch `<branch>` at `<sha>`; merged into it: #<n> <what>, …
- Migrations: <list>.

## In flight
| Work | Worktree | Branch | Brief | Report file (a builder still running writes here) | Last commit, uncommitted files |
|---|---|---|---|---|---|
| | | | | | |

A builder's report as a message reaches only the session that launched it, so hand over while one runs only when its row names the file its brief told it to write. If an agent stopped before finishing: read its report and its worktree's `git log`/`git status`, then start a fresh agent in that worktree with the brief plus "already done: …".

## Step in progress
Only when handing over mid-step (the 70% ceiling): what is known, so backing out loses nothing.
- A bug: the repro, the hypotheses ruled out, the current suspect.
- A design discussion: the options on the table and where Owen was leaning.

## Agent log
| Agent | Task | Model, effort | Condition that chose them | Tokens | Produced | Review findings, fix rounds after |
|---|---|---|---|---|---|---|
| | | | | | | |

## Owner decisions since the spec was agreed
- <decision, in the owner's words where they matter>, written into SPEC? yes/no.
- Open questions waiting on the owner: <numbered, with the recommendation>.

## Next, in order
1. …

Point the next session only at examples you have opened ("do it as PR #n did"): it follows the pointer instead of the rule.

## Known follow-ups
- …

## Where things are
Briefs, reports, scripts, fixtures, the drafted PR body: <paths>.

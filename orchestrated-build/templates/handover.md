# <PROJECT> <phase>: resume point (<date, time>)

Read this, then every file it names. Its decisions are settled; its "done" claims are checked on the real artifact before you build on them.

## Standing rules
- `AGENTS.md` and `SPEC.md` §<non-negotiable rules>.
- Project-specific: where the owner's live app runs and what never to touch there; how to push and merge; scratch-server ports; disk or cost limits.

## State
- Phase branch `<branch>` at `<sha>`; merged into it: #<n> <what>, …
- Migrations: <list>.

## In flight
| Work | Worktree | Branch | Brief / report | Last commit, uncommitted files |
|---|---|---|---|---|
| | | | | |

If an agent stopped before finishing: read its report and its worktree's `git log`/`git status`, then start a fresh agent in that worktree with the brief plus "already done: …".

## Owner decisions since the spec was agreed
- <decision, in the owner's words where they matter>, written into SPEC? yes/no.
- Open questions waiting on the owner: <numbered, with the recommendation>.

## Next, in order
1. …

## Known follow-ups
- …

## Where things are
Briefs, reports, scripts, fixtures, the drafted PR body: <paths>.

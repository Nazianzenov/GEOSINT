# Multi-agent code-review sprint

A scriptable, multi-phase code review for this repo, run with Claude Code. A
top-level **manager** orchestrates **security**, **architect** and **developer**
reviewers that audit independently then cross-critique; agreed findings are
dispatched as **GitHub issues**, implemented by **N parallel implementer** agents
in isolated git worktrees, then verified by an **audit** agent. This is the
formal version of the review loop the project already ran ad-hoc (issue #68).

This is **local tooling, not a CI gate.** The sprint drives `claude -p`, which
needs an `ANTHROPIC_API_KEY` and is not hermetic — so per the repo's CI
doctrine it is **not** wired into `.github/workflows/`. It plugs into the
existing **issues → PR → CI → merge** loop instead: you run it on a branch, it
files the findings as issues, fixes land as ordinary commits/PRs, and the
existing required checks (`tests`, `js-tests`, `lint`, `audit`, `docker-build`)
gate them like any other change.

## What's tracked vs. local

| Path | Tracked? | What |
|---|---|---|
| `.claude/agents/*.md` | yes | the 5 agent roles (shared with the team) |
| `.claude/commands/review-sprint.md` | yes | the `/review-sprint` manager protocol |
| `.claude/README.md` | yes | design rationale + protocol detail |
| `launch-review-sprint.{ps1,sh}` | no (gitignored) | the launcher |
| `install-sprint-kit.{ps1,sh}` | no (gitignored) | installs the kit into another repo |
| `sprints/<date>/` | no (gitignored) | per-run blackboard + reports |
| `../sprint-impl-*/` | no | per-implementer git worktrees (siblings of the repo) |

The agents and command are committed so the whole team gets the same review;
everything operational (scripts, run output, worktrees) stays off the repo.

## Prerequisites

- **Claude Code** on `PATH` (`claude`), authenticated.
- **`gh`** authenticated (`gh auth status`) so iteration 1 can open issues. If
  `gh` is unavailable the backlog is written to `sprints/<date>/issues.md` and
  issue dispatch is skipped.
- Labels used by dispatch: `review-sprint`, `<role>`, `sev:<level>`.

## Run it

```powershell
# Windows
.\launch-review-sprint.ps1                 # review the whole repo, 2 implementers
.\launch-review-sprint.ps1 -Target app -NImpl 3
```
```bash
# macOS / Linux / Git Bash on Windows
./launch-review-sprint.sh .                # or: ./launch-review-sprint.sh app 3
```

The second positional / `-NImpl` is the number of parallel implementer agents
(default 2). Output lands in `sprints/<date>/`; the wrap-up points you at
`sprints/<date>/2-audit.md`.

> **Branch safety:** the launcher never runs on `main` — on `main` (or detached
> HEAD) it auto-creates and checks out `review-sprint/<date>` first (override
> with `-Branch <name>` / `SPRINT_BRANCH=<name>`), because iter-1.5 fixes merge
> back into the launch branch. Land the result as a single squash PR to `main`.

## How a sprint flows

- **Iter 0 — blind audit.** security/architect/developer run in parallel, each
  writing `0-sec.md` / `0-arc.md` / `0-dev.md` without reading the others.
- **Iter 1 — cross-critique + dispatch.** The same three re-run, now reading all
  iter-0 files, each challenging at least one of the others; the manager
  de-dupes, ranks, and opens one labelled GitHub issue per agreed finding.
- **Iter 1.5 — parallel implementation.** The manager partitions the backlog
  into N disjoint buckets, creates one worktree+branch per implementer, and
  spawns N identical `implementer-agent` instances; it merges the branches.
- **Iter 2 — fix audit.** An independent `audit-agent` verifies each fix against
  `git diff`, re-scans for regressions, and writes verdicts to `2-audit.md`.

See [`.claude/README.md`](../.claude/README.md) for the full design rationale
(why the manager runs at top level, why coordination is file-based, and how N
identical agents are spawned safely).

## Tuning

- **Cost:** every agent is `model: opus`. Drop the three reviewers to `sonnet`
  in their frontmatter for cheaper runs; keep the auditor on `opus`.
- **Scope:** pass a subdirectory to review only part of the tree.
- **Permissions:** the launcher uses `--permission-mode acceptEdits` with an
  `--allowedTools` allowlist. For untrusted code, replace `acceptEdits` with a
  confirm-hook and tighten `Bash`.

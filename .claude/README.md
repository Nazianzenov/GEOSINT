# Multi-Agent Code Review Sprint Kit

A scriptable, multi-phase code-review sprint for Claude Code: a top-level
**manager** orchestrates **security**, **architect**, and **developer**
subagents that audit independently and cross-critique; fixes are dispatched as
GitHub issues, implemented by **N parallel implementer** agents in isolated git
worktrees, then verified by an **audit** agent.

## Why it's built this way

Claude Code's primitives impose three constraints that shaped the design:

1. **Subagents can't spawn subagents.** So the manager logic can't live inside
   a subagent — it runs at the **top level** (the `claude -p` session driven by
   the `/review-sprint` command), and the four roles are subagents under it.

2. **Subagents share no memory.** The only parent→subagent channel is the
   prompt string, and there's no agent→agent channel at all. So coordination
   happens through a **shared blackboard folder**, `sprints/<date>/`. Each
   agent reads the others' files from there and writes its own.

3. **Headless mode** (`claude -p`) reuses the same agents/permissions as the
   interactive CLI, so the whole sprint is one scripted command.

## Files

```
.claude/agents/security-agent.md     read-only reviewer (vulns)
.claude/agents/architect-agent.md    read-only reviewer (structure)
.claude/agents/developer-agent.md    read-only reviewer (correctness)
.claude/agents/implementer-agent.md  ONE file, invoked N times in parallel
.claude/agents/audit-agent.md        read-only + git, verifies fixes
.claude/commands/review-sprint.md    the manager protocol (3 iterations)
launch-review-sprint.sh              headless launcher
install-sprint-kit.sh                copies the kit into a target repo
```

## The protocol

- **Iter 0 — blind audit.** Manager spawns sec/arc/dev in parallel; each writes
  `0-sec.md` / `0-arc.md` / `0-dev.md` without reading the others (no anchoring).
- **Iter 1 — cross-critique + dispatch.** Same three agents re-run, now reading
  all iter-0 files. Each must *challenge* at least one of the others' findings,
  resolve overlaps, and write `1-*.md`. Then the manager de-dupes, ranks, and
  opens a GitHub issue per agreed finding (`gh issue create`, labelled + assigned
  by role), logging them to `issues.md`.
- **Iter 1.5 — parallel implementation.** The manager partitions the issue
  backlog into N disjoint buckets, creates one git worktree + branch per
  implementer, and spawns N **identical** `implementer-agent` instances in a
  single turn. Each fixes its bucket in isolation, commits per issue, and
  reports to `impl-<LABEL>.md`. The manager merges the branches.
- **Iter 2 — fix audit.** The independent `audit-agent` checks each issue's fix
  against the code (via `git diff`), re-scans for regressions, challenges prior
  findings, and writes verdicts (`Resolved/Partial/Unresolved/Disputed`) to
  `2-audit.md`.

## Spawning N identical agents from one file

One agent `.md` file = one agent *type*, not one process. You don't get two
copies by editing the file — you get them by having the orchestrator issue
**two `Agent` calls targeting the same agent name in one turn**; Claude Code
runs them concurrently, each in its own fresh context. The implementers are
interchangeable, so the *only* thing keeping them apart is the work assignment
in each one's prompt string (its issue bucket + its worktree/branch). That's
why this kit pairs parallel invocation with **git worktrees**: identical agents
editing one repo simultaneously is the real hazard, and per-instance worktrees
remove it. Set the count with the `n_impl` arg (default 2).

## Usage

```bash
./install-sprint-kit.sh /path/to/your/repo
cd /path/to/your/repo
gh auth status                 # needed for iter-1 issue dispatch
./launch-review-sprint.sh .    # or: ./launch-review-sprint.sh src/ 3
```

The second arg is `n_impl`, the number of parallel implementers (default 2).

Output lands in `sprints/<date>/`.

## Tuning knobs

- **Models:** each agent's frontmatter sets `model: opus`. Drop reviewers to
  `sonnet` for cost, keep the auditor on `opus`.
- **Permissions:** the launcher uses `--permission-mode acceptEdits` and an
  `--allowedTools` allowlist. For untrusted code, replace `acceptEdits` with a
  hook that confirms each `gh`/`git` call, and restrict `Bash`.
- **Scope:** pass a subdirectory to `launch-review-sprint.sh` to review only
  part of a monorepo.
- **Determinism of challenge:** the prompts *require* each agent to register an
  explicit challenge or concur-with-reasons, so cross-critique doesn't collapse
  into rubber-stamping.

## Caveats

- Parallel subagents writing to the same folder is fine because each writes a
  distinct file; never have two agents target one path.
- The manager runs `gh`, so it needs an authenticated `gh` CLI. Without it, the
  backlog is written to `issues.md` and dispatch is skipped.
- Auto-delegation by description is imperfect; this kit invokes agents
  explicitly by name from the command, which is more reliable than relying on
  Claude to pick them.

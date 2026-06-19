---
description: Run a 3-iteration multi-agent code review sprint with cross-critique and GH issue dispatch
argument-hint: date=<YYYY-MM-DD> sprint_dir=<path> target=<repo path> n_impl=<count, default 2>
allowed-tools: Read, Grep, Glob, Write, Edit, Agent, Bash(gh:*), Bash(git:*)
---

You are the **manager-agent**, the top-level orchestrator. Arguments: $ARGUMENTS

You do NOT review code yourself. You dispatch the three role subagents
(security-agent, architect-agent, developer-agent), enforce coordination,
and at iteration 1 you open GitHub issues. Subagents cannot talk to each
other directly — they coordinate ONLY by reading and writing files in
`sprint_dir`. Run the protocol below strictly in order.

---

## Iteration 0 — Independent audits (parallel)

Spawn security-agent, architect-agent, and developer-agent **in parallel**
(one Agent call each, in a single turn). Give each one a prompt that includes:
the target path, the exact output file it must write, and an instruction NOT
to read the other two files yet (this iteration is blind/independent to avoid
anchoring).

- security-agent  -> writes `<sprint_dir>/0-sec.md`
- architect-agent -> writes `<sprint_dir>/0-arc.md`
- developer-agent -> writes `<sprint_dir>/0-dev.md`

Each file must contain findings as a numbered list, every finding tagged with
a stable ID (e.g. SEC-01, ARC-03, DEV-02), severity, file:line, and a proposed
fix. Wait for all three to finish before continuing.

## Iteration 1 — Cross-critique, refine, then dispatch

Spawn the same three agents again, in parallel. Each agent's prompt MUST
instruct it to:
  1. Read its own iter-0 file AND the other two agents' iter-0 files.
  2. CHALLENGE the others: flag findings it disagrees with, finds duplicated,
     mis-scoped, or wrong-severity. Disagreement is required, not optional —
     each agent must register at least one explicit challenge or explicitly
     state it reviewed and concurs with reasons.
  3. Refine its own findings in light of the cross-read, resolving overlaps
     (e.g. a SQL-injection finding is SECURITY's, not DEVELOPER's).
  4. Write the refined set to `<sprint_dir>/1-sec.md` / `1-arc.md` / `1-dev.md`,
     including a "Challenges" section referencing the other agents' IDs.

After all three refined files exist, YOU (manager) do the dispatch:
  - Read the three `1-*.md` files.
  - De-duplicate and rank by severity into a single fix backlog.
  - For each agreed finding, open a GitHub issue:
      gh issue create --title "[<role>] <short>" \
        --body "<finding, file:line, proposed fix, source IDs>" \
        --label "review-sprint,<role>,sev:<level>" \
        --assignee "@me"
    Assign each issue to the relevant role (label encodes owner:
    security findings -> security, structural -> architect, the rest ->
    developer). If `gh` is unavailable, write the same backlog to
    `<sprint_dir>/issues.md` instead and note that dispatch was skipped.
  - Record every created issue (number + role) in `<sprint_dir>/issues.md`.

## Iteration 1.5 — Parallel implementation of fixes

Now spawn **N identical implementer-agent instances** (N = `n_impl` arg,
default 2) to implement the dispatched fixes concurrently. They are the SAME
agent file invoked multiple times — there is no per-instance file. You make
them safe to run in parallel by (a) partitioning work and (b) isolating
worktrees.

Setup before spawning:
  1. Build the ordered fix backlog from the open issues (the `issues.md`
     entries / `gh issue list --label review-sprint`).
  2. Partition the issues into N **disjoint** buckets, balanced by estimated
     effort and severity. Keep issues that touch the same file in the SAME
     bucket to avoid cross-branch conflicts.
  3. Create one git worktree + branch per instance:
        git worktree add ../sprint-impl-A -b sprint/<date>/impl-A
        git worktree add ../sprint-impl-B -b sprint/<date>/impl-B
        ...
     (one per instance, off the current HEAD).

Then, in a SINGLE turn, issue N `Agent` calls all targeting `implementer-agent`.
Each call's prompt MUST contain: the instance label, that instance's worktree
path and branch, its assigned issue bucket (full finding text + file:line +
proposed fix for each), and the sprint dir. The only thing distinguishing the
identical instances is this assignment string.

After all instances finish:
  - Read each `impl-<LABEL>.md` report.
  - Merge the branches back in order (`git merge` / or open PRs with
    `gh pr create`). Resolve any conflicts yourself — implementers never merge.
  - Clean up worktrees: `git worktree remove ../sprint-impl-A` (etc.).
  - Update `issues.md` marking which issues now have commits.

If `n_impl` is 1, run a single implementer over the whole backlog (no
worktrees needed).

## Iteration 2 — Independent audit of the fixes

Spawn the **audit-agent** (single agent). Its prompt MUST include the path to
`issues.md`, all three `1-*.md` files, and the target path. It must:
  - Verify whether each dispatched issue's described fix is actually addressed
    in the current code (re-grep / re-read the cited file:line).
  - Independently re-scan for regressions or newly introduced issues.
  - CHALLENGE the prior agents: note any finding that was wrong, over/under-
    rated, or that the fix did not truly resolve.
  - Write a verdict per issue (Resolved / Partial / Unresolved / Disputed)
    to `<sprint_dir>/2-audit.md`, with an overall sprint summary at the top.

## Wrap-up

Print a short summary: counts of findings per role, issues opened, and the
audit verdict tally. Point the user at `<sprint_dir>/2-audit.md`.

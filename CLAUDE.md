# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

<!-- BEGIN: agentic-code-review -->
## Multi-agent code-review sprint

This repo ships a formal, multi-agent code-review workflow for Claude Code. It
is **local tooling, not a CI gate** (it drives `claude -p`, which is non-hermetic
and needs an API key), and it plugs into the mandated **issues → PR → CI → merge**
loop: run it on a branch, it opens labelled GitHub issues for agreed findings,
and fixes ship as ordinary PRs gated by the existing required checks.

**Run it**
```powershell
.\launch-review-sprint.ps1            # Windows; -Target <path> -NImpl <n>
```
```bash
./launch-review-sprint.sh .           # macOS/Linux/Git Bash; [target] [n_impl]
```
Needs `claude` and an authenticated `gh` on PATH. Output lands in
`sprints/<date>/` (gitignored); read `sprints/<date>/2-audit.md` for the verdict.

**The agents** (`.claude/agents/`, shared with the team):
- `security-agent`, `architect-agent`, `developer-agent` — read-only reviewers
  (vulnerabilities / structure / correctness).
- `implementer-agent` — invoked N times in parallel, one git worktree each, to
  fix dispatched issues.
- `audit-agent` — read-only + git, verifies the fixes at the end.

**The protocol** (`/review-sprint`, in `.claude/commands/review-sprint.md`):
1. *Iter 0* — blind parallel audits → `0-{sec,arc,dev}.md`.
2. *Iter 1* — cross-critique (each must challenge another), then the manager
   de-dupes/ranks and opens one GitHub issue per agreed finding.
3. *Iter 1.5* — partition the backlog into N disjoint buckets and spawn N
   identical implementers in isolated worktrees; manager merges.
4. *Iter 2* — independent audit writes per-issue verdicts to `2-audit.md`.

Launcher scripts and all sprint output are gitignored — keep them out of commits.
Full operator + design docs: [docs/CODE-REVIEW-SPRINT.md](docs/CODE-REVIEW-SPRINT.md)
and [.claude/README.md](.claude/README.md).
<!-- END: agentic-code-review -->

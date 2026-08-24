---
name: kanban-task-coordinator
description: Coordinate agents to execute a dependency-aware task set from a docs/kanban directory, including reviewing tasks, assigning work, collecting changes, verifying results, and handling blockers. Use when asked to execute or coordinate a kanban plan such as docs/kanban/2026-08-04_deep-research-report.
argument-hint: "<docs/kanban/plan-directory>"
---

# Kanban Task Coordinator

Execute an existing kanban plan through specialized delegated agents. Every delegated agent must run on `meta/muse-spark-1.2-contributor`.

## Input

Require a path to one kanban directory, for example:

`docs/kanban/2026-08-04_deep-research-report`

If no directory is provided, ask for it. Do not guess a plan.

## Delegation limit

Coordinate at most **3 delegated tasks in flight at once**. This is a concurrency cap, not a three-task total cap: when a task is reviewed and a slot opens, fill it with the next ready task only if its prerequisites and file ownership are safe and the context remains manageable. Do not start a new dependency wave merely to fill a slot; record it for the next invocation when context or dependencies warrant it.

Rules:

- Count only tasks actually delegated; do not count skipped or already-completed tasks.
- Prefer tasks in dependency order and launch the first ready disjoint tasks together, up to 3.
- **Run independent tasks in parallel whenever possible.** Serialize only for a prerequisite edge or shared file/directory ownership.
- After each result is reviewed, refill an open slot from the current ready wave when safe; never exceed 3 in-flight tasks.
- Stop only when no ready task remains or further delegation would overrun context. Record any ready tasks left for the next invocation.
- Never mark non-delegated tasks as completed. Never block with insufficient evidence.

## Completion markers

Persist completion in the kanban plan by adding this exact block to the task file only after implementation and verification pass:

```markdown
## Coordinator status
- Status: completed
- Completed by: <agent role or coordinator>
- Completed at: <ISO-8601 timestamp>
- Verification: <commands/checks and concise results>
- Commit or artifact reference: <reference, or `working tree`>
```

Treat `Status: completed` as authoritative only when the block is complete and the referenced artifacts still exist. Never mark a task completed merely from an agent's claim. If later changes invalidate the evidence, remove or change the marker and re-open the task. Preserve all existing task content when updating the marker.

## Phase 1 — Inspect and validate

1. Read `AGENTS.md` and the complete target directory.
2. List all `task-*.md` files and sort by numeric task number.
3. Read each task's coordinator status block first. Exclude tasks marked `completed` with valid evidence from delegation, implementation review, and verification; include them in the dependency graph as satisfied prerequisites and report them as skipped/already completed.
4. Validate every task without a valid completion marker contains objective, prerequisites, owner, files/artifacts, implementation steps, contracts, acceptance criteria, verification, reviewer, and out-of-scope sections.
5. Build a dependency graph from each task's prerequisites. Treat missing, cyclic, or ambiguous dependencies as blockers and report them before delegation.
6. Inspect repository status and relevant files before assigning work. Preserve existing uncommitted changes.
7. Group remaining tasks into dependency waves. Only tasks with completed prerequisites may be delegated.

When a task passes review and verification, immediately append or update its completion marker before moving to the next task. On subsequent runs, recheck only the marker's referenced artifacts and any tasks that depend on changed or invalidated work; do not repeat the full task review for valid completed markers.

## Phase 2 — Assign work

For each ready task, choose the narrowest available specialized agent by domain. If no specialized agent fits, use `general`; use `explore` only for read-only investigation. Delegate through the agent tool with this exact model override on every call:

`model: "meta/muse-spark-1.2-contributor"`

> **Configure this:** Replace the model string above with the model you want all delegated agents to use.

The delegation prompt must include:

- the exact task file path and full task requirements;
- completed prerequisite tasks and relevant artifacts;
- allowed files/directories to modify;
- instruction to stop and report blockers rather than guess;
- required verification commands/checks;
- instruction not to broaden scope or overwrite unrelated changes;
- requirement to return changed files, verification results, blockers, and follow-up work.

**Parallel execution is the default.** Identify all ready tasks in the current dependency wave whose allowed file/directory sets are disjoint, and delegate them simultaneously in a single response (multiple agent tool calls in one turn). Reserve sequential delegation for cases where tasks share files/directories or have an explicit dependency edge between them. Never delegate a task with unresolved prerequisites.

## Phase 3 — Review and integrate

Collect results from each parallel agent result as they return:

1. Inspect the reported files and diff for each task.
2. Check acceptance criteria and scope boundaries from each task file.
3. Run relevant formatter, lint, typecheck, build, or focused verification commands for each task. Do not invent commands when none exist; report that verification is unavailable.
4. If incomplete or incorrect, delegate a focused follow-up to the same domain using the same model override.
5. Mark a task complete only after implementation and verification satisfy its acceptance criteria. Keep it blocked in progress when evidence is incomplete.
6. Continue through ready dependency waves until all executable tasks are complete or explicitly blocked, while never exceeding the concurrency limit.

**Concurrency stop:** Never exceed 3 in-flight delegated tasks. After a result is reviewed, a new ready task may replace it in the same run when it is safe and context remains manageable. Stop only when no ready task remains or context would be exceeded; list any next ready task(s) for the next invocation.

Use a durable task ledger only when persistence, dependency edges, or ownership tracking is needed. If used, record blockers instead of falsely completing work.

## Safety and scope rules

- Never delegate with another model; the required execution model is always the one specified in Phase 2.
- Never create arbitrary shell execution, bypass authentication, weaken permissions, or ignore task acceptance criteria.
- Never overwrite unfamiliar user changes, delete files, reset branches, commit, push, or alter shared infrastructure without explicit approval.
- Preserve the original plan's exclusions. If a missing requirement is discovered, stop the affected task and create a clearly reported follow-up instead of silently expanding scope.
- Do not claim completion based solely on an agent's message; inspect the repository and verify it.

## Completion report

Return a concise report containing:

- plan directory and task count;
- **invocation info:** how many tasks were delegated and reviewed, peak in-flight count (max 3), and how many ran in parallel vs sequential;
- completed tasks and delegated agent roles;
- blocked/skipped tasks with exact reasons;
- files changed;
- verification commands and results;
- remaining risks, review approvals, and follow-up tasks;
- **next batch:** list the next 1-3 ready task IDs to run on the next invocation, or state that the plan is fully complete.
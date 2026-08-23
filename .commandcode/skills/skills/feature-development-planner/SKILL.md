---
name: feature-development-planner
description: Research repository structure and requirements, then create a complete feature development plan in docs/plans. If invoked without arguments, automatically researches the repo and proposes new features for the user to choose from. Supports explicit feature requests and exploratory research.
argument-hint: "[feature or requirement — leave empty to auto-research and propose new features]"
---

# Feature Development Planner

Create an implementation-ready plan without changing source code. Supports two modes: (a) planned feature with explicit requirements, (b) exploratory research to propose new features. **Default invocation (no arguments) automatically enters exploratory research.**

## Workflow

1. Read `AGENTS.md`, the relevant `README`, package/module manifests, existing plans, and repository structure.
2. Determine mode — **if no argument is given, default to exploratory research automatically (do not ask for clarification, do not wait for extra input):**
   - **Default / Exploratory (no args, empty prompt, or phrases like `research new features`):** Analyze repository structure, existing features, user flows, TODOs/open issues, domain gaps, and competitor/common patterns for this project type. Enumerate 3-5 candidate features ranked by user value and implementation cost, then select the top proposal with clear rationale. Document rejected candidates briefly.
   - **Explicit feature:** Search for related features, interfaces, conventions, deployment files, and documentation before proposing files or APIs.
3. Extract requirements from the prompt and repository evidence. For default/exploratory mode, derive requirements from the ranked candidates and repo evidence. Record explicit assumptions for details that are not specified.
4. Choose the smallest architecture that fits existing patterns. Preserve project constraints such as language, framework, deployment model, auth model, and data-storage choices already present in the codebase.
5. Write an English Markdown plan under `docs/plans/` using a descriptive lowercase-hyphenated filename. Include the current date when the repository convention uses dates. For default invocation, include the ranked candidates and a recommendation in one plan; ask for a choice only when interactive selection is explicitly requested.

## Required plan content

- Goal and non-goals.
- Current-state findings and relevant files. For default/exploratory mode, also include research summary: existing feature inventory, candidate features considered (ranked 3-5), selection rationale, and rejected candidates.
- Proposed architecture and data/control flow.
- Exact files or directories to create and modify.
- Interfaces, schemas, routes, commands, and configuration contracts.
- Ordered implementation tasks with dependencies and parallelization notes.
- Acceptance criteria and verification commands/checks.
- Security, compatibility, migration, and operational considerations.
- Risks, unresolved assumptions, and reviewer ownership.

## Rules

- Do not implement code, modify existing source, or create kanban tasks while creating the plan.
- Do not invent APIs, commands, dependencies, or test commands without labeling them as decisions to validate.
- Prefer existing project patterns over new abstractions.
- Keep scope lean and explicitly exclude unrelated infrastructure.
- Explicitly exclude CI/CD, unit tests, testing infrastructure, and monitoring/observability (Grafana/Prometheus/logging platforms, alerting) unless the user explicitly requests them. Do not add pipeline files, test scaffolding, or dashboards to the plan.
- If the project has specific CLI commands or sub-systems that are out of scope, respect those boundaries. Document them in the plan's non-goals.
- **Default behavior:** When invoked without arguments, immediately research the repository and write the ranked proposal; do not pause for clarification or selection unless explicitly requested.
- If requirements are materially ambiguous in explicit mode, ask focused questions; otherwise proceed with documented assumptions.
- After writing, reread the plan and check that every requirement maps to a task and acceptance criterion.

## Completion report

State the plan path, key decisions, assumptions, dependencies, and any questions that must be answered before implementation. For default invocation, also list the candidate features proposed and how the user can select one to proceed.
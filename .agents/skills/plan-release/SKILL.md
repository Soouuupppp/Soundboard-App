---
name: plan-release
description: Research and plan the tasks for the current in-progress version release. Use when the user wants to plan, scope, design, or break down the work for the latest version's tasks (e.g. "plan the release", "plan 1.3.3", "scope out the tasks", "research the new version tasks", "let's plan the work"). Reads the newest task section from AGENTS.md, asks detailed clarifying questions until requirements are certain, researches the codebase + external sources, then writes an implementation plan.
---

# Plan a release's tasks

Turn the rough task list for the current version into a researched, locked,
implementation-ready plan. This skill is the step **between** `prep-release`
(which records the version + bullet goals) and actually writing code.

Work through the phases in order. **Do not start researching or planning until
the clarifying questions are answered** — the whole point is to be ~99% sure of
the requirements first.

## Phase 1 — Pick up the version + tasks

Read `AGENTS.md` and locate the **newest** `### Tasks — X.Y.Z (…)` section
(the last one before the "When you start a fresh batch of work" footer). That
section's version, title, and numbered tasks (each with a `Progress` field) are
your scope. Confirm to the user which version + tasks you picked up so there's no
ambiguity about what's being planned.

If the section is missing or every task is already `✅ Done`, tell the user and
stop — there's nothing to plan (suggest `prep-release` first).

## Phase 2 — Ask detailed clarifying questions (be ~99% sure)

For **each** task, surface the real decisions before committing to a design. Use
the `AskUserQuestion` tool, grouped logically (don't dump 20 questions at once —
batch by task, lead with the highest-leverage ambiguities). Aim to eliminate
genuine uncertainty, not to quiz the user on things you can settle yourself.

Good questions probe, e.g.:
- **Scope boundaries** — what's explicitly in vs out for this version.
- **Storage / persistence scope** — per-entry (DB) vs device-local (localStorage)
  vs global (`appSettings`)? Match the repo's existing patterns and name them.
- **UI placement + behavior** — exactly where a control lives, default state,
  edge cases (e.g. does cancel-all interrupt a pending delayed play?).
- **Interaction with existing systems** — keybinds, VR binds, the audio engine,
  CSP, the Saved/Board split, quotas, etc.
- **Defaults + validation bounds.**

Record every answer the user gives as a **locked decision** — you'll write these
into the plan and back into AGENTS.md. Don't move on while a material requirement
is still unknown; ask a follow-up round if needed.

## Phase 3 — Research

Only after requirements are locked:

1. **Codebase research** — find the exact files, functions, and patterns each
   task touches. Lean on the `## lib/ map`, the **Key concepts** sections, and the
   memory pointers in `AGENTS.md`. Use Grep/Glob/Read (or the `Explore` agent for
   broad fan-out). For every task, identify: the entry points, the data model
   changes (remember: schema edits go in **both** `src/db/schema.ts` **and**
   `bootstrap.sql` — see the `db-schema-via-bootstrap-sql` memory), and any
   cross-cutting concerns (CSP/`middleware.ts`, the Electron bridge, etc.).
2. **External research** — when a task needs an unfamiliar library, API, font,
   browser behavior, or best practice, use `WebSearch`/`WebFetch` to confirm the
   approach (e.g. how `next/font/google` self-hosts a font, debounce/delay
   semantics, etc.). Prefer official docs. Note version-specific gotchas.
3. Check the auto-memory for settled decisions before reopening anything
   (`virtual-mic-capture`, `ver-1-3-0-scope`, `db-schema-via-bootstrap-sql`).

## Phase 4 — Write the plan

Produce a concrete implementation plan. For **each** task include:
- **Goal** (one line) + the **locked decisions** from Phase 2.
- **Files to touch** (real paths) and what changes in each.
- **Approach** — the step-by-step implementation, ordered; call out schema
  changes, new components/libs, and any migration/`bootstrap.sql` work.
- **Risks / edge cases** and how the plan handles them.
- **Verification** — how to confirm it works (`tsc --noEmit` is fine; **do not**
  run `pnpm lint`; manual check steps where relevant).

Order the tasks for the build cycle (shared primitives first, churny/global
changes last), mirroring how prior versions sequenced their task lists.

Then **persist the locked decisions** back into the version's AGENTS.md task
section: under each numbered task, fold the clarified requirements into the task
description and mark design decisions **locked** inline (matching the existing
"Owner decisions below are **locked**" convention). Leave each `Progress` field
as-is (`Not started`) — planning doesn't start the work.

Finally, present the plan to the user for sign-off. If running in plan mode, use
`ExitPlanMode` to surface it. Do **not** begin implementing until the user
approves.

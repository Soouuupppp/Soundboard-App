---
name: dev-release
description: Implement the current version's planned tasks autonomously, one at a time, via a self-paced loop. Use when the user wants to build/develop/execute the release tasks (e.g. "dev the release", "implement the tasks", "build out 1.3.3", "run the release loop", "start coding the planned tasks"). Reads the newest task section from AGENTS.md and launches a /loop that codes each task in turn, reports after each, runs tsc at the end, and finishes with a code + security + optimization review. Never builds, migrates, or touches git.
---

# Dev a release (autonomous task loop)

This is the **third** stage of the release pipeline, after `prep-release` (records
the version + tasks) and `plan-release` (locks the design + folds decisions into
AGENTS.md). `dev-release` actually implements those tasks.

It works by launching a **self-paced `/loop`** (no fixed interval — the model
advances itself task by task). Your job when this skill runs is to **assemble the
loop prompt** — filling in the live task list + project context — and then start
the loop. Do **not** implement the tasks directly in this turn; hand them to the
loop.

## Step 1 — Read the current tasks

Open `AGENTS.md` and find the **newest** `### Tasks — X.Y.Z (…)` section (the
last one before the "When you start a fresh batch of work" footer). Collect every
numbered task and its `Progress` field. The loop will work the tasks that are
**not** already `✅ Done`, in order.

If there is no such section, or every task is `✅ Done`, tell the user there's
nothing to build (suggest `prep-release` / `plan-release` first) and stop without
launching a loop.

## Step 2 — Launch the loop

Invoke the **`/loop`** skill with **no interval** (self-paced) and the prompt
below. Fill the `{{…}}` placeholders from Step 1 and from `AGENTS.md` before
launching — the running loop must not have to re-derive them.

```
/loop You are implementing the planned tasks for version {{VERSION}}
({{VERSION_TITLE}}) of the Soundboard project, ONE TASK PER ITERATION.

## The tasks (work the non-Done ones, top to bottom)
{{NUMBERED_TASK_LIST_WITH_LOCKED_DECISIONS_AND_PROGRESS}}

## Each iteration
1. Pick the FIRST task whose Progress is not "✅ Done". If all are Done, go to
   "When every task is done" below.
2. Set that task's Progress to "In progress" in AGENTS.md, implement it fully per
   its LOCKED decisions, then set Progress to "✅ Done" with a short parenthetical
   note describing what you actually did (match the style of the already-shipped
   task sections in AGENTS.md).
3. Run `tsc --noEmit` (via `pnpm --filter web exec tsc --noEmit`, or the repo's
   typecheck) and fix any type errors your change introduced.
4. Reply with a SHORT report for that task: what was implemented (key files),
   any issues hit, and any further work / follow-ups needed. Keep it tight.
5. Continue the loop to the next task.

## Hard constraints (do NOT violate)
- NEVER run a production/dev build (`pnpm build`, `next build`, electron `dist`/
  `bake`/`release`), and NEVER run the native vr-bridge build.
- NEVER run migration / db scripts (`pnpm db:migrate`, `db:generate`, `db:push`,
  migrate.ts, bootstrap.sql application). If a task needs a schema change, EDIT
  both `web/src/db/schema.ts` AND `web/src/db/bootstrap.sql` (CREATE block +
  `ADD COLUMN IF NOT EXISTS` backfill) but do NOT apply them — the user runs the
  DB themselves.
- NEVER run `pnpm lint` / eslint (repo convention) — typecheck only.
- NEVER do any git action (no add/commit/branch/push/tag/stash). Leave the
  working tree dirty for the user.
- The USER builds, runs, migrates, and TESTS everything themselves. Your job is
  to write the code and typecheck it — not to verify it at runtime.
- `tsc --noEmit` is the ONLY command you run to validate. It is allowed.

## When every task is done
Run a general review pass over everything you changed this session and post it as
a final report with three sections:
1. **Code review** — correctness bugs, dead code, missed edge cases, anything not
   matching the locked decisions or the repo's conventions.
2. **Security review** — focus on this project's known surfaces: the CSP + nonce
   in `web/src/middleware.ts`, the CSRF/Origin check + the multipart upload
   `Content-Length` guard, path-traversal safety in `lib/storage.ts`, auth/role/
   quota resolution, the Electron remote-renderer permission handlers, and the
   `bootstrap.sql`/`schema.ts` parity for any schema change.
3. **Optimization review** — render/`useMemo`/`useCallback` churn in the big
   client components (Dashboard.tsx), audio-graph lifecycle, unnecessary
   re-fetches, and any obvious algorithmic or bundle wins.
Report findings only — do NOT auto-apply fixes unless the user asks. Then END the
loop (stop scheduling further iterations).

## Project context you need
- Monorepo (pnpm 9.12.3): `web/` (Next.js 15 App Router, TS, Tailwind, Auth.js v5
  Discord, Drizzle + Postgres, Zod) and `electron/` (Win-only wrapper + C++ OpenVR
  vr-bridge). Versions kept in lockstep across the three package.json files.
- Schema is applied via `web/src/db/bootstrap.sql` (idempotent DDL run at
  container boot), NOT drizzle migrations — change BOTH it and `schema.ts`.
- CSP + per-request nonce + CSRF live in `web/src/middleware.ts` (not
  next.config). Static security headers are in next.config.ts.
- Audio engine: `lib/audio-mixer.ts` + `lib/audio-output.ts`, hoisted into a
  global `components/AudioProvider.tsx` so it survives route changes.
- Bind models: `lib/chord.ts` (keyboard set/chord) and `lib/vr-bind.ts` (VR
  step/sequence matcher). VR binds store a per-profile map {index,quest}.
- Key UI: `components/Dashboard.tsx` (the single page + SoundCard + VrBindPicker),
  `components/AdminPanel.tsx`, shared dark `components/Select.tsx`, toasts in
  `components/Toast.tsx`.
- Conventions: match the concise comment-the-why style; keep the ASCII signal-flow
  diagrams in the audio files accurate; consult the auto-memory before reopening
  settled decisions (virtual-mic-capture, db-schema-via-bootstrap-sql).
- Read the relevant AGENTS.md sections for each task's subsystem before editing.
```

## Notes
- Because the loop is self-paced, it advances on its own; the user can interrupt
  at any time. Keep the per-task reports short so the transcript stays readable.
- If a task is genuinely blocked (missing a decision the plan didn't lock), the
  loop should pause and ask the user rather than guess — but `plan-release`
  should have prevented this.

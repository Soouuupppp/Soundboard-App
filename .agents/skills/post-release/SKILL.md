---
name: post-release
description: Final pre-merge review of an implemented release — verifies version lockstep across configs/READMEs/docs/AGENTS.md, sanity-checks the diff and the task section, fixes mechanical issues (or consults the user on anything ambiguous), then drafts the four release artifacts for the user: the commit message, the PR title/description, a Discord announcement, and the GitHub Release page notes. Use when the user wants to wrap up, finalize, review, or ship a release (e.g. "post-release", "final review", "wrap up 1.3.3", "review before merge", "write the commit/PR/Discord/release notes"). Does NOT commit, push, tag, build, migrate, lint, post, or send.
---

# Post-release review

The **fourth and final** stage of the release pipeline, after `prep-release`
(records the version + tasks), `plan-release` (locks the design), and
`dev-release` (implements the tasks). This skill is the pre-merge gate: confirm
the implemented release is internally consistent — code, versioning, and docs —
fix what's mechanical, surface what isn't, then hand the user ready-to-paste
text for the four release artifacts: the **commit message**, the **PR**, a
**Discord announcement**, and the **GitHub Release page notes**.

Work the phases in order. This skill **never** commits, pushes, tags, builds,
migrates, or lints (repo conventions) — it reviews, optionally fixes the working
tree, and writes text for the user.

## Phase 1 — Establish scope

1. Read `AGENTS.md` and locate the **newest** `### Tasks — X.Y.Z (…)` section
   (the last one before the "When you start a fresh batch of work" footer). That
   version (`X.Y.Z`) and its numbered tasks are the release under review.
2. Note the branch (`git branch --show-current` — releases live on `ver/X.Y.Z`)
   and gather the changes:
   - `git status --short` — uncommitted working tree.
   - `git diff --stat master...HEAD` and `git diff master...HEAD` — what this
     branch changes vs the merge target (`master`).
   Review **both** committed-on-branch and uncommitted changes; a release may be
   either staged as commits or sitting dirty in the tree.
3. Confirm to the user which version + branch you picked up. If there is no task
   section, or the changes are empty, say so and stop.

## Phase 2 — Version lockstep audit (the core check)

The version string must match in **every** place the repo tracks it. Find the
current version, then verify it is identical across all of these:

- `package.json` → `"version"`
- `web/package.json` → `"version"`
- `electron/package.json` → `"version"`
- `AGENTS.md` → the lockstep line in the **Stack** section ("Versions across all
  three `package.json` files are kept in lockstep (currently **X.Y.Z**).")
- `electron/README.md` → the example artifact filenames
  (`Soundboard-Setup-X.Y.Z-x64.exe`, `Soundboard-X.Y.Z-x64-portable.exe`)
- `README.md` → any version mention, if present
- The branch name (`ver/X.Y.Z`) should match too — flag a mismatch, don't rename.

Then sweep for stragglers — any **older** version string left behind in a config
or doc:

```
git grep -n "<OLD_VERSION>" -- "*.json" "*.md" ":!node_modules" ":!pnpm-lock.yaml"
```

(Ignore `pnpm-lock.yaml` and `node_modules`.) A hit in AGENTS.md's prior shipped
sections (e.g. "1.3.1 shipped") is expected history — leave it. A hit in a
*current* config, README header, or the lockstep line is a bug — fix it.

## Phase 3 — Docs + task-section review

- **Task section completeness:** in the newest `### Tasks — X.Y.Z` section, every
  numbered task's `Progress` should read `✅ Done` with a short parenthetical of
  what actually shipped (the repo convention). Flag any task still `Not started` /
  `In progress` — the release isn't done, so tell the user rather than papering
  over it.
- **Shipped summary:** prior versions each got a "**X.Y.Z shipped**" recap
  paragraph under the **Project status** heading. If this version has tasks done
  but no recap, draft one in the same style (feature-complete summary + any
  pre-release hardening), matching the existing entries.
- **Docs reflect the work:** skim `AGENTS.md`'s Key-concepts/lib-map sections and
  the READMEs for anything the release made stale or newly true — new components,
  renamed files, changed behavior, new env vars, schema columns. The `dev-release`
  loop should have kept these current; verify, don't assume.

## Phase 4 — Light code-change review

A final correctness/consistency pass over the diff — not a full audit (that was
`dev-release`'s closing review), but a last look for things that would embarrass
a merge. Focus on this project's known surfaces:

- **Schema parity:** any schema change touches **both** `web/src/db/schema.ts`
  **and** `web/src/db/bootstrap.sql` (CREATE block + `ADD COLUMN IF NOT EXISTS`
  backfill). A change to one but not the other is a bug.
- **Security surfaces:** CSP + nonce + CSRF in `web/src/middleware.ts`; the
  multipart upload `Content-Length` guard; path-traversal safety in
  `lib/storage.ts`; auth/role/quota resolution; the Electron remote-renderer
  permission handlers.
- **Stragglers:** leftover debug logging, commented-out code, `TODO`/`FIXME`
  introduced by the release, dead exports, files staged by accident.
- **Convention drift:** the concise comment-the-why style; accurate ASCII
  signal-flow diagrams in the audio files if routing changed.

## Phase 5 — Fix, or consult

- **Fix directly** anything mechanical and unambiguous: version mismatches, a
  missing `✅ Done`, a stale README line, an absent shipped-summary paragraph, a
  forgotten `bootstrap.sql` backfill, leftover debug logging.
- **Consult the user** (prefer `AskUserQuestion` for crisp choices) for anything
  that changes behavior or design, contradicts a locked decision, or is a real bug
  needing a judgment call — don't silently rewrite the release's intent. Present
  the finding, your recommendation, and let the user decide.

After fixing, re-run the Phase 2 grep to confirm the tree is clean. `tsc --noEmit`
(`pnpm --filter web exec tsc --noEmit`) is fine if you touched code; **do not** run
`pnpm lint`.

## Phase 6 — Write the release artifacts

Produce **four** ready-to-paste blocks, each in its own fenced code block. Derive
the highlights from the newest task section's shipped tasks, and **pitch each to
its audience** — the commit/PR are for developers; the Discord + release-page
messages are for end users (no internal file names, no jargon, no "the matcher
now…").

The skill **drafts** all four — it does **not** post or send anything. There is no
Discord webhook in the repo, and the GitHub Release is cut by CI
(`.github/workflows/electron-release.yml`) on a push of `electron/package.json` to
`master`. So hand the text over for the user to paste; only post/send if the user
explicitly asks in a later turn (and only via a webhook/`gh` they point you at).

1. **Commit message** — match the repo's existing style (check `git log`): a
   Conventional-Commit subject scoped with the version,
   `feat(X.Y.Z): <comma-separated highlights>`, then a body with a short bullet
   list of the notable changes grouped by area.

2. **PR** — title (the one-line highlight summary) and a description with: a
   one-paragraph overview, a grouped bullet list of what changed (by subsystem /
   task), any schema/migration notes (remind the user `bootstrap.sql` applies on
   container boot), and a short test/verification checklist.

3. **Discord announcement** — a short community post for the project's Discord.
   Lead with the version + a one-line headline, then 3–5 **user-facing** highlight
   bullets (what changed for them, not how it's built). Close with the links: the
   web app (`https://soundboard.soouuupppp.com`) and the Windows desktop download
   (`https://github.com/Soouuupppp/Soundboard-App/releases/latest`). Friendly and
   skimmable; light emoji is fine. No file names, no commit-speak.

4. **GitHub Release page notes** — the **body** for the `v<X.Y.Z>` release (tag
   `v<X.Y.Z>`; the workflow already auto-sets the *title* to `Soundboard X.Y.Z`,
   so don't write a title). Audience = **Windows desktop-app users** the
   auto-updater serves. A "What's new" list of user-facing changes, then a short
   update/install note (installed clients auto-update on next launch; portable
   `.exe` builds don't — grab the new one). Mention the two artifacts when
   relevant (the NSIS `Soundboard-Setup-X.Y.Z-x64.exe` installer + the
   `Soundboard-X.Y.Z-x64-portable.exe`).

**Hard rule — no self-attribution (applies to all four).** The user ships these
under their own name. Do **NOT** add any AI/Codex authorship anywhere: no
`Co-Authored-By: Codex …` trailer, no "🤖 Generated with Codex", no
"Generated with", no mention of an assistant or that the text was AI-written. This
**overrides** the default git-commit/PR trailer conventions. Write it all as the
user's own words.

Output all four blocks in the chat (fenced for easy copy). Do **not** run
`git commit`, `git push`, `gh pr create`, `gh release …`, tag anything, or hit any
webhook unless the user explicitly asks in a later turn — this skill stops at
handing over the text.

## Notes

- This skill is read-and-write-the-tree only: it may edit docs/configs/code to fix
  issues, but it performs **no** git, build, migration, or lint actions.
- If the release looks incomplete (tasks not Done, empty diff), report that and
  stop rather than manufacturing a commit for unfinished work.

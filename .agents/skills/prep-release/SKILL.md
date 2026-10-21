---
name: prep-release
description: Prepare a new version release for the soundboard. Use when the user wants to cut, prep, start, or bump a new release/version (e.g. "prep release", "new version", "bump to 1.4.0", "start a release"). Collects the version + goals, creates the local `ver/X.Y.Z` branch off master, adds a version section to AGENTS.md, and bumps the version across all package.json files and READMEs.
---

# Prep a new release

Drive the repo through the mechanical prep for a new version. Follow the steps in
order. Do not skip the two questions — the user's answers drive everything else.

## Step 1 — Ask for the version number

Ask the user what version number this release is (e.g. `1.4.0`). Find the current
version first so you can suggest the next one and validate the bump:

- It lives in three files, kept in lockstep: `package.json`, `web/package.json`,
  `electron/package.json` (the `"version"` field).

Confirm the new version is greater than the current one. Keep all three in sync.

## Step 2 — Ask for the description + goals

Ask the user for:
- A short **title** for this version (e.g. "persistent audio engine + local previews").
- The **goals / scope** — the features and fixes this release will contain.

If the user already gave these in their request, don't re-ask — just confirm.

## Step 3 — Clarify until you understand the goals

Before writing anything to `AGENTS.md`, ask follow-up clarifying questions about
the version's goals/tasks until you are **99% sure** you understand exactly what
the user wants. Don't stop at the first round of answers — keep probing any task
that is vague, ambiguous, or under-specified.

For each goal, pin down things like:
- The exact scope (what's in, what's explicitly out for this version).
- Concrete behavior / acceptance criteria — what "done" looks like.
- Any owner decisions that should be recorded as **locked** (UI choices, storage
  location, defaults, edge cases).
- Dependencies or ordering between tasks.

Prefer the `AskUserQuestion` tool for crisp either/or decisions, and plain
follow-up questions for open-ended ones. Only move on once nothing material is
still ambiguous — the answers here become the locked task section in the next
step, so getting them right matters more than getting through quickly.

## Step 4 — Create the release branch (off master, local only)

Cut the version's working branch from **master** so every edit below lands on it.
This is what keeps the branch descending from the *latest* master rather than a
prior release branch (a stale base makes the eventual PR land behind master).

1. Check the working tree is clean (`git status --short`). If it isn't, stop and
   ask the user to commit/stash first — this skill won't drag stray changes onto
   the new branch.
2. Refresh `master` so the branch is cut from the latest commit, not a stale
   local copy. Always run:

   ```
   git fetch origin
   ```

   Then confirm local `master` is up to date with `origin/master` (e.g.
   `git rev-list --left-right --count master...origin/master` — both sides `0`).
   If local `master` is behind, fast-forward it (`git checkout master &&
   git merge --ff-only origin/master`) before cutting the branch, or base the new
   branch directly on `origin/master` in the next step.
3. Create **and** switch to the branch in one step, based explicitly on the latest
   master (regardless of which branch is currently checked out):

   ```
   git checkout -b ver/<NEW_VERSION> origin/master
   ```

   (Use `master` instead of `origin/master` only if there's no remote / you're
   working offline.)

   - Branch name is exactly `ver/X.Y.Z` (e.g. `ver/1.3.3`).
   - If a branch with that name already exists, **stop and ask the user** — do not
     overwrite or reuse it blindly.
   - **Do NOT push, publish, or set an upstream** (`-u`). The branch stays local;
     the user pushes it themselves when they're ready.

Do the remaining steps on this branch.

## Step 5 — Add a version section to AGENTS.md

Edit `AGENTS.md`:

1. Update the lockstep line near the top of the **Stack** section ("Versions
   across all three `package.json` files are kept in lockstep (currently
   **X.Y.Z**).") to the new version.
2. Add a new task section under the existing `### Tasks — …` sections, following
   the established pattern exactly:

   ```markdown
   ### Tasks — <NEW_VERSION> (<title>)

   Version bumped to **<NEW_VERSION>** across all three `package.json` + docs.
   Owner decisions below are **locked**.

   1. **<Task name>** — <description>.
      **Progress: Not started**
   2. ...
   ```

   Use one numbered task per goal the user listed, each with a `**Progress: Not
   started**` field (the repo convention is `Not started` → `In progress` →
   `✅ Done`). Record any design decisions the user states as **locked** inline.

   Leave the prior version's shipped section intact — append, don't overwrite.

## Step 6 — Bump versions across packages + READMEs

Update the version string everywhere it appears:

- `package.json` → `"version"`
- `web/package.json` → `"version"`
- `electron/package.json` → `"version"`
- `electron/README.md` → the example artifact filenames
  (`Soundboard-Setup-<VERSION>-x64.exe`, `Soundboard-<VERSION>-x64-portable.exe`)
- `README.md` → any version mention, if present

Search for the old version string to catch any spot this list misses:

```
git grep -n "<OLD_VERSION>" -- "*.json" "*.md" ":!node_modules"
```

(Skip `pnpm-lock.yaml` and `node_modules`.)

## Step 7 — Summarize

Report what changed: the new `ver/X.Y.Z` branch (created locally off master, not
pushed), the files bumped, and the new AGENTS.md section. Do **not** commit, tag,
or push unless the user explicitly asks — just prep the working tree on the new
branch. Do **not** run `pnpm lint` (repo convention); `tsc --noEmit` is fine if a
sanity check is wanted.

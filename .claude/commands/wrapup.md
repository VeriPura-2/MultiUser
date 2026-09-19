---
description: Wrap up a VeriPura platform session or numbered step. Updates the memory, verifies, commits, pushes.
---

# Wrap up

Run this when you finish a numbered step or stop for the day. Its job is to make sure that the
next session, which will know nothing of this one, can pick up exactly where this one left off.
The project memory is only useful if it is true, so this command updates it and then checks it.

## Steps

1. **See what changed.** Run `git status --short` and `git diff --stat`, and read the last entry of
   `docs/build-log.md`, so you know what has happened since the memory was last updated.

2. **Append to `docs/build-log.md`.** Append only, never edit earlier lines (the git hook blocks it).
   Use the heading `## YYYY-MM-DD, <what this was>` and cover: what was built; every decision the
   specification did not settle, and why; defects found and fixed; how it was verified; anything
   left open. The decisions and open items are the valuable part.

3. **Update `docs/PROJECT_MEMORY.md`.**
   - `Last updated:` to today's date, `Tests passing:` to the real number, `Stages complete:` if it changed.
   - Add or adjust the History row. Use hashes that exist (`git cat-file -e <hash>`); never copy a
     hash from an old note, history has been rewritten before.
   - Update Open items: add new ones, remove ones that are closed, and check each against the code
     rather than against memory of it.
   - Update Next work, Gotchas, and the Map if they changed.
   - Keep the file under 250 lines, put detail in the build log, and use no em dashes.

4. **Verify.** Run `npm run typecheck`, then `npm run memory:check -- --full`, which runs the whole
   suite and checks that the stated test count is the real one. Fix anything it reports and run it
   again. A failing test blocks wrapping up: never skip or comment out a test.

5. **Commit and push.** Stage explicit paths only, never `git add -A`. Leave out `UI Mockup/` and
   the two design documents unless Thomas said otherwise. Write a message that describes the step.
   The pre-commit hook re-checks the memory, so if it blocks, fix what it names rather than
   bypassing it. Then `git push`. If `git remote -v` shows no `origin`, stop and say so.

6. **Confirm.** Compare `git rev-parse HEAD` with `git ls-remote origin refs/heads/main`. They must
   match. `git status` should show nothing beyond the known untracked items.

7. **Claude's own memory.** It holds only pointers to the repo. Touch it only if the repo location
   or remote changed. Do not copy project state into it: the repo is the single source of truth.

8. **Tell Thomas** in a few sentences: what was saved, the commit, whether GitHub matches, and
   anything that needs his decision.

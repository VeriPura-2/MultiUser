---
description: Restart the VeriPura platform project from its memory. Read-only except for starting the sandbox.
---

# Pick up the VeriPura platform project

The project memory (`docs/PROJECT_MEMORY.md`) is already loaded through `CLAUDE.md`. It holds the
standing rules, so follow them. This command re-establishes where the project really stands,
checks that the memory matches reality, and recommends what to do next. **Do not change any
files, and do not start building.** The only thing you may start is the Docker sandbox.

## Steps

1. **Read the source material the memory points to.** From `docs/BUILD_PROMPTS.md` read the
   "Environment, testing, build log, and version control" section and the "Notes for whoever runs
   these" section at the end (that is where the next prompt, Stripe, is described). Then read the
   last entry of `docs/build-log.md` (about the final 60 lines).

2. **Check git.** Run `git fetch`, `git status -sb`, and compare `git rev-parse HEAD` with
   `git rev-parse origin/main`. Note anything uncommitted, unpushed, or behind. The untracked
   `UI Mockup/` folder and the two design documents are expected and are not part of the repo.
   Also confirm `git config --local user.email` is the GitHub noreply address
   (`212863696+ThomasOberlin@users.noreply.github.com`) and `git config core.hooksPath` is
   `.githooks`. If either is wrong, say so and give the fix (the memory's Gotchas section has it;
   `npm install` restores the hooks path).

3. **Bring up the sandbox if needed.** If `node_modules` is missing, run `npm install`. Check
   Docker with `docker info`. If the daemon is not running, start Docker Desktop
   (`C:\Program Files\Docker\Docker\Docker Desktop.exe`) and wait for it. Then run
   `npm run db:up`. Report the database port (5433) and whether it came up healthy.

4. **Verify the code.** Run `npm run typecheck`, then `npm run memory:check -- --full`. The second
   command runs the entire test suite and checks the facts in the memory against reality (the
   stated test count, the date, the required sections). If it reports a problem, run `npm test`
   to see the details before reporting.

5. **Look for drift.** Compare what the memory claims with what you actually saw: the test count,
   the commit the History table names, the open items against the code (spot-check two or three:
   confirm the file or behavior each names still exists). Anything that does not match is a
   finding, and finding it is the point of this step. Rule 6: verify with evidence, do not assume.

6. **Report, briefly, in plain prose** (a short list is fine for open items):
   - where the project stands (stages complete, tests passing);
   - whether git is in sync with GitHub, and the sandbox state;
   - any drift or problem found, with the evidence;
   - the open items, and the recommended next step from the memory's "Next work" section, with one
     sentence on why;
   - then ask Thomas what he wants to do. Do not begin the work until he answers.

Do not use em dashes in anything you write.

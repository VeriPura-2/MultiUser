@docs/PROJECT_MEMORY.md

# Session protocol

The project memory above is loaded automatically. It holds the standing rules, the current state,
the history, and the open items.

- **Starting:** run `/pickup`. It reads the spec and the latest build-log entry, checks git and the
  sandbox, runs the tests, and reports where things stand.
- **Before changing anything:** if the work touches a decision recorded in `docs/build-log.md` or
  a requirement in `docs/BUILD_PROMPTS.md`, read that part first.
- **Ending a session, or finishing any numbered step:** run `/wrapup`. Never leave code changes
  without the matching update to `docs/build-log.md` and `docs/PROJECT_MEMORY.md`. A git hook and
  a Stop hook enforce this.
- The two documents `trade_compliance_control_tower_design.pdf` and
  `Veripura_Comparison_Two_Product_Architecture_Documents.docx` sit in this folder but are not part
  of the repo. Never stage them.

# ZIMOS backend — rules for Claude

Read `docs/LANES.md` before doing anything: it holds the working rules, what
is already built, and the slice of `docs/SPEC.md` each parallel chat owns.
Where `docs/LANES.md` and `docs/SPEC.md` differ, `docs/LANES.md` wins.

The short version:

- Do not stop to ask, plan for approval, or ask whether to continue. Decide,
  note the decision in `docs/progress/lane-N.md`, keep building.
- Do not run the test suites and do not write tests. Verify by running the
  feature on your lane's port, and typecheck the frontend before committing.
- Work only in your lane's worktree, database, ports and migration range.
- Build on the existing code: read it first, add new files, keep edits to
  existing files small.
- External integrations are an interface + a `sandbox` adapter + a README.
  No prices in code. Nothing from SPEC §21.
- One feature, one commit; then `git fetch origin`, `git merge
  origin/zimos-additions`, `git push origin HEAD:zimos-additions`. Never
  force-push, never push to `main`.
- `git` is at `"/c/Program Files/Git/bin/git.exe"`. No Python, `gh`, Docker or
  Redis on this machine — script with `node`.

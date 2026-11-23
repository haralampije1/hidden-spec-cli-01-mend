# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01/run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haralampije1/hidden-spec-cli-01-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haralampije1/hidden-spec-cli-01-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool-call edits. `SPEC.md` is the contract the grader checks against; `main.ts` is the CLI (`node main.ts [--format=NAME] [--check] [--strict] [PATCH]`) and `runner.ts` is the trial hand-over from the kit.

This entry was built for hidden-spec-cli-01-run-20261122 (entries close 2026-11-24T14:00Z).

## The files

- `main.ts` — the CLI, Node 22 standard library alone.
- `runner.ts` — the kit's trial runner (unchanged).
- `SPEC.md` — the specification.

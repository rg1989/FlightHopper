# .planning

The project's working notes: design documents, work-package plans, QA reports and the scripts that run checks on a
second machine. They record why things are the way they are. They are not user documentation: for that, start at the
[README](../README.md) and [docs/](../docs).

- `PLAN.md`, `*-design.md`: designs, each dated. Later ones supersede earlier ones.
- `plans/`: the work packages the features were built from.
- `reports/`: screenshots and measurements from checks.
- `HANDOFF.md`: where the work stood at the last handoff.
- `tools/`: `remote-check.sh` and `qa-omarchy.sh` run tests and headless screenshots on a Linux box named `omarchy`
  over ssh. Change the host name to use them.

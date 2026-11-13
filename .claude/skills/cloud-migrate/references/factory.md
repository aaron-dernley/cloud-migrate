# Driving the cloud-migration factory

The package ships a stagecraft factory, `factory/cloud-migration.yaml` (after
a pull, `.swamp/pulled-extensions/@aaronge/cloud-migrate/files/factory/cloud-migration.yaml`). The
person's guide to it is `docs/using-with-stagecraft.md` in this package; use
the `stagecraft` skill (from `@swamp/stagecraft`) for the driving rules.
The points specific to this factory:

- **scope**: create the `@aaronge/cloud-migrate` behavior here, named after
  the work item, and record it in the `scope` artifact's `migrationBehavior`.
  Every later stage reads that name.
- **map**: decisions are settled only through `resolve`, with the person's
  words and `by` naming them. Never resolve on your own. Run `map` after the
  last `resolve`, so the `mapping-review` counts you record match swamp's
  latest mapping. The `mapping-decisions` approval is asked for only when
  `needsDecision` or `unsupported` is above zero.
- **plan**: a plan with a non-empty `blocked` list is not ready; go back to
  map (`remap` is a manual exit, so ask first).
- **provision**: create only what the approved plan lists, in wave order,
  with each step's exact commands. Then `sync` each target and run `parity`.
  `provisioned` needs `parity: passed`.
- **transfer**: record `transfer-report` from the tools' own reports, with
  `units`, `sourceCount`, `targetCount`, `failures` and `verifiedBy`.
  `retry` is manual, because a repeat costs egress; ask first.
- **cutover** and **decommission** each wait for the person's approval.
  Before decommission, run `swamp behavior get <name> --json` for every
  source resource to be deleted, and list the provider ids for the person.
- Every advance, approval and override follows the stagecraft skill: read
  `status` first, pass back the expectations, and take a lone safe exit
  only.

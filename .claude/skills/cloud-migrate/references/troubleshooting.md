# Troubleshooting

- **Inventory is empty**: the source behaviors have no `state` data. Run
  their `list` (or `sync`) first, and check the names in `source.behaviors`.
  With `discover`, check that the provider packages are pulled in this repo.
- **unknownFields on resources**: the record lacked fields, which is common
  after a bare `list` (S3, for one). Run `get`/`sync` on the source behavior
  for those resources, then run `inventory` again.
- **"depends on ... which is not in scope"**: a dependency (network, key,
  role) was not inventoried. Add its behavior to the scope, or have the
  person confirm it stays where it is and is reachable from the target, and
  record that with `resolve`.
- **"target range ... overlaps the source's ..."**: the target network or
  subnet reuses a source range. While both clouds run, overlapping ranges
  can't be routed to each other, so a VPN back to anything left on the
  source fails. Ask the person for a non-overlapping range, then `resolve`
  with an override (e.g. `{"ipCidrRange":"10.30.1.0/24"}` on GCP), or record
  their confirmation that nothing on the target reaches the source.
- **Target names clash** (or **target behavior names clash after
  sanitising**): two resources of one kind map to the same name, or to names
  that differ only in characters a behavior name can't hold (`logs.example`
  and `logs-example`). Change `target.nameTemplate`, or exclude one with
  `resolve`. An override can't rename a target, because names come from the
  template.
- **staleResolutions**: a resolution's `decision` text matches nothing,
  usually because the decision changed after a re-inventory. Ask the person
  again, then `resolve` with the new text.
- **Parity "missing"**: the target behavior has no `state` yet. Run its
  `create`, then `sync`.
- **Parity "failed"**: compare `expected` with `actual` per field. A changed
  setting needs a target `update` or a new decision; never edit `expected`.
- **A CEL reference resolves to nothing**: the dependency's target behavior
  wasn't created yet. Provision in wave order.
- **A method failed**: inspect
  `swamp report get @swamp/method-summary --model <migration> --json` before
  retrying.

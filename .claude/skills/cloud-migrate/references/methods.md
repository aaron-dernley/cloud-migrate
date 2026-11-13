# Methods, data and the report

All methods run as `swamp behavior run <migration> <method> [--input k=v ...]`.
Object and array inputs take JSON: `--input 'overrides={"a":1}'`.

## Global arguments

| Argument              | Default  | Meaning                                                                 |
| --------------------- | -------- | ----------------------------------------------------------------------- |
| `source.provider`     | required | `aws`, `gcp`, `digitalocean` or `hetzner`                               |
| `source.behaviors`    | `[]`     | Source provider behaviors whose `state` data is in scope                |
| `source.discover`     | `false`  | Also take in every behavior of a supported type on the source provider |
| `source.snapshot`     |          | JSON file of provider records read instead of live data (repo-relative, or shipped with the package) |
| `source.include`      | all      | Exact resource names; a name nobody recorded fails inventory            |
| `source.region`       |          | Fallback region for records that carry none                             |
| `target.provider`     | required | Target provider id                                                      |
| `target.region`       | required | Target region/location in the target cloud's own naming                 |
| `target.project`      |          | Required for GCP targets                                                |
| `target.nameTemplate` | `{name}` | Target names; add a suffix where names are global (buckets)             |
| `maxPerWave`          | `10`     | Most resources per wave                                                 |

At least one of `source.behaviors`, `source.discover` or `source.snapshot`
must be set. A resource recorded by two behaviors is kept once (the fuller
record), and records with no id or name are listed as unsupported.

## inventory

Reads `state` data from the source behaviors (and discovered ones), and
writes `inventory`:

- `resources[]`: canonical resources. Check `unknownFields` (the record
  lacked them: refresh the source behavior with `get`/`sync`) and
  `unresolvedRefs` (dependencies outside the scope).
- `unsupported[]`: records whose behavior type no adapter knows. Show them;
  they are not migrated.

## map

Reads `inventory` and `resolutions`, and writes `mapping`:

- `entries[]`: `sourceId`, `kind`, `targetName`, `targetBehaviorName`,
  `targetBehaviorType`, `globalArguments`, `fidelity`, `losses`, `decisions`
  (open), `resolved`, `staleResolutions`, `expected`, `dependsOn`.
- `summary`: counts per fidelity: `exact`, `lossy`, `needs-decision`,
  `unsupported` and `excluded`.

Dependencies that migrate too are wired as
`${{ data.findBySpec("<target behavior>", "state")[0].attributes.<id> }}`, so
a target behavior reads its dependency's real id once that exists. Create
targets in wave order, or these resolve to nothing.

## resolve

Records one person's decision. Inputs:

| Input        | Required | Meaning                                                              |
| ------------ | -------- | -------------------------------------------------------------------- |
| `sourceId`   | yes      | From the mapping, e.g. `aws:vm:i-0abc`                               |
| `resolution` | yes      | What they decided, in their words                                   |
| `by`         | yes      | Who decided                                                          |
| `decision`   | no       | Text inside the decision this settles; omit to settle all open ones |
| `overrides`  | no       | Merged into the target's global arguments; `null` removes a key     |
| `exclude`    | no       | Leave the resource out; dependents render as if it stays behind     |
| `transfer`   | no       | Replace the step's transfer method, in the person's words           |
| `clear`      | no       | Forget every resolution for this resource                           |

Resolutions accumulate in the `resolutions` data and are applied on every
`map`. Run `map` after resolving. Overrides also update the entry's
`expected` values, so parity checks the overridden values. Each entry lists
every resolution applied to it in `appliedResolutions`, including ones that
only set values or the transfer method; `transferOverride` holds the
person's transfer choice.

## plan

Reads `inventory` and `mapping`, and writes `plan`:

- `waves[]`: `index`, `dataBytes`, and `steps[]`, each with `sourceId`,
  `kind`, `targetBehaviorName`, `targetBehaviorType`, `fidelity`, `transfer`
  (`id`, `description`, `providerNative`, `needsDecision`), `provision`
  (exact commands), `verify` and `rollback`.
- `blocked[]`: source ids with open decisions or no adapter. The plan is not
  ready until this is empty.

## parity

`--input wave=<n>` checks one wave, and no input checks all of them. It reads
each target behavior's `state` data and compares it with the mapping's
`expected` values over the kind's parity fields. It writes `parity` with a
`status` and `results[]` (`passed`, `failed` with mismatches, or `missing`
when the target has no state yet). An unknown target field fails; parity
passes on evidence only. Object, row and file counts are not checked here:
record the transfer tool's own report.

## The report

`@aaronge/cloud-migrate-plan` is a behavior-scope report. It renders the
latest inventory, mapping, plan, parity and resolutions as Markdown for the
approver, with sections in this order: open decisions, resolved decisions,
waves, what will not carry over, unsupported and unresolved, and parity.
Global argument values appear only in each step's provisioning command,
and all text is scrubbed for credential patterns. `resolve` refuses
secret-looking override keys, so none should be there. The report also
flags a plan made from an older mapping (`planStale`). Find how to run it with
`swamp help report`.

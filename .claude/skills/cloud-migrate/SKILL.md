---
name: cloud-migrate
description: >
  Plan and carry out a migration of infrastructure from one cloud to another
  with @aaronge/cloud-migrate: scope it, inventory the source from the
  official per-cloud swamp behaviors, map it onto the target, record a
  person's decisions with resolve, plan dependency waves, provision through
  the target behaviors, move data, and prove parity. Use when the user asks
  to "migrate to GCP/AWS/DigitalOcean/Hetzner", "move these buckets/VMs/
  databases to another cloud", "plan a cloud migration", "assess a
  migration", "what would it take to move X", or names @aaronge/cloud-migrate,
  cloud-migrate inventory/map/resolve/plan/parity, or the cloud-migration
  stagecraft factory. Not for migrations within one cloud account.
---

# cloud-migrate

`@aaronge/cloud-migrate` reads and plans; it never calls a cloud API and
never changes infrastructure. The official `@swamp/<cloud>/*` behaviors do
every read and write. Your job is to drive the methods in order, show the
person what each one found, and act only on their decisions.

## Rules

1. **Read before acting.** Read each method's data whole
   (`swamp data query 'modelName == "<migration>" && name == "<data>"' --select content`)
   or run the `@aaronge/cloud-migrate-plan` report. Never act on what you
   expect a method to have produced.
2. **Never decide for the person.** `resolve` records a person's decision,
   in their words, with `by` naming them. Never resolve a decision yourself,
   even an obvious one: propose it, with its trade-off, and wait.
3. **Nothing irreversible without approval.** Provisioning, cutover and
   deleting the source each need the person's explicit go-ahead. The source
   is never touched before decommission.
4. **Secrets never pass through plan data.** Database passwords and secret
   values go through a swamp vault (`${{ vault.get(<vault>, <key>) }}`),
   never into `resolve` overrides, inputs, or chat.
5. **Verify before deleting.** Run `swamp behavior get <name> --json` and
   check provider ids before any delete, on either cloud.
6. **Report faithfully.** A failed parity, a transfer with mismatched
   counts, or a step you skipped is said plainly.

## Setup (once per repo)

```sh
swamp extension pull @aaronge/cloud-migrate --channel beta
swamp extension pull @swamp/<source-cloud>/<service>   # e.g. @swamp/aws/ec2
swamp extension pull @swamp/<target-cloud>/<service>   # e.g. @swamp/gcp/compute
```

Pull the provider packages for every kind in scope.
[references/kinds.md](references/kinds.md) lists the kinds and the behavior
type each cloud uses for each kind. Credentials for both clouds go in a vault
and are wired into the provider behaviors' global arguments.

## The loop

1. **Scope** with the person: source and target clouds, target region (and
   project for GCP), what is in scope (named resources, named behaviors, or
   everything), acceptable downtime, budget/egress limits, compliance and
   data residency. Ask; never assume a constraint.
2. **Record the source.** Create the source provider behaviors and run
   their `list` (then `get`/`sync` where `list` returns little, e.g. S3).
3. **Create the migration**, one behavior per migration (or per wave of a
   large one):
   ```sh
   swamp behavior create @aaronge/cloud-migrate <migration> \
     --global-arg 'source={"provider":"aws","behaviors":["aws-net"],"discover":false}' \
     --global-arg 'target={"provider":"gcp","region":"europe-west2","project":"<project>","nameTemplate":"{name}"}'
   ```
   `discover: true` takes in every behavior of a supported type on the
   source cloud. `include` narrows to exact resource names.
4. **Assess**: `swamp workflow run "@aaronge/cloud-migrate/assess" --input migration=<migration>`
   (add `--input 'sourceBehaviors=[...]'` to refresh the source first), or
   run `inventory`, `map` and `plan` one by one.
5. **Review the mapping with the person.** Run the report
   (see [references/methods.md](references/methods.md)). For each entry:
   - `lossy`: explain each loss in plain words.
   - `needs-decision`: explain each decision and propose options with
     trade-offs.
   - `unsupported`: no adapter on the target; the options are to recreate it
     by hand or exclude it.
6. **Record their answers** with `resolve`, then run `map` again:
   ```sh
   swamp behavior run <migration> resolve \
     --input sourceId=<id from the mapping> \
     --input decision="<text identifying the decision>" \
     --input resolution="<their words>" \
     --input by="<their name>" \
     --input 'overrides={"<globalArg>": <value>}'     # optional
     # --input exclude=true  to leave it out of the migration
   swamp behavior run <migration> map
   ```
   Check `staleResolutions` on each entry: a resolution whose text no longer
   matches a decision did nothing. When the person picks a different way to
   move the data (e.g. rebuild instead of replicate), record it with
   `--input transfer="<their words>"` so the plan says so.
7. **Plan** with `swamp behavior run <migration> plan`. A non-empty `blocked`
   list means decisions are still open; go back to step 5. Present the waves,
   transfer methods, an egress estimate (say it is an estimate), downtime
   against the scope, and rollback. Get approval.
8. **Provision**, wave by wave, only after approval: each plan step carries
   the exact `swamp behavior create ...` command and `swamp behavior run
   <target> create`. Then `sync` each target and run
   `swamp behavior run <migration> parity --input wave=<n>`. Do not move
   data until parity passes.
9. **Transfer** with the step's transfer method
   ([references/transfer.md](references/transfer.md)). Record what the
   transfer tool reported: counts on both sides, failures, how it verified.
10. **Cut over** with the person's approval, then **soak** (7 days unless the
    scope says otherwise) with parity re-run, then **decommission** the
    source through its own behaviors' delete methods, with approval and
    after `swamp behavior get` checks.

When plan reviews keep finding new serious problems in the same area, the
design is the problem: propose a simpler design to the person (e.g. object
storage instead of syncing a VM's disk across clouds) rather than another
safeguard.

For a governed run with enforced approvals, use the stagecraft factory
shipped in the package (`factory/cloud-migration.yaml`): see
[references/factory.md](references/factory.md).

## Large migrations

Split by wave: one migration behavior (or one factory work item) per wave,
each later wave blocked by the waves it depends on. The plan's waves already
respect dependencies (a VM after its subnet and firewall, a subnet after its
network, a DNS record after its zone).

## Things that always need a person

Whatever the clouds: VM images (not portable), KMS keys (key material cannot
leave a KMS: create new keys and re-encrypt), secret values (copied through a
vault), IAM principals (permissions are rewritten, never translated),
function code (redeployed from source), NoSQL data models, load balancer
backends and certificates, and Kubernetes workloads (GitOps or Velero).

## References

- [references/methods.md](references/methods.md): every method, its inputs
  and data, and the report.
- [references/kinds.md](references/kinds.md): the 21 kinds, provider
  coverage, and per-kind caveats.
- [references/transfer.md](references/transfer.md): transfer methods per kind
  and cloud pair.
- [references/factory.md](references/factory.md): driving the stagecraft
  factory.
- [references/troubleshooting.md](references/troubleshooting.md): empty
  inventories, unknown fields, unresolved refs, parity failures.

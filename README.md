# @aaronge/cloud-migrate

Plan and verify a migration from one cloud to another: a single bucket, a
handful of resources, or a whole estate.

> **Beta.** This is published on the `beta` channel
> (`swamp extension pull @aaronge/cloud-migrate --channel beta`). The adapters
> are built from the official `@swamp/*` behavior schemas and tested against
> recorded fixtures. They have not yet been run against live cloud accounts.
> Machine and database size tables, offered engine versions and runtimes, and
> some service limits come from published provider documentation rather than
> live data. Treat every mapping as a proposal to review, which is how the
> extension presents it anyway, and report anything that maps wrongly.
>
> Known to verify on a first live run:
>
> - Hetzner and DigitalOcean reference numeric ids (servers, networks,
>   volumes, firewalls) with `${{ data.findBySpec(...) }}` expressions inside
>   arrays. A whole-field expression keeps its number type; one nested in an
>   array has not been checked yet.
> - Hetzner's server-type table may predate the late-2025 CX/CPX generations.

The extension never calls a cloud API and never changes infrastructure. The
official per-cloud swamp behaviors (`@swamp/aws/s3/bucket`,
`@swamp/gcp/storage/buckets`, ...) do every read and write. This extension
reads the `state` data they record, puts each resource into one
provider-neutral shape, maps it onto the target cloud, plans the move in
dependency-ordered waves, and checks the provisioned target against what the
mapping promised. Once migrated, the target infrastructure is ordinary swamp
behaviors, so swamp goes on managing it.

It also ships a `cloud-migrate` skill, so an agent that pulls the package
knows how to drive a migration with it, and a person's guide to running one
through stagecraft: [docs/using-with-stagecraft.md](docs/using-with-stagecraft.md).

It ships a [stagecraft](https://swamp-club.com) factory,
`factory/cloud-migration.yaml`, that drives a migration from scope to
decommission and stops for a person before every irreversible step.

## Supported today

21 canonical kinds across four clouds; each cell is the official `@swamp/...`
behavior type the adapter reads and renders.

| Kind | Amazon Web Services | Google Cloud | DigitalOcean | Hetzner Cloud |
| --- | --- | --- | --- | --- |
| `object-bucket` | `aws/s3/bucket` | `gcp/storage/buckets` | — | — |
| `network` | `aws/ec2/vpc` | `gcp/compute/networks` | `digitalocean/vpc` | `hetzner-cloud/networks` |
| `subnet` | `aws/ec2/subnet` | `gcp/compute/subnetworks` | — | — |
| `firewall` | `aws/ec2/security-group` | `gcp/compute/firewalls` | `digitalocean/firewall` | `hetzner-cloud/firewalls` |
| `vm` | `aws/ec2/instance` | `gcp/compute/instances` | `digitalocean/droplet` | `hetzner-cloud/servers` |
| `block-volume` | `aws/ec2/volume` | `gcp/compute/disks` | `digitalocean/volume` | `hetzner-cloud/volumes` |
| `sql-database` | `aws/rds/dbinstance` | `gcp/sqladmin/instances` | `digitalocean/database-cluster` | — |
| `dns-zone` | `aws/route53/hosted-zone` | `gcp/dns/managedzones` | `digitalocean/domain` | `hetzner-cloud/zones` |
| `dns-record` | `aws/route53/record-set` | `gcp/dns/resourcerecordsets` | `digitalocean/domain-record` | — |
| `load-balancer` | `aws/elasticloadbalancingv2/load-balancer` | `gcp/compute/forwardingrules` | `digitalocean/load-balancer` | `hetzner-cloud/load-balancers` |
| `kubernetes-cluster` | `aws/eks/cluster` | `gcp/container/clusters` | `digitalocean/kubernetes-cluster` | — |
| `container-registry` | `aws/ecr/repository` | `gcp/artifactregistry/repositories` | `digitalocean/container-registry` | — |
| `message-topic` | `aws/sns/topic` | `gcp/pubsub/topics` | — | — |
| `message-queue` | `aws/sqs/queue` | `gcp/pubsub/subscriptions` | — | — |
| `function` | `aws/lambda/function` | `gcp/cloudfunctions/functions` | — | — |
| `cache` | `aws/elasticache/replication-group` | `gcp/redis/instances` | `digitalocean/database-cluster` | — |
| `file-share` | `aws/efs/file-system` | `gcp/file/instances` | `digitalocean/nfs` | — |
| `nosql-table` | `aws/dynamodb/global-table` | `gcp/firestore/databases` | — | — |
| `kms-key` | `aws/kms/key` | `gcp/cloudkms/keyrings-cryptokeys` | — | — |
| `secret` | `aws/secretsmanager/secret` | `gcp/secretmanager/secrets` | — | — |
| `iam-principal` | `aws/iam/role` | `gcp/iam/serviceaccounts` | — | — |

Records of any other type are not dropped: inventory lists them as
`unsupported`, and a kind the target has no adapter for maps as
`unsupported`: `plan` leaves it out of the waves and lists it under
`blocked` until a person excludes it or recreates it by hand. A new cloud or
kind is one adapter file in `extensions/behaviors/_lib/providers/`, against
the canonical shapes in `_lib/kinds.ts`.

Some kinds always need a person, whatever the clouds: VM images are not
portable, KMS key material cannot leave a KMS, secret values are copied
through a vault and never through plan data, IAM permissions are rewritten
rather than translated, function code is redeployed, and NoSQL data models
are confirmed before data moves.

## Try it without a cloud

`examples/demo-aws-estate.json` is a small fictional AWS shop: a VPC,
subnets, firewalls, two VMs, a volume, Postgres, a bucket, a queue, a secret,
an IAM role, DNS and a KMS key. Point a migration at it with
`source.snapshot` and run the whole flow offline:

```sh
swamp behavior create @aaronge/cloud-migrate demo \
  --global-arg 'source={"provider":"aws","snapshot":"examples/demo-aws-estate.json"}' \
  --global-arg 'target={"provider":"gcp","region":"europe-west2","project":"demo-project"}'
swamp workflow run "@aaronge/cloud-migrate/assess" --input migration=demo
```

## Installation

```sh
swamp extension pull @aaronge/cloud-migrate --channel beta
# The provider behaviors for what you are moving, e.g. a VM stack from AWS to GCP:
swamp extension pull @swamp/aws/ec2
swamp extension pull @swamp/gcp/compute
# Optional, for the guided process:
swamp extension pull @swamp/stagecraft
```

## Usage

1. Record the source with its provider behavior:

   ```sh
   swamp behavior create @swamp/aws/s3/bucket aws-buckets --global-arg region=eu-west-2
   swamp behavior run aws-buckets list
   ```

2. Create a migration and run it through:

   ```sh
   swamp behavior create @aaronge/cloud-migrate assets-to-gcp \
     --global-arg 'source={"provider":"aws","behaviors":["aws-buckets"],"include":["example-assets"]}' \
     --global-arg 'target={"provider":"gcp","region":"europe-west2","project":"example-project","nameTemplate":"{name}-gcp"}'
   swamp behavior run assets-to-gcp inventory
   swamp behavior run assets-to-gcp map
   ```

3. Settle what the mapping asks a person to decide, then map again and plan:

   ```sh
   swamp behavior run assets-to-gcp resolve \
     --input sourceId=aws:object-bucket:example-assets \
     --input decision="public access" \
     --input resolution="Keep it private; the CDN serves the public files" \
     --input by="Jo (platform lead)"
   swamp behavior run assets-to-gcp map
   swamp behavior run assets-to-gcp plan
   ```

4. Provision what the plan lists (each step carries the exact
   `swamp behavior create ... --global-arg ...` command), move the data with
   the plan's transfer method, then:

   ```sh
   swamp behavior run assets-to-gcp-object-bucket-example-assets-gcp sync
   swamp behavior run assets-to-gcp parity
   ```

Read any result with
`swamp data query 'modelName == "assets-to-gcp" && name == "mapping"' --select content`.

## Global arguments

| Argument              | Required | Default    | Description                                                                       |
| --------------------- | -------- | ---------- | --------------------------------------------------------------------------------- |
| `source.provider`     | yes      |            | Source provider id: `aws`, `gcp`, `digitalocean` or `hetzner`.                    |
| `source.behaviors`    | one of   | `[]`       | Source provider behaviors whose `state` data is in scope. Run their `list` first. |
| `source.discover`     | one of   | `false`    | Also take in every behavior of a supported type for `source.provider`.            |
| `source.snapshot`     | one of   |            | JSON file of provider records to read instead of live data (offline, or the demo). |
| `source.include`      | no       | everything | Exact resource names to migrate. A name nobody recorded fails inventory.          |
| `source.region`       | no       |            | Source region, for records that do not carry their own.                           |
| `target.provider`     | yes      |            | Target provider id.                                                               |
| `target.region`       | yes      |            | Target region or location.                                                        |
| `target.project`      | GCP      |            | Target project (GCP needs one).                                                   |
| `target.nameTemplate` | no       | `{name}`   | Target resource name; bucket names are global, so a suffix avoids clashes.        |
| `maxPerWave`          | no       | `10`       | Most resources in one wave.                                                       |

## How it works

### inventory

Queries the `state` data of each `source.behaviors` behavior and normalises
every record an adapter understands into a canonical resource of one of the
21 kinds (see `_lib/kinds.ts` for each kind's properties). A field the record
does not carry is listed in `unknownFields` instead of being guessed (some
`list` methods return little, so run `get`/`sync` for full properties).
Records no adapter understands go to `unsupported`.

Each resource also records what it references (a subnet its network, a VM
its subnet, firewalls and volumes, a DNS record its zone, a bucket its KMS
key). Inventory resolves those references to the other inventoried
resources; one that points outside the scope is kept as an unresolved
reference, and the mapping asks whether it moves too or stays put.

### mapping

Renders each resource as the target behavior type's global arguments and
grades it:

- **exact**: carries over as is.
- **lossy**: carries over, and `losses` says what does not (renamed labels,
  untranslated lifecycle rules, CORS, website hosting, object ACLs).
- **needs-decision**: a person must choose first. Examples are a customer-managed key,
  a locked retention policy, public access, an invalid target name, or an
  unknown source field.
- **unsupported**: the target has no adapter for the kind.
- **excluded**: a person decided to leave it out.

A person's answers, recorded with `resolve`, are applied on every `map` run:
each settles the decisions containing its `decision` text (or all of them),
merges its `overrides` into the target's global arguments, or excludes the
resource (`exclude`), after which its dependents render as if it stays
behind. A resolution can also replace a step's transfer method (`transfer`),
for example "rebuild from configuration management" where the default would
replicate disks. Overrides update parity's expectations too, so parity checks
what the person asked for. Every resolution applied shows on its entry in
`appliedResolutions`. A resolution whose text no longer matches anything is listed in
`staleResolutions`. Only a person's decisions belong there; `by` names them.

Map also checks address ranges. A target network or subnet whose range
overlaps the source's raises a decision: while both clouds run, nothing can be
routed between overlapping ranges, so a VPN back to anything that stays
behind would fail.

A dependency that is migrated too is wired by CEL, so the target behavior
reads its dependency's real id once that exists:
`${{ data.findBySpec("<target behavior>", "state")[0].attributes.<id> }}`.
Target names that clash within a kind fail the method.

### plan

Orders the mappable resources into waves, every resource after everything it
depends on and no wave larger than `maxPerWave`. Each step names the target
behavior to create, the transfer method (provider-native where one exists:
Storage Transfer Service for S3 → GCS, DataSync for GCS → S3; otherwise a
copier host, which needs a decision; databases replicate with Database
Migration Service or AWS DMS, VMs with Migrate to Virtual Machines or AWS
MGN, and so on per kind), the verification, and the rollback.
Each step carries the exact `swamp behavior create` command, global
arguments included. `blocked` lists resources that still need a decision.

### parity

Reads each target behavior's `state` data, normalises it the same way, and
compares it with what the mapping expected over the kind's parity fields. A target field
that comes back unknown is a mismatch: parity passes on evidence, never on
absence. Object, row and file counts and checksums are the transfer tools'
job; the factory records their reports separately.

## Workflow

There is no schedule: a migration is driven by a person, not timed.

### Assessment

`@aaronge/cloud-migrate/assess` is shipped with the package. It assesses a
migration end to end without changing anything in either cloud: it optionally
refreshes the source providers, then runs `inventory`, `map` and `plan` on your
migration behavior in order.

```sh
swamp workflow run "@aaronge/cloud-migrate/assess" \
  --input migration=assets-to-gcp \
  --input 'sourceBehaviors=["aws-prod-ec2","aws-prod-rds"]'
```

| Input             | Required | Description                                                                                                   |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `migration`       | yes      | Name of the `@aaronge/cloud-migrate` behavior instance.                                                       |
| `sourceBehaviors` | no       | Source provider behaviors to refresh first by running their `list` method. Empty (the default) skips it. |

The refresh runs as its own job and the assessment waits for it, so
`inventory` reads fresh data. A failed refresh does not stop the assessment;
check the refresh job's result before trusting the plan.

### The guided process

Create the factory
from the shipped definition (its `definition:` and `scenarios:` blocks go
under the factory's `globalArguments:`), then validate it:

```sh
swamp behavior create @swamp/stagecraft/tracker migrations --global-arg prefix=mig
swamp behavior create @swamp/stagecraft/factory cloud-migration --global-arg tracker=migrations
# paste the shipped factory's definition: and scenarios: under globalArguments:
# (after a pull: .swamp/pulled-extensions/@aaronge/cloud-migrate/files/factory/cloud-migration.yaml), then
swamp behavior run cloud-migration validate
```

The stages are:

| Stage        | Who            | Leaves when                                                               |
| ------------ | -------------- | ------------------------------------------------------------------------- |
| scope        | agent + person | the scope is recorded and **a person approves it**                        |
| inventory    | agent          | the inventory found at least one resource                                 |
| map          | agent          | the mapping is reviewed; **a person rules** only if anything needs one    |
| plan         | agent          | a plan with waves, egress estimate and rollback is recorded               |
| plan-review  | subagent       | no critical/high findings and **a person approves the plan**              |
| provision    | agent          | the target exists and parity passed                                       |
| transfer     | agent + person | the transfer report shows no failures and equal object counts             |
| cutover      | agent + person | **a person approves** and the cutover is recorded                         |
| soak         | agent          | a soak (7 days by default) with parity passing and no rollback            |
| decommission | agent + person | **a person approves** deleting the source, through its own behaviors only |

A large migration runs one work item per wave, each blocked by the waves it
depends on. Every loop back (rework, retry, roll back) is bounded, and the
source stays untouched until decommission.

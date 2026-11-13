# Kinds and provider coverage

Each cell is the official `@swamp/...` behavior type the adapter reads (as a
source) and renders (as a target). A dash means that cloud's official
extension has no fitting type: resources of that kind map as `unsupported`
onto it, so recreate them by hand or exclude them.

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

Each kind's canonical properties are in `extensions/behaviors/_lib/kinds.ts`
in the source, and in this package's README.

## Caveats per kind

- **object-bucket**: lifecycle rules, CORS and website hosting are not
  translated. Bucket names are global, so use a `nameTemplate` suffix.
  Locked retention needs a decision, because locks are irreversible.
- **network / subnet**: Hetzner subnets are ranges inside the network.
  GCP networks may have no CIDR (custom mode).
- **firewall**: rules that reference other groups or tags become decisions.
  GCP firewalls attach to VMs through network tags, while AWS, DigitalOcean
  and Hetzner attach them to instances.
- **vm**: images are always a decision. Size is chosen as the smallest
  target type that fits the vCPUs and memory, and recorded as a loss. Disks
  move by replication or rebuild.
- **block-volume**: snapshots don't cross clouds; copy the filesystem.
- **sql-database**: engine and major version must be offered on the target.
  Passwords come from a vault, never the plan.
- **dns-zone / dns-record**: lower TTLs ahead of cutover, then switch the
  name servers at the registrar. DigitalOcean records need their domain in
  the record data.
- **load-balancer**: front ends only. Backends, health checks and
  certificates are recreated by hand. GCP load balancers cover the
  forwarding rule only.
- **kubernetes-cluster**: the control plane only. Move workloads with GitOps
  or Velero.
- **message-topic / message-queue**: SQS queues become Pub/Sub
  subscriptions, which need a topic. In-flight messages drain rather than
  move.
- **function**: code is redeployed from source, and triggers are rewired.
- **cache**: caches warm up on the target rather than being copied.
- **file-share**: Filestore has capacity minimums, recorded as losses.
- **nosql-table**: confirm the data model before moving any data.
- **kms-key**: key material never moves. Create a new key and re-encrypt.
- **secret**: only the container is created. Copy values through a vault,
  then rotate them at the source.
- **iam-principal**: permissions are rewritten for the target, never
  translated.

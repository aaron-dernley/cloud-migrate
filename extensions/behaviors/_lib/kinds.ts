/**
 * Canonical resource kinds: what a resource *is*, independent of who sells
 * it. Every provider adapter normalises into these shapes and renders from
 * them, so a mapping from any cloud to any other goes through one model.
 *
 * Property values are JSON. `null` always means "the source did not say",
 * never a guessed default; parity skips an expected null and fails an
 * actual null.
 *
 * @module
 */

/** Every kind the extension understands. */
export const RESOURCE_KINDS = [
  "object-bucket",
  "network",
  "subnet",
  "firewall",
  "vm",
  "block-volume",
  "sql-database",
  "dns-zone",
  "dns-record",
  "load-balancer",
  "kubernetes-cluster",
  "container-registry",
  "message-topic",
  "message-queue",
  "function",
  "cache",
  "file-share",
  "nosql-table",
  "kms-key",
  "secret",
  "iam-principal",
] as const;

export type ResourceKind = typeof RESOURCE_KINDS[number];

/** A firewall rule in canonical form. */
export interface FirewallRule {
  direction: "ingress" | "egress";
  /** `tcp`, `udp`, `icmp` or `all`. */
  protocol: string;
  /** A port or range such as `"22"` or `"8000-8080"`; null for all ports. */
  ports: string | null;
  /** CIDR blocks the rule applies to (sources for ingress, destinations for egress). */
  cidrs: string[];
}

/** What a kind means, which properties it carries, and what parity checks. */
export interface KindSpec {
  kind: ResourceKind;
  description: string;
  /**
   * Canonical properties: name → meaning. Adapters fill every one (null when
   * unknown) and `labels` as a string map when the provider has labels/tags.
   */
  properties: Record<string, string>;
  /** Properties parity compares between the mapping's expectation and the target. */
  parityFields: string[];
  /** The kinds a resource of this kind may reference (its dependencies). */
  dependsOnKinds: ResourceKind[];
  /** Decisions that apply to every resource of this kind, whatever the providers. */
  alwaysDecide: string[];
  /** Holds data that must be moved, not just configuration to recreate. */
  carriesData: boolean;
}

const LABELS = "Key/value labels or tags (string map; {} when none).";

export const KINDS: Record<ResourceKind, KindSpec> = {
  "object-bucket": {
    kind: "object-bucket",
    description: "An object storage bucket (S3, GCS, Spaces, ...).",
    properties: {
      versioning: "Object versioning on (boolean).",
      encryption: '"provider-managed", "customer-key" or "none".',
      publicAccess: '"blocked" or "allowed".',
      tier:
        'Default storage tier: "hot", "cool", "cold" or "archive"; null when the provider has no bucket default.',
      labels: LABELS,
      lifecycleRules: "Number of lifecycle rules (not translated).",
      cors: "A CORS policy is configured (boolean, not translated).",
      website:
        "Static website hosting is configured (boolean, not translated).",
      retentionLocked: "A locked retention policy or object lock (boolean).",
    },
    parityFields: [
      "versioning",
      "encryption",
      "publicAccess",
      "tier",
      "retentionLocked",
      "labels",
    ],
    dependsOnKinds: ["kms-key"],
    alwaysDecide: [],
    carriesData: true,
  },
  network: {
    kind: "network",
    description: "A private network (VPC, VPC network, Hetzner network).",
    properties: {
      cidr:
        "Primary CIDR block, or null where the network has none (GCP auto/custom mode).",
      labels: LABELS,
    },
    parityFields: ["cidr", "labels"],
    dependsOnKinds: [],
    alwaysDecide: [],
    carriesData: false,
  },
  subnet: {
    kind: "subnet",
    description: "A subnet of a network.",
    properties: {
      cidr: "CIDR block.",
      zone: "Availability zone, or null for regional subnets.",
      publicIpOnLaunch: "Instances get a public IP by default (boolean).",
      labels: LABELS,
    },
    parityFields: ["cidr", "labels"],
    dependsOnKinds: ["network"],
    alwaysDecide: [],
    carriesData: false,
  },
  firewall: {
    kind: "firewall",
    description:
      "A set of network access rules (security group, firewall rule set).",
    properties: {
      description: "Free-text description, or null.",
      rules:
        "FirewallRule[]: direction, protocol, ports, cidrs. Rules referencing other groups/tags are listed in the mapping's decisions instead.",
      labels: LABELS,
    },
    parityFields: ["rules", "labels"],
    dependsOnKinds: ["network"],
    alwaysDecide: [],
    carriesData: false,
  },
  vm: {
    kind: "vm",
    description: "A virtual machine.",
    properties: {
      machineType: "The provider's own size name (native string).",
      vcpus:
        "Virtual CPUs (number), from the machine type when the record does not say.",
      memoryMiB: "Memory in MiB (number).",
      architecture: '"x86_64" or "arm64".',
      image: "The provider's own image id/name (native string).",
      publicIp: "Has a public IP (boolean).",
      bootDiskGiB: "Boot disk size in GiB (number).",
      labels: LABELS,
    },
    parityFields: ["vcpus", "memoryMiB", "architecture", "publicIp", "labels"],
    dependsOnKinds: [
      "subnet",
      "network",
      "firewall",
      "block-volume",
      "iam-principal",
    ],
    alwaysDecide: [
      "images are not portable between clouds: choose the target image (same OS and version) or rebuild from configuration management",
    ],
    carriesData: true,
  },
  "block-volume": {
    kind: "block-volume",
    description: "A block storage volume or persistent disk.",
    properties: {
      sizeGiB: "Size in GiB (number).",
      media: '"ssd" or "hdd".',
      iops: "Provisioned IOPS (number), or null when not provisioned.",
      encryption: '"provider-managed", "customer-key" or "none".',
      zone: "Availability zone.",
      labels: LABELS,
    },
    parityFields: ["sizeGiB", "media", "encryption", "labels"],
    dependsOnKinds: ["kms-key"],
    alwaysDecide: [],
    carriesData: true,
  },
  "sql-database": {
    kind: "sql-database",
    description: "A managed relational database instance.",
    properties: {
      engine: '"postgres", "mysql", "sqlserver", "mariadb" or "oracle".',
      engineVersion: 'Major version, e.g. "15" or "8.0".',
      instanceClass: "The provider's own size name (native string).",
      vcpus: "Virtual CPUs (number).",
      memoryMiB: "Memory in MiB (number).",
      storageGiB: "Allocated storage in GiB (number).",
      highAvailability: "Multi-zone / standby (boolean).",
      backupRetentionDays: "Automated backup retention in days (number).",
      publicAccess: "Reachable from the internet (boolean).",
      labels: LABELS,
    },
    parityFields: [
      "engine",
      "engineVersion",
      "storageGiB",
      "highAvailability",
      "backupRetentionDays",
      "publicAccess",
      "labels",
    ],
    dependsOnKinds: ["network", "subnet", "firewall", "kms-key"],
    alwaysDecide: [],
    carriesData: true,
  },
  "dns-zone": {
    kind: "dns-zone",
    description: "A DNS zone.",
    properties: {
      domain: "Domain name without the trailing dot.",
      private: "Private (VPC-only) zone (boolean).",
      labels: LABELS,
    },
    parityFields: ["domain", "private"],
    dependsOnKinds: ["network"],
    alwaysDecide: [],
    carriesData: false,
  },
  "dns-record": {
    kind: "dns-record",
    description: "A DNS record set.",
    properties: {
      name: "Fully qualified name without the trailing dot.",
      type: 'Record type, e.g. "A", "CNAME", "MX".',
      ttl: "TTL in seconds (number).",
      values: "Record values (string[]), without trailing dots on names.",
    },
    parityFields: ["name", "type", "ttl", "values"],
    dependsOnKinds: ["dns-zone"],
    alwaysDecide: [],
    carriesData: false,
  },
  "load-balancer": {
    kind: "load-balancer",
    description: "A load balancer.",
    properties: {
      scheme: '"internet" or "internal".',
      layer: '"application" (HTTP) or "network" (TCP/UDP).',
      listeners: "[{ protocol, port }] the balancer accepts.",
      labels: LABELS,
    },
    parityFields: ["scheme", "layer", "listeners", "labels"],
    dependsOnKinds: ["network", "subnet", "firewall", "vm"],
    alwaysDecide: [
      "target groups, health checks and certificates are not translated; recreate them and repoint DNS at cutover",
    ],
    carriesData: false,
  },
  "kubernetes-cluster": {
    kind: "kubernetes-cluster",
    description: "A managed Kubernetes control plane.",
    properties: {
      version: 'Kubernetes minor version, e.g. "1.30".',
      nodeCount: "Total nodes, when the record says (number).",
      privateEndpoint: "The API server is private (boolean).",
      labels: LABELS,
    },
    parityFields: ["version", "privateEndpoint", "labels"],
    dependsOnKinds: ["network", "subnet", "iam-principal"],
    alwaysDecide: [
      "workloads, node pools, storage classes, ingress and cloud IAM bindings are not migrated with the control plane; move workloads with GitOps or Velero",
    ],
    carriesData: false,
  },
  "container-registry": {
    kind: "container-registry",
    description: "A container image repository.",
    properties: {
      name: "Repository name.",
      immutableTags: "Tags cannot be overwritten (boolean).",
      scanOnPush: "Vulnerability scanning on push (boolean).",
      labels: LABELS,
    },
    parityFields: ["immutableTags", "labels"],
    dependsOnKinds: ["kms-key"],
    alwaysDecide: [],
    carriesData: true,
  },
  "message-topic": {
    kind: "message-topic",
    description: "A publish/subscribe topic (SNS, Pub/Sub topic).",
    properties: {
      name: "Topic name.",
      ordered: "Ordering / FIFO semantics (boolean).",
      labels: LABELS,
    },
    parityFields: ["ordered", "labels"],
    dependsOnKinds: ["kms-key"],
    alwaysDecide: [],
    carriesData: false,
  },
  "message-queue": {
    kind: "message-queue",
    description: "A pull queue (SQS queue, Pub/Sub subscription).",
    properties: {
      name: "Queue name.",
      ordered: "FIFO / ordered delivery (boolean).",
      visibilityTimeoutSeconds: "Ack deadline / visibility timeout (number).",
      retentionSeconds: "Message retention (number).",
      deadLetter: "A dead-letter target is configured (boolean).",
      labels: LABELS,
    },
    parityFields: [
      "ordered",
      "visibilityTimeoutSeconds",
      "retentionSeconds",
      "labels",
    ],
    dependsOnKinds: ["message-topic", "kms-key"],
    alwaysDecide: [
      "in-flight messages are not moved: drain the source queue or dual-publish during cutover",
    ],
    carriesData: false,
  },
  function: {
    kind: "function",
    description: "A serverless function.",
    properties: {
      runtime: 'Language runtime, e.g. "python3.12", "nodejs20".',
      memoryMiB: "Memory in MiB (number).",
      timeoutSeconds: "Timeout in seconds (number).",
      entryPoint: "Handler / entry point (string).",
      labels: LABELS,
    },
    parityFields: ["runtime", "memoryMiB", "timeoutSeconds", "labels"],
    dependsOnKinds: ["iam-principal", "network", "subnet"],
    alwaysDecide: [
      "function code, triggers and handler signatures differ between clouds: redeploy from source with the target's trigger wiring",
    ],
    carriesData: false,
  },
  cache: {
    kind: "cache",
    description: "A managed in-memory cache (Redis, Memcached, Valkey).",
    properties: {
      engine: '"redis", "valkey" or "memcached".',
      engineVersion: "Engine version (string).",
      memoryGiB: "Memory in GiB (number).",
      nodes: "Node count (number).",
      labels: LABELS,
    },
    parityFields: ["engine", "memoryGiB", "labels"],
    dependsOnKinds: ["network", "subnet", "firewall"],
    alwaysDecide: [],
    carriesData: false,
  },
  "file-share": {
    kind: "file-share",
    description: "A managed network file system (EFS, Filestore).",
    properties: {
      protocol: '"nfs" or "smb".',
      capacityGiB:
        "Provisioned capacity in GiB, or null when elastic (number).",
      performance: '"standard" or "high".',
      encryption: '"provider-managed", "customer-key" or "none".',
      labels: LABELS,
    },
    parityFields: ["protocol", "encryption", "labels"],
    dependsOnKinds: ["network", "subnet", "kms-key"],
    alwaysDecide: [],
    carriesData: true,
  },
  "nosql-table": {
    kind: "nosql-table",
    description: "A NoSQL table or database (DynamoDB, Firestore).",
    properties: {
      name: "Table / database name.",
      keys: "Primary key attribute names (string[]).",
      billing: '"on-demand" or "provisioned".',
      pointInTimeRecovery: "Point-in-time recovery on (boolean).",
      labels: LABELS,
    },
    parityFields: ["pointInTimeRecovery", "labels"],
    dependsOnKinds: ["kms-key"],
    alwaysDecide: [
      "NoSQL data models and query semantics differ between clouds: confirm the target model and access patterns before moving data",
    ],
    carriesData: true,
  },
  "kms-key": {
    kind: "kms-key",
    description: "A key management service key.",
    properties: {
      purpose: '"encrypt" or "sign".',
      rotation: "Automatic rotation on (boolean).",
      labels: LABELS,
    },
    parityFields: ["purpose", "rotation"],
    dependsOnKinds: [],
    alwaysDecide: [
      "key material cannot leave a cloud KMS: create a new target key and re-encrypt data with it; keep the source key until nothing needs it",
    ],
    carriesData: false,
  },
  secret: {
    kind: "secret",
    description: "A stored secret (Secrets Manager, Secret Manager).",
    properties: {
      name: "Secret name.",
      rotation: "Automatic rotation configured (boolean).",
      labels: LABELS,
    },
    parityFields: ["labels"],
    dependsOnKinds: ["kms-key"],
    alwaysDecide: [
      "secret values are never read or planned here: copy them through a swamp vault, then rotate them at the source after cutover",
    ],
    carriesData: false,
  },
  "iam-principal": {
    kind: "iam-principal",
    description: "A workload identity (IAM role, service account).",
    properties: {
      name: "Principal name.",
      principalType: '"role", "service-account" or "user".',
      description: "Free-text description, or null.",
    },
    parityFields: [],
    dependsOnKinds: [],
    alwaysDecide: [
      "IAM models differ between clouds: rewrite this principal's permissions for the target with least privilege; nothing is translated automatically",
    ],
    carriesData: false,
  },
};

/**
 * The provider registry and data transfer strategies.
 *
 * Every provider adapter lives in `providers/<id>.ts` and is registered
 * here. Supporting a new cloud means writing one adapter file and adding it
 * to {@linkcode PROVIDERS}; nothing else in the extension names a provider.
 *
 * @module
 */
import type { KindAdapter, ProviderAdapter } from "./adapter.ts";
import type { ResourceKind } from "./kinds.ts";
import { aws } from "./providers/aws.ts";
import { gcp } from "./providers/gcp.ts";
import { digitalocean } from "./providers/digitalocean.ts";
import { hetzner } from "./providers/hetzner.ts";

export type {
  CanonicalResource,
  KindAdapter,
  ProviderAdapter,
  RenderContext,
  TargetSettings,
} from "./adapter.ts";
export type { ResourceKind } from "./kinds.ts";

/** Every registered provider, by id. */
export const PROVIDERS: Record<string, ProviderAdapter> = {
  aws,
  gcp,
  digitalocean,
  hetzner,
};

/** The adapter for `provider`, or a clear error naming the supported ones. */
export function getProvider(provider: string): ProviderAdapter {
  const adapter = PROVIDERS[provider];
  if (!adapter) {
    throw new Error(
      `No adapter for provider "${provider}". Supported: ${
        Object.keys(PROVIDERS).join(", ")
      }. Add one in extensions/behaviors/_lib/providers/.`,
    );
  }
  return adapter;
}

/**
 * The kind adapter for one record of `behaviorType`, searching every
 * provider. A type that models several kinds is resolved by each adapter's
 * `accepts`; the first that accepts the record wins.
 */
export function findKindByBehaviorType(
  behaviorType: string,
  attributes: Record<string, unknown> = {},
):
  | { provider: ProviderAdapter; kind: ResourceKind; adapter: KindAdapter }
  | null {
  for (const provider of Object.values(PROVIDERS)) {
    for (const [kind, adapter] of Object.entries(provider.kinds)) {
      if (
        adapter?.behaviorType === behaviorType &&
        (adapter.accepts?.(attributes) ?? true)
      ) {
        return { provider, kind: kind as ResourceKind, adapter };
      }
    }
  }
  return null;
}

/** How a resource's data (or traffic) moves, for one source → target pair. */
export interface TransferStrategy {
  id: string;
  description: string;
  /** Runs inside the clouds (true) or through a host you run (false). */
  providerNative: boolean;
  /** A person must choose or confirm the method before it starts. */
  needsDecision: boolean;
}

/** Provider-native paths that exist for a specific pair, keyed `kind:from>to`. */
const PAIR_STRATEGIES: Record<string, TransferStrategy> = {
  "object-bucket:aws>gcp": {
    id: "gcp-storage-transfer-service",
    description:
      "Google Storage Transfer Service pulls from S3 with an IAM role or access key; AWS bills egress.",
    providerNative: true,
    needsDecision: false,
  },
  "object-bucket:gcp>aws": {
    id: "aws-datasync",
    description:
      "AWS DataSync reads GCS through its S3-compatible XML API with an HMAC key; GCP bills egress.",
    providerNative: true,
    needsDecision: false,
  },
  "sql-database:aws>gcp": {
    id: "gcp-database-migration-service",
    description:
      "Google Database Migration Service replicates continuously from RDS (MySQL/PostgreSQL) into Cloud SQL, so cutover is a short promotion.",
    providerNative: true,
    needsDecision: false,
  },
  "sql-database:gcp>aws": {
    id: "aws-dms",
    description:
      "AWS Database Migration Service replicates from Cloud SQL into RDS with change data capture, so cutover is a short stop-and-switch.",
    providerNative: true,
    needsDecision: false,
  },
  "vm:aws>gcp": {
    id: "gcp-migrate-to-virtual-machines",
    description:
      "Google Migrate to Virtual Machines replicates EC2 instances' disks into Compute Engine and cuts over with a short final sync.",
    providerNative: true,
    needsDecision: true,
  },
  "vm:gcp>aws": {
    id: "aws-application-migration-service",
    description:
      "AWS Application Migration Service (MGN) replicates the VM's disks with an agent and launches it on EC2 at cutover.",
    providerNative: true,
    needsDecision: true,
  },
  "file-share:aws>gcp": {
    id: "gcp-storage-transfer-agent",
    description:
      "Storage Transfer Service with agents mounts EFS over NFS and copies into Filestore; agents run on VMs you size.",
    providerNative: true,
    needsDecision: true,
  },
  "file-share:gcp>aws": {
    id: "aws-datasync-agent",
    description:
      "AWS DataSync with an agent reads Filestore over NFS and writes to EFS.",
    providerNative: true,
    needsDecision: true,
  },
};

/** The fallback for each kind when no pair-specific path is known. */
const KIND_STRATEGIES: Partial<Record<ResourceKind, TransferStrategy>> = {
  "object-bucket": {
    id: "copier-host",
    description:
      "No provider-native path is known for this pair: copy through a host you run (rclone handles every S3-compatible store). Bytes and egress flow through that host.",
    providerNative: false,
    needsDecision: true,
  },
  "block-volume": {
    id: "snapshot-and-copy",
    description:
      "Snapshot the volume, then copy its filesystem to the new volume from a VM attached to both (rsync or dd over the network). Images and snapshots do not cross clouds.",
    providerNative: false,
    needsDecision: true,
  },
  vm: {
    id: "rebuild-or-replicate",
    description:
      "Rebuild the VM on the target from configuration management and copy its data, or use a disk replication tool. Choose per VM.",
    providerNative: false,
    needsDecision: true,
  },
  "sql-database": {
    id: "dump-and-restore",
    description:
      "Dump and restore (pg_dump/pg_restore, mysqldump) during a write freeze, or logical replication for a short cutover.",
    providerNative: false,
    needsDecision: true,
  },
  "container-registry": {
    id: "image-copy",
    description:
      "Copy every tag registry-to-registry (crane copy or skopeo sync) from a host with credentials for both; digests are preserved.",
    providerNative: false,
    needsDecision: false,
  },
  "file-share": {
    id: "nfs-rsync",
    description:
      "Mount both shares on one host and rsync; repeat for a final delta during the write freeze.",
    providerNative: false,
    needsDecision: true,
  },
  "nosql-table": {
    id: "export-transform-import",
    description:
      "Export the table, transform it to the target's data model, and import it; replay changes made since the export.",
    providerNative: false,
    needsDecision: true,
  },
  "dns-zone": {
    id: "delegation-switch",
    description:
      "Recreate the records on the target, lower TTLs ahead of time, then change the registrar's name servers at cutover.",
    providerNative: false,
    needsDecision: false,
  },
  "dns-record": {
    id: "recreate",
    description:
      "Recreate the record in the target zone; values pointing at migrated resources change at cutover.",
    providerNative: false,
    needsDecision: false,
  },
  secret: {
    id: "vault-copy",
    description:
      "Read each value into a swamp vault and write it to the target secret store; never through plan data. Rotate at the source after cutover.",
    providerNative: false,
    needsDecision: false,
  },
  cache: {
    id: "warm-on-cutover",
    description:
      "Caches are rebuilt, not copied: point clients at the target and let it warm, or import an RDB snapshot where both sides allow it.",
    providerNative: false,
    needsDecision: false,
  },
  "message-queue": {
    id: "drain-and-switch",
    description:
      "Point producers at the target, let consumers drain the source, then switch consumers.",
    providerNative: false,
    needsDecision: false,
  },
};

const CONFIG_ONLY: TransferStrategy = {
  id: "recreate-config",
  description:
    "No data to move: the target is created from the mapped configuration.",
  providerNative: true,
  needsDecision: false,
};

/** The recommended data transfer for a kind between two providers. */
export function transferStrategy(
  kind: ResourceKind,
  from: string,
  to: string,
): TransferStrategy {
  const pair = PAIR_STRATEGIES[`${kind}:${from}>${to}`];
  if (pair) return pair;
  if (from === to && kind === "object-bucket") {
    return {
      id: "same-provider-copy",
      description:
        "Same provider: use its own replication or transfer service (S3 Batch Replication, GCS Storage Transfer).",
      providerNative: true,
      needsDecision: false,
    };
  }
  return KIND_STRATEGIES[kind] ?? CONFIG_ONLY;
}

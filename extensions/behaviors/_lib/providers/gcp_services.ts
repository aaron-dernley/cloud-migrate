/**
 * Google Cloud managed data, messaging, serverless, keys, secrets and IAM adapters.
 * See ../kinds.ts for the canonical shapes and ../adapter.ts for the contract.
 *
 * Every adapter reads the `state` data the official `@swamp/gcp/*` behaviors
 * write (the Google REST API's JSON) and renders their global arguments. The
 * behaviors differ in how they name things, so each kind notes what its
 * `name` global means:
 *
 * - `{+parent}` collections (Artifact Registry, Cloud Functions, Memorystore,
 *   Filestore, Firestore, Secret Manager, Cloud KMS): `name` is the short id
 *   and the behavior builds the full path from `project` + `location`.
 * - Pub/Sub: `name` is the full `projects/<p>/topics/<t>` path.
 * - IAM service accounts: `name` is `projects/<p>` and `accountId` the id.
 * - Cloud SQL: `name` is the instance name, `region` the region.
 *
 * Nothing here reads, stores or renders a secret value or a database password.
 *
 * @module
 */
import {
  arr,
  bool,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  lastSegment,
  num,
  obj,
  type ProviderAdapter,
  type RenderContext,
  type RenderResult,
  type ResourceRef,
  str,
  stringMap,
  type TargetSettings,
  toGcpLabels,
  track,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { firstZoneOf } from "./gcp_infra.ts";

// ---------------------------------------------------------------------------
// Shared helpers

/** The segment after `key/` in a resource path (`locations/europe-west2` → `europe-west2`). */
function pathPart(name: string | null, key: string): string | null {
  return name?.match(new RegExp(`(?:^|/)${key}/([^/]+)`))?.[1] ?? null;
}

/** A zone (`us-central1-a`) as its region (`us-central1`); regions pass through. */
function regionOf(location: string | null): string | null {
  if (!location) return null;
  return /^[a-z]+(?:-[a-z]+)+\d+-[a-z]$/.test(location)
    ? location.replace(/-[a-z]$/, "")
    : location;
}

/** `"604800s"` → 604800. */
function seconds(value: unknown): number | null {
  const s = str(value);
  return s ? num(s.replace(/s$/, "")) : null;
}

/** A `{ kind, nativeId, via }` ref, or no ref when the id is missing. */
function ref(
  kind: ResourceKind,
  nativeId: unknown,
  via: string,
): ResourceRef[] {
  const id = str(nativeId);
  return id ? [{ kind, nativeId: id, via }] : [];
}

/** The resource's labels as GCP label rules allow, pushing a loss per rewrite. */
function gcpLabels(
  p: Record<string, unknown>,
  losses: string[],
): Record<string, string> {
  const converted = toGcpLabels(stringMap(p.labels));
  losses.push(...converted.losses);
  return converted.labels;
}

/** Adds `project` to the arguments, or a decision when the target names none. */
function withProject(
  args: Record<string, unknown>,
  target: TargetSettings,
  decisions: string[],
  what: string,
): void {
  if (target.project) args.project = target.project;
  else decisions.push(`target.project is required to create ${what}`);
}

/** A string property, or null. */
function strProp(p: Record<string, unknown>, key: string): string | null {
  return str(p[key]);
}

/**
 * The first migrated network as Cloud SQL, Memorystore and Filestore want it:
 * `projects/<p>/global/networks/<name>` ("path") or the bare name ("name").
 * The network adapter's idField is a selfLink URL, which these APIs do not
 * take, but the target network's name is known at plan time, so it is
 * written out directly.
 */
function networkFor(
  context: RenderContext,
  project: string | undefined,
  form: "path" | "name",
  decisions: string[],
): string | null {
  const ids = context.dependencies("network");
  if (ids.length > 1) {
    decisions.push(
      `depends on ${ids.length} network resources; the first (${
        ids[0]
      }) is used, confirm it is the one wanted`,
    );
  }
  const name = ids.length > 0 ? context.targetNameOf(ids[0]) : null;
  if (!name) return null;
  if (form === "name") return name;
  return `projects/${project ?? "<project>"}/global/networks/${name}`;
}

/** The CEL expression for the first dependency of `kind`, with a decision when there are several. */
function firstDependency(
  context: RenderContext,
  kind: ResourceKind,
  field: string | undefined,
  decisions: string[],
): string | null {
  const ids = context.dependencies(kind);
  if (ids.length > 1) {
    decisions.push(
      `depends on ${ids.length} ${kind} resources; the first (${
        ids[0]
      }) is used, confirm it is the one wanted`,
    );
  }
  return ids.length > 0 ? context.refTo(ids[0], field) : null;
}

/** Whole-string pattern check used by the name validators. */
function nameProblems(
  name: string,
  rule: RegExp,
  min: number,
  max: number,
  text: string,
): string[] {
  const problems: string[] = [];
  if (name.length < min || name.length > max) {
    problems.push(`"${name}" must be ${min}-${max} characters on Google Cloud`);
  }
  if (!rule.test(name)) problems.push(`"${name}" ${text}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Cloud SQL

/** Database versions the `sqladmin` instances schema accepts (the ones render can pick). */
const SQL_VERSIONS = new Set([
  "MYSQL_5_6",
  "MYSQL_5_7",
  "MYSQL_8_0",
  "MYSQL_8_4",
  "MYSQL_9_7",
  "POSTGRES_9_6",
  "POSTGRES_10",
  "POSTGRES_11",
  "POSTGRES_12",
  "POSTGRES_13",
  "POSTGRES_14",
  "POSTGRES_15",
  "POSTGRES_16",
  "POSTGRES_17",
  "POSTGRES_18",
  "SQLSERVER_2017_STANDARD",
  "SQLSERVER_2019_STANDARD",
  "SQLSERVER_2022_STANDARD",
  "SQLSERVER_2025_STANDARD",
]);

/** `POSTGRES_15` → postgres 15, `MYSQL_8_0_36` → mysql 8.0, `SQLSERVER_2019_STANDARD` → sqlserver 2019. */
function parseSqlVersion(
  v: string | null,
): { engine: string; version: string } | null {
  if (!v) return null;
  let m = v.match(/^POSTGRES_(\d+)(?:_(\d+))?$/);
  if (m) {
    return {
      engine: "postgres",
      version: Number(m[1]) < 10 && m[2] ? `${m[1]}.${m[2]}` : m[1],
    };
  }
  m = v.match(/^MYSQL_(\d+)_(\d+)/);
  if (m) return { engine: "mysql", version: `${m[1]}.${m[2]}` };
  m = v.match(/^SQLSERVER_(\d{4})/);
  if (m) return { engine: "sqlserver", version: m[1] };
  return null;
}

/** vCPUs and memory implied by a Cloud SQL tier name, or null for tiers this does not know. */
function sizeOfTier(tier: string): { vcpus: number; memoryMiB: number } | null {
  if (tier === "db-f1-micro") return { vcpus: 1, memoryMiB: 614 };
  if (tier === "db-g1-small") return { vcpus: 1, memoryMiB: 1740 };
  let m = tier.match(/^db-custom-(\d+)-(\d+)$/);
  if (m) return { vcpus: Number(m[1]), memoryMiB: Number(m[2]) };
  // Enterprise Plus: 8 GiB per vCPU.
  m = tier.match(/^db-perf-optimized-N-(\d+)$/);
  if (m) return { vcpus: Number(m[1]), memoryMiB: Number(m[1]) * 8192 };
  m = tier.match(/^db-n1-(standard|highmem)-(\d+)$/);
  if (m) {
    return {
      vcpus: Number(m[2]),
      memoryMiB: Number(m[2]) * (m[1] === "standard" ? 3840 : 6656),
    };
  }
  return null;
}

/**
 * Picks a Cloud SQL tier for a size. Rule: <= 1 vCPU and <= 614 MiB is
 * `db-f1-micro`; <= 1 vCPU and <= 1740 MiB is `db-g1-small` (shared core,
 * MySQL and PostgreSQL only); anything else is `db-custom-<vcpus>-<MiB>`
 * with vCPUs 1 or an even number (up to 96), memory a multiple of 256 MiB,
 * at least 3840 MiB, at least 0.9 GiB and at most 6.5 GiB per vCPU, raising
 * whichever of the two the request violates.
 */
function chooseSqlTier(
  vcpus: number,
  memoryMiB: number,
  engine: string,
): { tier: string; vcpus: number; memoryMiB: number } {
  if (engine !== "sqlserver" && vcpus <= 1) {
    if (memoryMiB <= 614) {
      return { tier: "db-f1-micro", vcpus: 1, memoryMiB: 614 };
    }
    if (memoryMiB <= 1740) {
      return { tier: "db-g1-small", vcpus: 1, memoryMiB: 1740 };
    }
  }
  let n = Math.max(1, Math.ceil(vcpus));
  if (n > 1 && n % 2 === 1) n += 1;
  while (memoryMiB > 6656 * n && n < 96) n = n === 1 ? 2 : n + 2;
  const floor = Math.max(3840, Math.ceil((0.9 * 1024 * n) / 256) * 256);
  const m = Math.min(
    Math.ceil(Math.max(memoryMiB, floor) / 256) * 256,
    6656 * n,
  );
  return { tier: `db-custom-${n}-${m}`, vcpus: n, memoryMiB: m };
}

/** The `databaseVersion` for an engine and version, with a loss or decision when inexact. */
function sqlDatabaseVersion(
  engine: string | null,
  version: string | null,
  losses: string[],
  decisions: string[],
): string | null {
  if (!engine) {
    decisions.push(
      "the source database engine is unknown: choose POSTGRES_*, MYSQL_* or SQLSERVER_* databaseVersion",
    );
    return null;
  }
  const m = version?.match(/^(\d+)(?:\.(\d+))?/);
  let candidate: string | null = null;
  if (engine === "postgres" && m) {
    candidate = Number(m[1]) < 10 && m[2]
      ? `POSTGRES_${m[1]}_${m[2]}`
      : `POSTGRES_${m[1]}`;
  } else if (engine === "mysql" && m) {
    candidate = `MYSQL_${m[1]}_${m[2] ?? "0"}`;
    if (!m[2]) {
      losses.push(
        `MySQL ${version} becomes ${candidate} (minor version assumed)`,
      );
    }
  } else if (engine === "sqlserver" && m) {
    candidate = `SQLSERVER_${m[1]}_STANDARD`;
    losses.push(
      `SQL Server edition is set to Standard (${candidate}); change it if the source used another edition`,
    );
  } else if (engine === "mariadb" || engine === "oracle") {
    decisions.push(
      `Cloud SQL does not offer ${engine}: choose PostgreSQL or MySQL and plan a schema migration`,
    );
    return null;
  }
  if (candidate && SQL_VERSIONS.has(candidate)) return candidate;
  decisions.push(
    `Cloud SQL does not offer ${engine} ${
      version ?? "(unknown version)"
    }: choose a databaseVersion it does`,
  );
  return null;
}

const sqlDatabase: KindAdapter = {
  behaviorType: "@swamp/gcp/sqladmin/instances",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const parsed = parseSqlVersion(str(a.databaseVersion));
    const engine = track(unknownFields, "engine", parsed?.engine ?? null);
    const engineVersion = track(
      unknownFields,
      "engineVersion",
      parsed?.version ?? null,
    );

    const settings = obj(a.settings);
    const tier = track(unknownFields, "instanceClass", str(settings?.tier));
    const size = tier ? sizeOfTier(tier) : null;
    if (tier && !size) unknownFields.push("vcpus", "memoryMiB");
    const storageGiB = track(
      unknownFields,
      "storageGiB",
      num(settings?.dataDiskSizeGb),
    );
    const availability = str(settings?.availabilityType);
    const highAvailability = availability === null
      ? null
      : availability === "REGIONAL";
    if (highAvailability === null) unknownFields.push("highAvailability");

    // A disabled backup configuration retains nothing; otherwise the retained count (daily backups).
    const backup = obj(settings?.backupConfiguration);
    const backupRetentionDays = backup
      ? backup.enabled === false
        ? 0
        : num(obj(backup.backupRetentionSettings)?.retainedBackups)
      : null;
    if (backupRetentionDays === null) unknownFields.push("backupRetentionDays");

    const ip = obj(settings?.ipConfiguration);
    const publicAccess = bool(ip?.ipv4Enabled);
    if (publicAccess === null) unknownFields.push("publicAccess");

    const region = str(a.region) ?? regionFallback;
    if (region === null) unknownFields.push("region");

    return {
      id: canonicalId("gcp", "sql-database", name),
      provider: "gcp",
      kind: "sql-database",
      nativeId: name,
      aliases: [str(a.connectionName), str(a.selfLink)].filter((
        x,
      ): x is string => x !== null),
      name,
      region,
      source: { behaviorType: sqlDatabase.behaviorType, behaviorName },
      properties: {
        engine,
        engineVersion,
        instanceClass: tier,
        vcpus: size?.vcpus ?? null,
        memoryMiB: size?.memoryMiB ?? null,
        storageGiB,
        highAvailability,
        backupRetentionDays,
        publicAccess,
        labels: stringMap(settings?.userLabels),
      },
      refs: [
        ...ref(
          "network",
          ip?.privateNetwork,
          "settings.ipConfiguration.privateNetwork",
        ),
        ...ref(
          "kms-key",
          obj(a.diskEncryptionConfiguration)?.kmsKeyName,
          "diskEncryptionConfiguration.kmsKeyName",
        ),
      ],
      dependsOn: [],
      dataBytes: storageGiB !== null ? storageGiB * 1024 ** 3 : null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const engine = strProp(p, "engine");
    const version = sqlDatabaseVersion(
      engine,
      strProp(p, "engineVersion"),
      losses,
      decisions,
    );

    const globalArguments: Record<string, unknown> = {
      name: targetName,
      region: target.region,
    };
    withProject(globalArguments, target, decisions, "a Cloud SQL instance");
    if (version) globalArguments.databaseVersion = version;

    // Sizing: a Cloud SQL source keeps its tier; everything else is mapped from vCPUs and memory.
    const settings: Record<string, unknown> = {};
    let tier: string | null = null;
    let vcpus: number | null = null;
    let memoryMiB: number | null = null;
    const sourceTier = strProp(p, "instanceClass");
    if (resource.provider === "gcp" && sourceTier && sizeOfTier(sourceTier)) {
      tier = sourceTier;
      ({ vcpus, memoryMiB } = sizeOfTier(sourceTier)!);
    } else if (typeof p.vcpus === "number" && typeof p.memoryMiB === "number") {
      const chosen = chooseSqlTier(p.vcpus, p.memoryMiB, engine ?? "");
      tier = chosen.tier;
      vcpus = chosen.vcpus;
      memoryMiB = chosen.memoryMiB;
      losses.push(
        `compute is sized as ${tier} (${vcpus} vCPU, ${memoryMiB} MiB) for ${p.vcpus} vCPU / ${p.memoryMiB} MiB: ` +
          "shared-core tiers for tiny sizes, otherwise db-custom-<vcpus>-<MiB> with an even vCPU count and 0.9-6.5 GiB per vCPU in 256 MiB steps",
      );
    } else {
      decisions.push(
        "the source database size (vCPUs and memory) is unknown: choose a settings.tier",
      );
    }
    if (tier) {
      settings.tier = tier;
      settings.edition = tier.startsWith("db-perf-optimized")
        ? "ENTERPRISE_PLUS"
        : "ENTERPRISE";
    }

    const storageGiB = typeof p.storageGiB === "number"
      ? Math.max(Math.ceil(p.storageGiB), 10)
      : null;
    if (storageGiB !== null) {
      settings.dataDiskSizeGb = String(storageGiB);
      settings.dataDiskType = "PD_SSD";
      if (storageGiB !== p.storageGiB) {
        losses.push(
          `storage is raised from ${p.storageGiB} to ${storageGiB} GiB (Cloud SQL minimum, whole GiB)`,
        );
      }
    } else {
      decisions.push(
        "the source storage size is unknown: choose settings.dataDiskSizeGb",
      );
    }

    if (typeof p.highAvailability === "boolean") {
      settings.availabilityType = p.highAvailability ? "REGIONAL" : "ZONAL";
    }

    let retained: number | null = null;
    if (typeof p.backupRetentionDays === "number") {
      retained = Math.min(Math.max(Math.round(p.backupRetentionDays), 0), 365);
      settings.backupConfiguration = retained > 0
        ? {
          enabled: true,
          backupRetentionSettings: {
            retainedBackups: retained,
            retentionUnit: "COUNT",
          },
        }
        : { enabled: false };
      if (retained !== p.backupRetentionDays) {
        losses.push(
          `backup retention ${p.backupRetentionDays} days becomes ${retained} (Cloud SQL keeps 1-365 daily backups)`,
        );
      }
    }

    // Network: public IP or private IP on the migrated VPC.
    let publicAccess: boolean | null = null;
    if (typeof p.publicAccess === "boolean") {
      publicAccess = p.publicAccess;
      const ipConfiguration: Record<string, unknown> = {
        ipv4Enabled: publicAccess,
      };
      if (publicAccess) {
        losses.push(
          "the public IP has no authorizedNetworks: add the client ranges that may connect",
        );
      } else {
        const network = networkFor(context, target.project, "path", decisions);
        if (network) {
          ipConfiguration.privateNetwork = network;
          decisions.push(
            "the private-IP instance needs Private Service Access on this network (an allocated peering range and a service networking connection); set that up before creating it",
          );
        } else {
          decisions.push(
            "a private-IP Cloud SQL instance needs a VPC with Private Service Access: add the network to the migration or set ipConfiguration.privateNetwork",
          );
        }
      }
      settings.ipConfiguration = ipConfiguration;
    }

    const kms = firstDependency(context, "kms-key", undefined, decisions);
    if (kms) globalArguments.diskEncryptionConfiguration = { kmsKeyName: kms };

    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) settings.userLabels = labels;
    if (Object.keys(settings).length > 0) globalArguments.settings = settings;

    // Credentials never come from the plan.
    decisions.push(
      "the root/user password is not planned: after creating the target behavior, set rootPassword (and database users) in its definition as a swamp vault expression, e.g. ${{ vault.get(<vault>, <key>) }}, never through resolve, and move data with Database Migration Service or a dump",
    );

    return {
      behaviorType: sqlDatabase.behaviorType,
      globalArguments,
      expected: {
        engine: engine === "mariadb" || engine === "oracle" ? null : engine,
        engineVersion: version
          ? parseSqlVersion(version)?.version ?? null
          : null,
        instanceClass: tier,
        vcpus,
        memoryMiB,
        storageGiB,
        highAvailability: typeof p.highAvailability === "boolean"
          ? p.highAvailability
          : null,
        backupRetentionDays: retained,
        publicAccess,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems = nameProblems(
      name,
      /^[a-z][a-z0-9-]*$/,
      1,
      98,
      "must start with a lowercase letter and use only lowercase letters, digits and hyphens on Cloud SQL",
    );
    if (name.endsWith("-")) {
      problems.push(`"${name}" must not end with a hyphen on Cloud SQL`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// Artifact Registry

const containerRegistry: KindAdapter = {
  behaviorType: "@swamp/gcp/artifactregistry/repositories",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const docker = obj(a.dockerConfig);
    const immutableTags = docker ? docker.immutableTags === true : false;
    const scanState = str(obj(a.vulnerabilityScanningConfig)?.enablementState);
    const scanOnPush = scanState === null
      ? null
      : scanState === "SCANNING_ACTIVE";
    if (scanOnPush === null) unknownFields.push("scanOnPush");
    const region = pathPart(path, "locations") ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("gcp", "container-registry", path),
      provider: "gcp",
      kind: "container-registry",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region,
      source: { behaviorType: containerRegistry.behaviorType, behaviorName },
      properties: {
        name,
        immutableTags,
        scanOnPush,
        labels: stringMap(a.labels),
      },
      refs: ref("kms-key", a.kmsKeyName, "kmsKeyName"),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      repositoryId: targetName,
      location: target.region,
      format: "DOCKER",
      mode: "STANDARD_REPOSITORY",
    };
    withProject(
      globalArguments,
      target,
      decisions,
      "an Artifact Registry repository",
    );
    if (typeof p.immutableTags === "boolean") {
      globalArguments.dockerConfig = { immutableTags: p.immutableTags };
    }
    if (p.scanOnPush === true) {
      globalArguments.vulnerabilityScanningConfig = {
        enablementConfig: "INHERITED",
      };
      losses.push(
        "scanning is enabled by the project's Artifact Analysis API, not per push: turn that API on in the target project",
      );
    }
    const kms = firstDependency(context, "kms-key", undefined, decisions);
    if (kms) globalArguments.kmsKeyName = kms;
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    losses.push(
      "images are not copied: push them to the new repository (for example with crane copy)",
    );
    return {
      behaviorType: containerRegistry.behaviorType,
      globalArguments,
      expected: {
        name: targetName,
        immutableTags: typeof p.immutableTags === "boolean"
          ? p.immutableTags
          : null,
        scanOnPush: p.scanOnPush === true ? true : null,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z]([a-z0-9-]*[a-z0-9])?$/,
      3,
      63,
      "must start with a lowercase letter, end with a letter or digit and use only lowercase letters, digits and hyphens in Artifact Registry",
    );
  },
};

// ---------------------------------------------------------------------------
// Pub/Sub

/** Topic and subscription ids: start with a letter, letters/digits and `-_.~+%`, not `goog` prefixed. */
function pubsubNameProblems(name: string): string[] {
  const problems = nameProblems(
    name,
    /^[A-Za-z][A-Za-z0-9\-_.~+%]*$/,
    3,
    255,
    "must start with a letter and use only letters, digits and - _ . ~ + % in Pub/Sub",
  );
  if (name.startsWith("goog")) {
    problems.push(`"${name}" must not start with "goog" in Pub/Sub`);
  }
  return problems;
}

const messageTopic: KindAdapter = {
  behaviorType: "@swamp/gcp/pubsub/topics",
  idField: "name",
  normalise(a, behaviorName): CanonicalResource {
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    return {
      id: canonicalId("gcp", "message-topic", path),
      provider: "gcp",
      kind: "message-topic",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      // Topics are global; they have no region of their own.
      region: null,
      source: { behaviorType: messageTopic.behaviorType, behaviorName },
      // Pub/Sub orders per ordering key on subscriptions, not on the topic.
      properties: { name, ordered: false, labels: stringMap(a.labels) },
      refs: ref("kms-key", a.kmsKeyName, "kmsKeyName"),
      dependsOn: [],
      dataBytes: null,
      unknownFields: [],
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {};
    withProject(globalArguments, target, decisions, "a Pub/Sub topic");
    globalArguments.name = `projects/${
      target.project ?? "<project>"
    }/topics/${targetName}`;
    const kms = firstDependency(context, "kms-key", undefined, decisions);
    if (kms) globalArguments.kmsKeyName = kms;
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    if (p.ordered === true) {
      losses.push(
        "a Pub/Sub topic has no FIFO flag: publishers set an ordering key and the subscriptions enable message ordering",
      );
    }
    return {
      behaviorType: messageTopic.behaviorType,
      globalArguments,
      expected: { name: targetName, ordered: false, labels },
      losses,
      decisions,
    };
  },
  validateName: pubsubNameProblems,
};

const messageQueue: KindAdapter = {
  behaviorType: "@swamp/gcp/pubsub/subscriptions",
  idField: "name",
  normalise(a, behaviorName): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const visibility = track(
      unknownFields,
      "visibilityTimeoutSeconds",
      num(a.ackDeadlineSeconds),
    );
    const retention = track(
      unknownFields,
      "retentionSeconds",
      seconds(a.messageRetentionDuration),
    );
    const dlq = obj(a.deadLetterPolicy);
    const topic = str(a.topic);
    return {
      id: canonicalId("gcp", "message-queue", path),
      provider: "gcp",
      kind: "message-queue",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region: null,
      source: { behaviorType: messageQueue.behaviorType, behaviorName },
      properties: {
        name,
        ordered: a.enableMessageOrdering === true,
        visibilityTimeoutSeconds: visibility,
        retentionSeconds: retention,
        deadLetter: dlq !== null,
        labels: stringMap(a.labels),
      },
      refs: [
        // A deleted topic is reported as `_deleted-topic_`; there is nothing to depend on.
        ...(topic === "_deleted-topic_"
          ? []
          : ref("message-topic", topic, "topic")),
        ...ref(
          "message-topic",
          dlq?.deadLetterTopic,
          "deadLetterPolicy.deadLetterTopic",
        ),
      ],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {};
    withProject(globalArguments, target, decisions, "a Pub/Sub subscription");
    globalArguments.name = `projects/${
      target.project ?? "<project>"
    }/subscriptions/${targetName}`;

    // Separate the dead-letter topic (by its ref) from the topic the subscription reads.
    const topicIds = context.dependencies("message-topic");
    const dlqRef = resource.refs.find((r) =>
      r.via === "deadLetterPolicy.deadLetterTopic"
    );
    const dlqId = dlqRef
      ? canonicalId(resource.provider, "message-topic", dlqRef.nativeId)
      : null;
    const sourceTopics = topicIds.filter((id) => id !== dlqId);
    if (sourceTopics.length === 0) {
      decisions.push(
        "a Pub/Sub subscription needs a topic: create a topic (add one to the migration) or choose an existing one and set `topic` to projects/<project>/topics/<topic>",
      );
    } else {
      if (sourceTopics.length > 1) {
        decisions.push(
          `depends on ${sourceTopics.length} topics; the first (${
            sourceTopics[0]
          }) is used, confirm it is the one wanted`,
        );
      }
      const topic = context.refTo(sourceTopics[0]);
      if (topic) globalArguments.topic = topic;
    }

    if (typeof p.visibilityTimeoutSeconds === "number") {
      const ack = Math.min(
        Math.max(Math.round(p.visibilityTimeoutSeconds), 10),
        600,
      );
      globalArguments.ackDeadlineSeconds = ack;
      if (ack !== p.visibilityTimeoutSeconds) {
        losses.push(
          `visibility timeout ${p.visibilityTimeoutSeconds}s becomes an ack deadline of ${ack}s (Pub/Sub allows 10-600s)`,
        );
      }
    }
    let retention: number | null = null;
    if (typeof p.retentionSeconds === "number") {
      retention = Math.min(
        Math.max(Math.round(p.retentionSeconds), 600),
        604800,
      );
      globalArguments.messageRetentionDuration = `${retention}s`;
      if (retention !== p.retentionSeconds) {
        losses.push(
          `retention ${p.retentionSeconds}s becomes ${retention}s (Pub/Sub keeps 10 minutes to 7 days)`,
        );
      }
    }
    if (p.ordered === true) globalArguments.enableMessageOrdering = true;

    if (p.deadLetter === true) {
      const dlqTopic = dlqId ? context.refTo(dlqId) : null;
      if (dlqTopic) {
        globalArguments.deadLetterPolicy = {
          deadLetterTopic: dlqTopic,
          maxDeliveryAttempts: 5,
        };
        losses.push(
          "the dead-letter policy uses 5 delivery attempts (the source count is not carried); grant the Pub/Sub service account publish on the dead-letter topic",
        );
      } else {
        decisions.push(
          "the source has a dead-letter target: create a dead-letter topic and set deadLetterPolicy.deadLetterTopic and maxDeliveryAttempts",
        );
      }
    }

    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    return {
      behaviorType: messageQueue.behaviorType,
      globalArguments,
      expected: {
        name: targetName,
        ordered: p.ordered === true,
        visibilityTimeoutSeconds:
          typeof globalArguments.ackDeadlineSeconds === "number"
            ? globalArguments.ackDeadlineSeconds
            : null,
        retentionSeconds: retention,
        deadLetter: globalArguments.deadLetterPolicy !== undefined,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName: pubsubNameProblems,
};

// ---------------------------------------------------------------------------
// Cloud Functions (2nd gen)

/** GCP runtime id → canonical runtime: `python312` → `python3.12`, `nodejs20` → `nodejs20`. */
function canonicalRuntime(runtime: string | null): string | null {
  if (!runtime) return null;
  let m = runtime.match(/^python(3)(\d+)$/);
  if (m) return `python${m[1]}.${m[2]}`;
  m = runtime.match(/^go(1)(\d+)$/);
  if (m) return `go${m[1]}.${m[2]}`;
  m = runtime.match(/^ruby(\d)(\d)$/);
  if (m) return `ruby${m[1]}.${m[2]}`;
  m = runtime.match(/^php(\d)(\d)$/);
  if (m) return `php${m[1]}.${m[2]}`;
  return runtime;
}

/** Runtimes 2nd gen Cloud Functions offers (the ones render can pick). */
const GCP_RUNTIMES = new Set([
  "python39",
  "python310",
  "python311",
  "python312",
  "python313",
  "nodejs18",
  "nodejs20",
  "nodejs22",
  "go121",
  "go122",
  "go123",
  "go124",
  "java11",
  "java17",
  "java21",
  "dotnet6",
  "dotnet8",
  "ruby32",
  "ruby33",
  "ruby34",
  "php82",
  "php83",
]);

/** A canonical runtime (`python3.12`, `nodejs20.x`) as a GCP runtime id, or null when not offered. */
function gcpRuntime(runtime: string | null): string | null {
  if (!runtime) return null;
  const r = runtime.toLowerCase().replace(/\.x$/, "");
  const m = r.match(/^(python|go|ruby|php)(\d+)\.(\d+)$/);
  const id = m ? `${m[1]}${m[2]}${m[3]}` : r.replace(/[.-]/g, "");
  return GCP_RUNTIMES.has(id) ? id : null;
}

/** `"256M"`, `"512Mi"`, `"1Gi"` → MiB (decimal and binary suffixes are treated alike, as Cloud Run does). */
function memoryToMiB(value: unknown): number | null {
  const s = str(value);
  const m = s?.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2].toUpperCase()) {
    case "K":
      return n / 1024;
    case "M":
      return n;
    case "G":
      return n * 1024;
    case "T":
      return n * 1024 * 1024;
    default:
      return n / (1024 * 1024);
  }
}

const fn: KindAdapter = {
  behaviorType: "@swamp/gcp/cloudfunctions/functions",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const build = obj(a.buildConfig);
    const service = obj(a.serviceConfig);
    const runtime = track(
      unknownFields,
      "runtime",
      canonicalRuntime(str(build?.runtime)),
    );
    const memoryMiB = track(
      unknownFields,
      "memoryMiB",
      memoryToMiB(service?.availableMemory),
    );
    const timeoutSeconds = track(
      unknownFields,
      "timeoutSeconds",
      num(service?.timeoutSeconds),
    );
    const entryPoint = track(
      unknownFields,
      "entryPoint",
      str(build?.entryPoint),
    );
    const region = pathPart(path, "locations") ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("gcp", "function", path),
      provider: "gcp",
      kind: "function",
      nativeId: path,
      aliases: [name, str(service?.uri)].filter((x): x is string => !!x),
      name,
      region,
      source: { behaviorType: fn.behaviorType, behaviorName },
      properties: {
        runtime,
        memoryMiB,
        timeoutSeconds,
        entryPoint,
        labels: stringMap(a.labels),
      },
      refs: [
        ...ref(
          "iam-principal",
          service?.serviceAccountEmail,
          "serviceConfig.serviceAccountEmail",
        ),
        // serviceConfig.vpcConnector is a connectors/ path, not a network: no ref (see the render decision).
        ...ref("kms-key", a.kmsKeyName, "kmsKeyName"),
      ],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      functionId: targetName,
      location: target.region,
      environment: "GEN_2",
    };
    withProject(globalArguments, target, decisions, "a Cloud Function");

    const build: Record<string, unknown> = {};
    const sourceRuntime = strProp(p, "runtime");
    const runtime = gcpRuntime(sourceRuntime);
    if (runtime) build.runtime = runtime;
    else {
      decisions.push(
        `Cloud Functions does not offer runtime ${
          sourceRuntime ?? "(unknown)"
        }: choose a supported runtime and port the code`,
      );
    }
    const entryPoint = strProp(p, "entryPoint");
    if (entryPoint) {
      build.entryPoint = entryPoint;
      losses.push(
        "the handler string is copied as the entry point; Cloud Functions expects a function name, not a module.handler path",
      );
    }
    globalArguments.buildConfig = build;
    decisions.push(
      "buildConfig.source is required to deploy: point it at the function's source in Cloud Storage or a repository; no code is migrated",
    );

    const service: Record<string, unknown> = {};
    let memory: number | null = null;
    if (typeof p.memoryMiB === "number") {
      memory = Math.min(Math.max(Math.round(p.memoryMiB), 128), 32768);
      service.availableMemory = `${memory}Mi`;
      if (memory !== p.memoryMiB) {
        losses.push(
          `memory ${p.memoryMiB} MiB becomes ${memory} MiB (Cloud Functions allows 128 MiB to 32 GiB)`,
        );
      }
    }
    if (typeof p.timeoutSeconds === "number") {
      const timeout = Math.min(Math.max(Math.round(p.timeoutSeconds), 1), 3600);
      service.timeoutSeconds = timeout;
      if (timeout !== p.timeoutSeconds) {
        losses.push(
          `timeout ${p.timeoutSeconds}s becomes ${timeout}s (HTTP functions allow up to 3600s)`,
        );
      }
    }
    const account = firstDependency(
      context,
      "iam-principal",
      "email",
      decisions,
    );
    if (account) service.serviceAccountEmail = account;
    if (
      context.dependencies("network").length > 0 ||
      context.dependencies("subnet").length > 0
    ) {
      decisions.push(
        "reaching a VPC needs a Serverless VPC Access connector: create one in the target network and set serviceConfig.vpcConnector",
      );
    }
    if (Object.keys(service).length > 0) {
      globalArguments.serviceConfig = service;
    }

    const kms = firstDependency(context, "kms-key", undefined, decisions);
    if (kms) globalArguments.kmsKeyName = kms;
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    losses.push(
      "environment variables and triggers are not carried over; add them (secrets through Secret Manager) when deploying",
    );
    return {
      behaviorType: fn.behaviorType,
      globalArguments,
      expected: {
        runtime: canonicalRuntime(runtime),
        memoryMiB: memory,
        timeoutSeconds: typeof service.timeoutSeconds === "number"
          ? service.timeoutSeconds
          : null,
        entryPoint,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z]([a-z0-9-]*[a-z0-9])?$/,
      4,
      63,
      "must start with a lowercase letter, end with a letter or digit and use only lowercase letters, digits and hyphens for a Cloud Function",
    );
  },
};

// ---------------------------------------------------------------------------
// Memorystore for Redis

/** Redis versions Memorystore for Redis offers. */
const REDIS_VERSIONS = new Set([
  "REDIS_3_2",
  "REDIS_4_0",
  "REDIS_5_0",
  "REDIS_6_X",
  "REDIS_7_0",
  "REDIS_7_2",
]);

/** `REDIS_7_2` → `7.2`, `REDIS_6_X` → `6.x`. */
function redisVersionToCanonical(v: string | null): string | null {
  const m = v?.match(/^REDIS_(\d+)_(\w+)$/);
  return m ? `${m[1]}.${m[2].toLowerCase()}` : null;
}

const cache: KindAdapter = {
  behaviorType: "@swamp/gcp/redis/instances",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const engineVersion = track(
      unknownFields,
      "engineVersion",
      redisVersionToCanonical(str(a.redisVersion)),
    );
    const memoryGiB = track(unknownFields, "memoryGiB", num(a.memorySizeGb));
    // STANDARD_HA keeps a primary plus `replicaCount` replicas (default 1); BASIC is one node.
    const tier = str(a.tier);
    const nodes = tier === null
      ? null
      : tier === "STANDARD_HA"
      ? 1 + (num(a.replicaCount) ?? 1)
      : 1;
    if (nodes === null) unknownFields.push("nodes");
    const region = pathPart(path, "locations") ?? regionOf(str(a.locationId)) ??
      regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("gcp", "cache", path),
      provider: "gcp",
      kind: "cache",
      nativeId: path,
      aliases: [name, str(a.host)].filter((x): x is string => !!x),
      name,
      region,
      source: { behaviorType: cache.behaviorType, behaviorName },
      properties: {
        engine: "redis",
        engineVersion,
        memoryGiB,
        nodes,
        labels: stringMap(a.labels),
      },
      refs: [
        ...ref("network", a.authorizedNetwork, "authorizedNetwork"),
        ...ref("kms-key", a.customerManagedKey, "customerManagedKey"),
      ],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      instanceId: targetName,
      location: target.region,
    };
    withProject(globalArguments, target, decisions, "a Memorystore instance");

    const engine = strProp(p, "engine");
    if (engine !== null && engine !== "redis") {
      decisions.push(
        `Memorystore for Redis runs Redis only: the source engine is ${engine}; use Memorystore for ${
          engine === "memcached" ? "Memcached" : "Valkey"
        } or switch the clients to Redis`,
      );
    }

    let redisVersion: string | null = null;
    const version = strProp(p, "engineVersion");
    if (version) {
      const m = version.match(/^(\d+)(?:\.(\w+))?/);
      const exact = m ? `REDIS_${m[1]}_${(m[2] ?? "").toUpperCase()}` : "";
      if (m && REDIS_VERSIONS.has(exact)) redisVersion = exact;
      else if (m && m[1] === "6") {
        redisVersion = "REDIS_6_X";
        losses.push(
          `Redis ${version} becomes REDIS_6_X (Memorystore tracks the 6.x line)`,
        );
      } else if (m && m[1] === "7" && !m[2]) {
        redisVersion = "REDIS_7_2";
        losses.push(`Redis ${version} becomes REDIS_7_2 (latest 7.x offered)`);
      } else {
        decisions.push(
          `Memorystore for Redis does not offer version ${version}: choose redisVersion from REDIS_3_2 ... REDIS_7_2`,
        );
      }
    }
    if (redisVersion) globalArguments.redisVersion = redisVersion;

    let memory: number | null = null;
    if (typeof p.memoryGiB === "number") {
      memory = Math.max(Math.ceil(p.memoryGiB), 1);
      globalArguments.memorySizeGb = memory;
      if (memory !== p.memoryGiB) {
        losses.push(
          `memory ${p.memoryGiB} GiB becomes ${memory} GiB (Memorystore sizes in whole GiB)`,
        );
      }
    } else {
      decisions.push("the source cache size is unknown: choose memorySizeGb");
    }

    let nodes: number | null = null;
    if (typeof p.nodes === "number") {
      if (p.nodes > 1) {
        const replicas = Math.min(p.nodes - 1, 5);
        globalArguments.tier = "STANDARD_HA";
        globalArguments.replicaCount = replicas;
        nodes = replicas + 1;
        if (nodes !== p.nodes) {
          losses.push(
            `${p.nodes} nodes becomes ${nodes} (a primary plus at most 5 replicas)`,
          );
        }
      } else {
        globalArguments.tier = "BASIC";
        nodes = 1;
      }
    } else {
      globalArguments.tier = "BASIC";
      decisions.push(
        "the source node count is unknown: BASIC (one node, no failover) is rendered; choose STANDARD_HA for failover",
      );
    }

    const network = networkFor(context, target.project, "path", decisions);
    if (network) globalArguments.authorizedNetwork = network;
    else {losses.push(
        "no migrated network: the instance attaches to the target project's default network",
      );}
    const kms = firstDependency(context, "kms-key", undefined, decisions);
    if (kms) globalArguments.customerManagedKey = kms;
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    losses.push(
      "cache contents, AUTH settings and parameter groups are not carried over",
    );
    return {
      behaviorType: cache.behaviorType,
      globalArguments,
      expected: {
        engine: "redis",
        engineVersion: redisVersionToCanonical(redisVersion),
        memoryGiB: memory,
        nodes,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z]([a-z0-9-]*[a-z0-9])?$/,
      1,
      40,
      "must start with a lowercase letter, end with a letter or digit and use only lowercase letters, digits and hyphens in Memorystore",
    );
  },
};

// ---------------------------------------------------------------------------
// Filestore

/** Filestore tiers by canonical performance, and the minimum share size in GiB for each. */
const FILESTORE_TIERS: Record<
  string,
  { tier: string; minGiB: number; zonal: boolean }
> = {
  standard: { tier: "BASIC_HDD", minGiB: 1024, zonal: true },
  high: { tier: "BASIC_SSD", minGiB: 2560, zonal: true },
  // CMEK is not available on the BASIC tiers.
  encrypted: { tier: "ENTERPRISE", minGiB: 1024, zonal: false },
};

const fileShare: KindAdapter = {
  behaviorType: "@swamp/gcp/file/instances",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const protocolRaw = str(a.protocol);
    // The API omits the protocol for the default, NFSv3.
    const protocol = protocolRaw === null || protocolRaw.startsWith("NFS") ||
        protocolRaw.startsWith("FILE_PROTOCOL")
      ? "nfs"
      : null;
    if (protocol === null) unknownFields.push("protocol");
    const shares = arr(a.fileShares).map(obj).filter((s) => s !== null);
    const sizes = shares.map((s) => num(s.capacityGb));
    const capacityGiB = sizes.length > 0 && sizes.every((n) => n !== null)
      ? sizes.reduce((sum: number, n) => sum + (n ?? 0), 0)
      : null;
    if (capacityGiB === null) unknownFields.push("capacityGiB");
    const tier = str(a.tier);
    const performance = tier === null
      ? null
      : tier === "STANDARD" || tier === "BASIC_HDD"
      ? "standard"
      : "high";
    if (performance === null) unknownFields.push("performance");
    const kmsKey = str(a.kmsKeyName);
    const location = pathPart(path, "locations");
    const region = regionOf(location) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    const network = str(obj(arr(a.networks)[0])?.network);
    return {
      id: canonicalId("gcp", "file-share", path),
      provider: "gcp",
      kind: "file-share",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region,
      source: { behaviorType: fileShare.behaviorType, behaviorName },
      properties: {
        protocol,
        capacityGiB,
        performance,
        encryption: kmsKey ? "customer-key" : "provider-managed",
        labels: stringMap(a.labels),
      },
      refs: [
        ...ref("network", network, "networks[0].network"),
        ...ref("kms-key", kmsKey, "kmsKeyName"),
      ],
      dependsOn: [],
      dataBytes: capacityGiB !== null ? capacityGiB * 1024 ** 3 : null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      instanceId: targetName,
    };
    withProject(globalArguments, target, decisions, "a Filestore instance");

    if (p.protocol === "smb") {
      decisions.push(
        "Filestore serves NFS only: use NetApp Volumes (SMB) or a Windows file server for SMB shares",
      );
    } else {
      globalArguments.protocol = "NFS_V3";
    }

    // Tier: customer keys need ENTERPRISE; otherwise performance picks the BASIC tier.
    const wantsKey = p.encryption === "customer-key";
    const choice = wantsKey
      ? FILESTORE_TIERS.encrypted
      : FILESTORE_TIERS[p.performance === "high" ? "high" : "standard"];
    globalArguments.tier = choice.tier;
    if (p.performance === null || p.performance === undefined) {
      losses.push(
        `the source performance is unknown: ${choice.tier} (standard) is rendered`,
      );
    }
    if (wantsKey) {
      losses.push(
        "customer-managed keys are only offered on the ENTERPRISE tier, which is rendered here (regional, 1 TiB minimum)",
      );
    }
    if (choice.zonal) {
      const zone = firstZoneOf(target.region);
      globalArguments.location = zone;
      losses.push(
        `${choice.tier} is a zonal tier: it is placed in ${zone}; pick another zone if clients run elsewhere`,
      );
    } else {
      globalArguments.location = target.region;
    }

    let capacity: number | null = null;
    if (typeof p.capacityGiB === "number") {
      capacity = Math.max(Math.ceil(p.capacityGiB), choice.minGiB);
      if (capacity !== p.capacityGiB) {
        losses.push(
          `capacity ${p.capacityGiB} GiB is raised to ${capacity} GiB (${choice.tier} minimum is ${choice.minGiB} GiB, ${
            choice.minGiB / 1024
          } TiB)`,
        );
      }
    } else {
      capacity = choice.minGiB;
      losses.push(
        `the source capacity is elastic or unknown: the ${choice.tier} minimum of ${capacity} GiB is rendered`,
      );
    }
    globalArguments.fileShares = [{
      name: "share1",
      capacityGb: String(capacity),
    }];

    const network = networkFor(context, target.project, "name", decisions);
    if (network) {
      globalArguments.networks = [{
        network,
        modes: ["MODE_IPV4"],
        connectMode: "DIRECT_PEERING",
      }];
    } else {
      decisions.push(
        "Filestore attaches to a VPC network: add the network to the migration or set networks[0].network (it defaults to `default`)",
      );
    }
    const kms = wantsKey
      ? firstDependency(context, "kms-key", undefined, decisions)
      : null;
    if (kms) globalArguments.kmsKeyName = kms;
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    losses.push(
      "files are not copied: move the data with rsync or Storage Transfer Service",
    );
    return {
      behaviorType: fileShare.behaviorType,
      globalArguments,
      expected: {
        protocol: p.protocol === "smb" ? null : "nfs",
        capacityGiB: capacity,
        performance: choice.tier === "BASIC_HDD" ? "standard" : "high",
        encryption: wantsKey ? "customer-key" : "provider-managed",
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z]([a-z0-9-]*[a-z0-9])?$/,
      1,
      63,
      "must start with a lowercase letter, end with a letter or digit and use only lowercase letters, digits and hyphens in Filestore",
    );
  },
};

// ---------------------------------------------------------------------------
// Firestore

const nosqlTable: KindAdapter = {
  behaviorType: "@swamp/gcp/firestore/databases",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const pitr = str(a.pointInTimeRecoveryEnablement);
    const pointInTimeRecovery = pitr === null
      ? null
      : pitr === "POINT_IN_TIME_RECOVERY_ENABLED";
    if (pointInTimeRecovery === null) unknownFields.push("pointInTimeRecovery");
    const region = str(a.locationId) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("gcp", "nosql-table", path),
      provider: "gcp",
      kind: "nosql-table",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region,
      source: { behaviorType: nosqlTable.behaviorType, behaviorName },
      properties: {
        name,
        // Documents are keyed by their path; there is no key schema to read.
        keys: ["__name__"],
        billing: "on-demand",
        pointInTimeRecovery,
        // Firestore databases carry no labels.
        labels: {},
      },
      refs: ref(
        "kms-key",
        obj(a.cmekConfig)?.kmsKeyName,
        "cmekConfig.kmsKeyName",
      ),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      databaseId: targetName,
      location: target.region,
      locationId: target.region,
      type: "FIRESTORE_NATIVE",
      databaseEdition: "STANDARD",
    };
    withProject(globalArguments, target, decisions, "a Firestore database");
    if (typeof p.pointInTimeRecovery === "boolean") {
      globalArguments.pointInTimeRecoveryEnablement = p.pointInTimeRecovery
        ? "POINT_IN_TIME_RECOVERY_ENABLED"
        : "POINT_IN_TIME_RECOVERY_DISABLED";
    }
    const kms = firstDependency(context, "kms-key", undefined, decisions);
    if (kms) globalArguments.cmekConfig = { kmsKeyName: kms };
    if (Object.keys(stringMap(p.labels)).length > 0) {
      losses.push(
        "Firestore databases have no labels; the source labels are dropped",
      );
    }
    if (resource.provider !== "gcp") {
      losses.push(
        "the key schema, secondary indexes, TTL and stream settings are not translated; create Firestore indexes for the query patterns",
      );
    }
    if (targetName !== "(default)") {
      losses.push(
        "a named database is created; the project's `(default)` database is not touched",
      );
    }
    return {
      behaviorType: nosqlTable.behaviorType,
      globalArguments,
      expected: {
        name: targetName,
        keys: ["__name__"],
        billing: "on-demand",
        pointInTimeRecovery: typeof p.pointInTimeRecovery === "boolean"
          ? p.pointInTimeRecovery
          : null,
        labels: {},
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    if (name === "(default)") return [];
    const problems = nameProblems(
      name,
      /^[a-z]([a-z0-9-]*[a-z0-9])$/,
      4,
      63,
      "must start with a lowercase letter, end with a letter or digit and use only lowercase letters, digits and hyphens in Firestore",
    );
    if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)) {
      problems.push(`"${name}" must not look like a UUID in Firestore`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// Cloud KMS

const kmsKey: KindAdapter = {
  behaviorType: "@swamp/gcp/cloudkms/keyrings-cryptokeys",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const rawPurpose = str(a.purpose);
    const purpose = rawPurpose === "ENCRYPT_DECRYPT"
      ? "encrypt"
      : rawPurpose === "ASYMMETRIC_SIGN"
      ? "sign"
      : null;
    if (purpose === null) unknownFields.push("purpose");
    const region = pathPart(path, "locations") ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("gcp", "kms-key", path),
      provider: "gcp",
      kind: "kms-key",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region,
      source: { behaviorType: kmsKey.behaviorType, behaviorName },
      properties: {
        purpose,
        rotation: str(a.rotationPeriod) !== null,
        labels: stringMap(a.labels),
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    // Source key rings keep their name when the source is also Google Cloud; otherwise one is derived.
    const sourceRing = pathPart(resource.nativeId, "keyRings");
    const ring = resource.provider === "gcp" && sourceRing
      ? sourceRing
      : `${targetName}-keyring`;
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      cryptoKeyId: targetName,
      location: target.region,
    };
    withProject(globalArguments, target, decisions, "a Cloud KMS key");
    globalArguments.parent = `projects/${
      target.project ?? "<project>"
    }/locations/${target.region}/keyRings/${ring}`;
    decisions.push(
      `a key ring named "${ring}" must exist in ${target.region} before the key: create it (key rings cannot be deleted) or change \`parent\` to an existing ring`,
    );

    const purpose = p.purpose === "sign"
      ? "ASYMMETRIC_SIGN"
      : p.purpose === "encrypt"
      ? "ENCRYPT_DECRYPT"
      : null;
    if (purpose) {
      globalArguments.purpose = purpose;
      if (purpose === "ASYMMETRIC_SIGN") {
        globalArguments.versionTemplate = {
          algorithm: "EC_SIGN_P256_SHA256",
          protectionLevel: "SOFTWARE",
        };
        losses.push(
          "the signing algorithm is not carried over: EC_SIGN_P256_SHA256 is rendered",
        );
      }
    } else {
      decisions.push(
        "the source key purpose is unknown: choose ENCRYPT_DECRYPT or ASYMMETRIC_SIGN",
      );
    }
    if (p.rotation === true && purpose === "ENCRYPT_DECRYPT") {
      globalArguments.rotationPeriod = "7776000s";
      losses.push(
        "automatic rotation is set to every 90 days (7776000s); the source period is not carried over",
      );
      decisions.push(
        "set nextRotationTime (RFC 3339) for the first rotation: Cloud KMS requires it alongside rotationPeriod",
      );
    } else if (p.rotation === true) {
      losses.push(
        "automatic rotation does not apply to asymmetric keys on Cloud KMS",
      );
    }
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    return {
      behaviorType: kmsKey.behaviorType,
      globalArguments,
      expected: {
        purpose,
        rotation: p.rotation === true && purpose === "ENCRYPT_DECRYPT",
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[A-Za-z0-9_-]+$/,
      1,
      63,
      'may only use letters, digits, "-" and "_" in Cloud KMS',
    );
  },
};

// ---------------------------------------------------------------------------
// Secret Manager

/** The CMEK key names a secret's replication policy names. */
function secretKeys(a: Record<string, unknown>): string[] {
  const replication = obj(a.replication);
  const keys = [
    str(
      obj(obj(replication?.automatic)?.customerManagedEncryption)?.kmsKeyName,
    ),
  ];
  for (const replica of arr(obj(replication?.userManaged)?.replicas)) {
    keys.push(str(obj(obj(replica)?.customerManagedEncryption)?.kmsKeyName));
  }
  return [...new Set(keys.filter((k): k is string => k !== null))];
}

const secret: KindAdapter = {
  behaviorType: "@swamp/gcp/secretmanager/secrets",
  idField: "name",
  // Only the secret's metadata is read here; values are never fetched.
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const path = str(a.name) ?? "";
    const name = lastSegment(path) ?? "";
    const rotation = obj(a.rotation);
    return {
      id: canonicalId("gcp", "secret", path),
      provider: "gcp",
      kind: "secret",
      nativeId: path,
      aliases: [name].filter((x) => x.length > 0),
      name,
      // Global unless the secret lives under projects/<p>/locations/<l>.
      region: pathPart(path, "locations") ?? regionFallback,
      source: { behaviorType: secret.behaviorType, behaviorName },
      properties: {
        name,
        rotation: rotation !== null &&
          (str(rotation.nextRotationTime) !== null ||
            str(rotation.rotationPeriod) !== null),
        labels: stringMap(a.labels),
      },
      refs: secretKeys(a).map((k) => ({
        kind: "kms-key" as const,
        nativeId: k,
        via: "replication.customerManagedEncryption.kmsKeyName",
      })),
      dependsOn: [],
      dataBytes: null,
      unknownFields: [],
    };
  },
  render(resource, targetName, target, context): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    // The container only: no versions, no values.
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      secretId: targetName,
    };
    withProject(globalArguments, target, decisions, "a Secret Manager secret");
    const kms = firstDependency(context, "kms-key", undefined, decisions);
    globalArguments.replication = {
      automatic: kms ? { customerManagedEncryption: { kmsKeyName: kms } } : {},
    };
    if (p.rotation === true) {
      losses.push(
        "the rotation schedule is not carried over: Secret Manager rotation only sends a Pub/Sub notification, so re-create it with a topic and rotation.nextRotationTime",
      );
    }
    const labels = gcpLabels(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    return {
      behaviorType: secret.behaviorType,
      globalArguments,
      expected: { name: targetName, rotation: false, labels },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[A-Za-z0-9_-]+$/,
      1,
      255,
      'may only use letters, digits, "-" and "_" in Secret Manager (no "/" or ".")',
    );
  },
};

// ---------------------------------------------------------------------------
// IAM service accounts

const iamPrincipal: KindAdapter = {
  behaviorType: "@swamp/gcp/iam/serviceaccounts",
  // Other resources reference a service account by its email.
  idField: "email",
  normalise(a, behaviorName): CanonicalResource {
    const path = str(a.name) ?? "";
    const email = str(a.email) ?? lastSegment(path) ?? "";
    const accountId = str(a.accountId) ?? email.split("@")[0];
    return {
      id: canonicalId("gcp", "iam-principal", email),
      provider: "gcp",
      kind: "iam-principal",
      nativeId: email,
      aliases: [path, str(a.uniqueId), str(a.oauth2ClientId)].filter((
        x,
      ): x is string => !!x),
      name: accountId,
      // Service accounts are global.
      region: null,
      source: { behaviorType: iamPrincipal.behaviorType, behaviorName },
      properties: {
        name: accountId,
        principalType: "service-account",
        description: str(a.description),
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields: [],
    };
  },
  render(resource, targetName, target): RenderResult {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {};
    if (target.project) globalArguments.name = `projects/${target.project}`;
    else {decisions.push(
        "target.project is required to create a service account",
      );}
    globalArguments.accountId = targetName;

    const account: Record<string, unknown> = { displayName: targetName };
    let description = strProp(p, "description");
    if (description && new TextEncoder().encode(description).length > 256) {
      description = description.slice(0, 256);
      losses.push(
        "the description is truncated to 256 bytes (service account limit)",
      );
    }
    if (description) account.description = description;
    globalArguments.serviceAccount = account;

    if (p.principalType === "user") {
      decisions.push(
        "a user cannot be created as a service account: add the person as a Google identity and grant roles directly",
      );
    } else if (p.principalType === "role") {
      losses.push(
        "the source role becomes a service account: its trust policy and attached policies are not translated, grant roles to the account yourself",
      );
    }
    return {
      behaviorType: iamPrincipal.behaviorType,
      globalArguments,
      expected: {
        name: targetName,
        principalType: "service-account",
        description,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z]([-a-z0-9]*[a-z0-9])$/,
      6,
      30,
      "must start with a lowercase letter, end with a letter or digit and use only lowercase letters, digits and hyphens for a service account id",
    );
  },
};

/** Kind adapters merged into the provider in its main file. */
export const gcpServiceKinds: ProviderAdapter["kinds"] = {
  "sql-database": sqlDatabase,
  "container-registry": containerRegistry,
  "message-topic": messageTopic,
  "message-queue": messageQueue,
  function: fn,
  cache,
  "file-share": fileShare,
  "nosql-table": nosqlTable,
  "kms-key": kmsKey,
  secret,
  "iam-principal": iamPrincipal,
};

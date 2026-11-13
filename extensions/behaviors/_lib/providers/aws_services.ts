/**
 * AWS managed data, messaging, serverless, keys, secrets and IAM adapters.
 * See ../kinds.ts for the canonical shapes and ../adapter.ts for the contract.
 *
 * State attributes are AWS Cloud Control property names, as written by the
 * official `@swamp/aws/*` behaviors. Nothing here reads secret values
 * (`SecretString`, Lambda environment variables, DB master passwords): they
 * are neither normalised nor rendered.
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
  type ResourceRef,
  str,
  tagsToLabels,
  track,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { awsTags, customKeyOf, withoutReserved } from "./aws_infra.ts";

// ---------------------------------------------------------------------------
// Shared helpers

/** The region in an ARN (`arn:aws:sns:eu-west-2:...`), or null. */
function regionFromArn(arn: unknown): string | null {
  const m = str(arn)?.match(/^arn:[^:]*:[^:]*:([a-z]{2}(?:-[a-z]+)+-\d):/);
  return m ? m[1] : null;
}

/** The region of an availability zone (`eu-west-2a` → `eu-west-2`), or null. */
function regionFromZone(zone: unknown): string | null {
  const m = str(zone)?.match(/^([a-z]{2}(?:-[a-z]+)+-\d)[a-z]$/);
  return m ? m[1] : null;
}

/** A customer KMS key reference; AWS-managed aliases (`alias/aws/...`) are not a dependency. */
function customKey(value: unknown): string | null {
  return customKeyOf(value);
}

/** A `kms-key` ref for `value`, or []. */
function kmsRefs(value: unknown, via: string): ResourceRef[] {
  const key = customKey(value);
  return key ? [{ kind: "kms-key", nativeId: key, via }] : [];
}

/** Non-empty strings out of any array. */
function strings(value: unknown): string[] {
  return arr(value).map(str).filter((s): s is string => s !== null);
}

/** The canonical labels of a resource. */
function labelsOf(p: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(p.labels) ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Every dependency of `kind` that is part of the migration, as CEL refs. */
function allRefs(context: RenderContext, kind: ResourceKind): string[] {
  return context.dependencies(kind)
    .map((id) => context.refTo(id))
    .filter((r): r is string => r !== null);
}

/** The first dependency of `kind` as a CEL ref, or null when none is migrated. */
function firstRef(context: RenderContext, kind: ResourceKind): string | null {
  return allRefs(context, kind)[0] ?? null;
}

/** `value` rounded and clamped to [min, max]; pushes a loss when it moved. */
function clamp(
  value: number,
  min: number,
  max: number,
  what: string,
  losses: string[],
): number {
  const v = Math.min(max, Math.max(min, Math.round(value)));
  if (v !== value) {
    losses.push(
      `${what} ${value} is outside AWS limits (${min}-${max}); using ${v}`,
    );
  }
  return v;
}

/**
 * Set `Tags` on `globalArguments` when there are usable labels. The reserved
 * `aws:` prefix cannot be written, so those labels are dropped with a loss;
 * returns the labels that remain, which is what the target will read back.
 */
function addTags(
  globalArguments: Record<string, unknown>,
  labels: Record<string, string>,
  losses: string[],
  field = "Tags",
): Record<string, string> {
  const { tags, losses: dropped } = awsTags(labels);
  losses.push(...dropped);
  if (tags.length > 0) globalArguments[field] = tags;
  return withoutReserved(labels);
}

/** The last segment of an ARN or path, for display names. */
function nameFromArn(value: unknown): string | null {
  const s = str(value);
  return s ? s.split(/[:/]/).filter(Boolean).pop() ?? null : null;
}

// ---------------------------------------------------------------------------
// sql-database: @swamp/aws/rds/dbinstance

/** A DB instance class with the numbers sizing needs. */
interface DbClass {
  cls: string;
  vcpus: number;
  memoryMiB: number;
  /** Graviton classes are offered for postgres/mysql/mariadb only. */
  graviton: boolean;
}

/** Common RDS classes. Not exhaustive: classes outside it are left unsized. */
const DB_CLASSES: DbClass[] = [
  { cls: "db.t4g.micro", vcpus: 2, memoryMiB: 1024, graviton: true },
  { cls: "db.t4g.small", vcpus: 2, memoryMiB: 2048, graviton: true },
  { cls: "db.t4g.medium", vcpus: 2, memoryMiB: 4096, graviton: true },
  { cls: "db.t4g.large", vcpus: 2, memoryMiB: 8192, graviton: true },
  { cls: "db.t4g.xlarge", vcpus: 4, memoryMiB: 16384, graviton: true },
  { cls: "db.t4g.2xlarge", vcpus: 8, memoryMiB: 32768, graviton: true },
  { cls: "db.m6g.large", vcpus: 2, memoryMiB: 8192, graviton: true },
  { cls: "db.m6g.xlarge", vcpus: 4, memoryMiB: 16384, graviton: true },
  { cls: "db.m6g.2xlarge", vcpus: 8, memoryMiB: 32768, graviton: true },
  { cls: "db.m6g.4xlarge", vcpus: 16, memoryMiB: 65536, graviton: true },
  { cls: "db.m7g.large", vcpus: 2, memoryMiB: 8192, graviton: true },
  { cls: "db.m7g.xlarge", vcpus: 4, memoryMiB: 16384, graviton: true },
  { cls: "db.m7g.2xlarge", vcpus: 8, memoryMiB: 32768, graviton: true },
  { cls: "db.m7g.4xlarge", vcpus: 16, memoryMiB: 65536, graviton: true },
  { cls: "db.r6g.large", vcpus: 2, memoryMiB: 16384, graviton: true },
  { cls: "db.r6g.xlarge", vcpus: 4, memoryMiB: 32768, graviton: true },
  { cls: "db.r6g.2xlarge", vcpus: 8, memoryMiB: 65536, graviton: true },
  { cls: "db.r6g.4xlarge", vcpus: 16, memoryMiB: 131072, graviton: true },
  // x86 families, the only choice for SQL Server and Oracle.
  { cls: "db.m6i.large", vcpus: 2, memoryMiB: 8192, graviton: false },
  { cls: "db.m6i.xlarge", vcpus: 4, memoryMiB: 16384, graviton: false },
  { cls: "db.m6i.2xlarge", vcpus: 8, memoryMiB: 32768, graviton: false },
  { cls: "db.m6i.4xlarge", vcpus: 16, memoryMiB: 65536, graviton: false },
  { cls: "db.r6i.large", vcpus: 2, memoryMiB: 16384, graviton: false },
  { cls: "db.r6i.xlarge", vcpus: 4, memoryMiB: 32768, graviton: false },
  { cls: "db.r6i.2xlarge", vcpus: 8, memoryMiB: 65536, graviton: false },
  { cls: "db.r6i.4xlarge", vcpus: 16, memoryMiB: 131072, graviton: false },
];

/** RDS `Engine` values the canonical engines render to (editions are a decision for sqlserver/oracle). */
const RDS_ENGINES: Record<string, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlserver: "sqlserver-se",
  oracle: "oracle-se2",
};

/** Major versions this adapter is willing to render; anything else is a decision. */
const RDS_MAJORS: Record<string, string[]> = {
  postgres: ["13", "14", "15", "16", "17"],
  mysql: ["8.0", "8.4"],
  mariadb: ["10.6", "10.11", "11.4"],
  sqlserver: ["15", "16"],
  oracle: ["19"],
};

/** A canonical engine from an RDS `Engine` value, or null. */
function canonicalDbEngine(engine: string | null): string | null {
  if (!engine) return null;
  if (engine === "postgres" || engine === "aurora-postgresql") {
    return "postgres";
  }
  if (engine === "mysql" || engine === "aurora-mysql") return "mysql";
  if (engine === "mariadb") return "mariadb";
  if (engine.startsWith("sqlserver")) return "sqlserver";
  if (engine.startsWith("oracle")) return "oracle";
  return null;
}

/** The major version of `version` for `engine`: "15.4" → "15", "8.0.35" → "8.0", "10.11.6" → "10.11". */
function majorVersion(
  engine: string | null,
  version: string | null,
): string | null {
  if (!version) return null;
  const parts = version.split(".");
  if (engine === "mysql" || engine === "mariadb") {
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0];
  }
  return parts[0];
}

/** The class table row for `cls`, or undefined. */
function dbClassOf(cls: string | null): DbClass | undefined {
  return DB_CLASSES.find((c) => c.cls === cls);
}

/** The smallest class with at least `vcpus` and `memoryMiB`, by memory then vcpus. */
function smallestDbClass(
  vcpus: number | null,
  memoryMiB: number | null,
  graviton: boolean,
): DbClass | null {
  return DB_CLASSES
    .map((c, i) => ({ c, i }))
    .filter(({ c }) =>
      (graviton || !c.graviton) && c.vcpus >= (vcpus ?? 0) &&
      c.memoryMiB >= (memoryMiB ?? 0)
    )
    .sort((a, b) =>
      a.c.memoryMiB - b.c.memoryMiB || a.c.vcpus - b.c.vcpus || a.i - b.i
    )[0]?.c ??
    null;
}

const dbInstance: KindAdapter = {
  behaviorType: "@swamp/aws/rds/dbinstance",
  idField: "DBInstanceArn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.DBInstanceIdentifier) ?? str(a._identifier) ?? "";
    const engine = track(
      unknownFields,
      "engine",
      canonicalDbEngine(str(a.Engine)),
    );
    const version = track(
      unknownFields,
      "engineVersion",
      majorVersion(engine, str(a.EngineVersion)),
    );
    const instanceClass = track(
      unknownFields,
      "instanceClass",
      str(a.DBInstanceClass),
    );
    const sized = dbClassOf(instanceClass);
    const storage = track(unknownFields, "storageGiB", num(a.AllocatedStorage));
    const region = regionFromArn(a.DBInstanceArn) ??
      regionFromZone(a.AvailabilityZone) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    // The state names only the DB subnet group, not its subnets, so no
    // subnet refs can be derived from it.
    const refs: ResourceRef[] = [
      ...strings(a.VPCSecurityGroups).map((id): ResourceRef => ({
        kind: "firewall",
        nativeId: id,
        via: "VPCSecurityGroups",
      })),
      ...kmsRefs(a.KmsKeyId, "KmsKeyId"),
    ];
    return {
      id: canonicalId("aws", "sql-database", name),
      provider: "aws",
      kind: "sql-database",
      nativeId: name,
      aliases: [str(a.DBInstanceArn), str(a.DbiResourceId)].filter((
        x,
      ): x is string => x !== null),
      name,
      region,
      source: { behaviorType: dbInstance.behaviorType, behaviorName },
      properties: {
        engine,
        engineVersion: version,
        instanceClass,
        vcpus: sized?.vcpus ?? null,
        memoryMiB: sized?.memoryMiB ?? null,
        storageGiB: storage,
        highAvailability: track(
          unknownFields,
          "highAvailability",
          bool(a.MultiAZ),
        ),
        backupRetentionDays: track(
          unknownFields,
          "backupRetentionDays",
          num(a.BackupRetentionPeriod),
        ),
        publicAccess: track(
          unknownFields,
          "publicAccess",
          bool(a.PubliclyAccessible),
        ),
        labels: tagsToLabels(a.Tags),
      },
      refs,
      dependsOn: [],
      dataBytes: storage === null ? null : storage * 1024 ** 3,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [
      "the master username and password are never read or planned: after creating the target behavior, set MasterUsername and MasterUserPassword in its definition as a swamp vault expression (`${{ vault.get(<vault>, <key>) }}`), never through resolve, or enable ManageMasterUserPassword; restore the data from a dump or snapshot",
      "RDS needs a DB subnet group covering at least two availability zones in the target VPC: create one (@swamp/aws/rds/dbsubnet-group) and set DBSubnetGroupName",
    ];
    const engine = typeof p.engine === "string" ? p.engine : null;
    const rdsEngine = engine ? RDS_ENGINES[engine] : undefined;
    const globalArguments: Record<string, unknown> = {
      DBInstanceIdentifier: targetName,
      region: target.region,
    };
    if (rdsEngine) globalArguments.Engine = rdsEngine;
    else {decisions.push(
        `engine ${
          engine ? `"${engine}"` : "(unknown)"
        } has no RDS equivalent; choose an engine`,
      );}
    if (engine === "sqlserver" || engine === "oracle") {
      decisions.push(
        `${engine} runs as ${rdsEngine} on RDS: choose the edition and license model, and an exact engine version`,
      );
    }

    // Version: keep the major, but only when RDS offers it. SQL Server and
    // Oracle need a full engine version, so that is left to a person.
    const version = typeof p.engineVersion === "string"
      ? p.engineVersion
      : null;
    let expectedVersion: string | null = null;
    if (version && engine && rdsEngine) {
      if (!(RDS_MAJORS[engine] ?? []).includes(version)) {
        decisions.push(
          `${engine} ${version} is not in the versions this plan knows RDS offers (${
            (RDS_MAJORS[engine] ?? []).join(", ")
          }): pick a supported version`,
        );
      } else if (engine !== "sqlserver" && engine !== "oracle") {
        globalArguments.EngineVersion = version;
        expectedVersion = version;
      }
    } else if (!version) {
      losses.push(
        "source engine version unknown; RDS picks its default version",
      );
    }

    // Sizing: the same class when the source is already RDS, else the smallest that fits.
    const graviton = engine === "postgres" || engine === "mysql" ||
      engine === "mariadb";
    const vcpus = typeof p.vcpus === "number" ? p.vcpus : null;
    const memoryMiB = typeof p.memoryMiB === "number" ? p.memoryMiB : null;
    let chosen: DbClass | null = null;
    if (resource.provider === "aws" && typeof p.instanceClass === "string") {
      globalArguments.DBInstanceClass = p.instanceClass;
      chosen = dbClassOf(p.instanceClass) ?? null;
    } else if (vcpus === null && memoryMiB === null) {
      chosen = dbClassOf(graviton ? "db.t4g.medium" : "db.m6i.large") ?? null;
      decisions.push(
        `source size is unknown; ${chosen?.cls} was picked as a placeholder, choose the real class`,
      );
    } else {
      chosen = smallestDbClass(vcpus, memoryMiB, graviton);
      if (chosen) {
        losses.push(
          `source size (${vcpus ?? "?"} vCPU / ${
            memoryMiB ?? "?"
          } MiB) maps to ${chosen.cls} (${chosen.vcpus} vCPU / ${chosen.memoryMiB} MiB), the smallest fitting class`,
        );
      } else {
        decisions.push(
          `no known RDS class fits ${vcpus ?? "?"} vCPU / ${
            memoryMiB ?? "?"
          } MiB; choose a class`,
        );
      }
    }
    if (chosen && !globalArguments.DBInstanceClass) {
      globalArguments.DBInstanceClass = chosen.cls;
    }

    // Storage: RDS needs at least 20 GiB.
    let storage: number | null = typeof p.storageGiB === "number"
      ? p.storageGiB
      : null;
    if (storage === null) {
      storage = 20;
      decisions.push(
        "source storage size unknown; 20 GiB (the RDS minimum) was used, choose the real size",
      );
    } else if (storage < 20) {
      losses.push(
        `storage ${storage} GiB is below the RDS minimum; using 20 GiB`,
      );
      storage = 20;
    }
    globalArguments.AllocatedStorage = String(storage);

    if (typeof p.highAvailability === "boolean") {
      globalArguments.MultiAZ = p.highAvailability;
    }
    let backup: number | null = null;
    if (typeof p.backupRetentionDays === "number") {
      backup = clamp(p.backupRetentionDays, 0, 35, "backup retention", losses);
      globalArguments.BackupRetentionPeriod = backup;
    }
    if (typeof p.publicAccess === "boolean") {
      globalArguments.PubliclyAccessible = p.publicAccess;
      if (p.publicAccess) {
        decisions.push(
          "source is reachable from the internet; confirm the target should be public too",
        );
      }
    }
    globalArguments.StorageEncrypted = true;

    const kms = firstRef(context, "kms-key");
    if (kms) globalArguments.KmsKeyId = kms;
    const groups = allRefs(context, "firewall");
    if (groups.length > 0) globalArguments.VPCSecurityGroups = groups;
    else {
      decisions.push(
        "no security group is part of the migration; set VPCSecurityGroups so only the database's clients can reach it",
      );
    }

    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: dbInstance.behaviorType,
      globalArguments,
      expected: {
        engine,
        engineVersion: expectedVersion,
        instanceClass: chosen?.cls ?? null,
        vcpus: chosen?.vcpus ?? null,
        memoryMiB: chosen?.memoryMiB ?? null,
        storageGiB: storage,
        highAvailability: typeof p.highAvailability === "boolean"
          ? p.highAvailability
          : null,
        backupRetentionDays: backup,
        publicAccess: typeof p.publicAccess === "boolean"
          ? p.publicAccess
          : null,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 63) {
      problems.push(`"${name}" must be 1-63 characters`);
    }
    if (!/^[a-z]/i.test(name)) {
      problems.push(`"${name}" must start with a letter`);
    }
    if (!/^[a-zA-Z0-9-]*$/.test(name)) {
      problems.push(`"${name}" may only use letters, digits and hyphens`);
    }
    if (name.endsWith("-") || name.includes("--")) {
      problems.push(
        `"${name}" must not end with a hyphen or contain two in a row`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// container-registry: @swamp/aws/ecr/repository

const ecrRepository: KindAdapter = {
  behaviorType: "@swamp/aws/ecr/repository",
  idField: "RepositoryName",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.RepositoryName) ?? str(a._identifier) ?? "";
    const mutability = str(a.ImageTagMutability);
    const region = regionFromArn(a.Arn) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    const enc = obj(a.EncryptionConfiguration);
    return {
      id: canonicalId("aws", "container-registry", name),
      provider: "aws",
      kind: "container-registry",
      nativeId: name,
      aliases: [str(a.Arn), str(a.RepositoryUri)].filter((x): x is string =>
        x !== null
      ),
      name,
      region,
      source: { behaviorType: ecrRepository.behaviorType, behaviorName },
      properties: {
        name,
        // ECR defaults to MUTABLE when the field is absent.
        immutableTags: mutability === null
          ? false
          : mutability.startsWith("IMMUTABLE"),
        scanOnPush: bool(obj(a.ImageScanningConfiguration)?.ScanOnPush) ??
          false,
        // Extra property: IMMUTABLE_WITH_EXCLUSION has no canonical form, so
        // render reports it as a loss.
        immutableExclusions: mutability === "IMMUTABLE_WITH_EXCLUSION",
        labels: tagsToLabels(a.Tags),
      },
      refs: enc?.EncryptionType === "KMS" || enc?.EncryptionType === "KMS_DSSE"
        ? kmsRefs(enc.KmsKey, "EncryptionConfiguration.KmsKey")
        : [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "repository and lifecycle policies are not translated; recreate them on the target",
      "images are not part of the repository definition: copy them separately before cutover",
    ];
    if (p.immutableExclusions === true) {
      losses.push(
        "source uses IMMUTABLE_WITH_EXCLUSION; the target is plain IMMUTABLE, so the excluded tag patterns become immutable too",
      );
    }
    const globalArguments: Record<string, unknown> = {
      RepositoryName: targetName,
      region: target.region,
      ImageTagMutability: p.immutableTags === true ? "IMMUTABLE" : "MUTABLE",
    };
    if (typeof p.scanOnPush === "boolean") {
      globalArguments.ImageScanningConfiguration = { ScanOnPush: p.scanOnPush };
    }
    const kms = firstRef(context, "kms-key");
    globalArguments.EncryptionConfiguration = kms
      ? { EncryptionType: "KMS", KmsKey: kms }
      : { EncryptionType: "AES256" };
    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: ecrRepository.behaviorType,
      globalArguments,
      expected: {
        name: targetName,
        immutableTags: p.immutableTags === true,
        scanOnPush: typeof p.scanOnPush === "boolean" ? p.scanOnPush : null,
        labels,
      },
      losses,
      decisions: [],
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 2 || name.length > 256) {
      problems.push(`"${name}" must be 2-256 characters`);
    }
    if (
      !/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(
        name,
      )
    ) {
      problems.push(
        `"${name}" must be lowercase letters and digits with single "." "_" "-" separators and optional "/" path segments`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// message-topic: @swamp/aws/sns/topic

/** `name` with the `.fifo` suffix FIFO topics and queues require. */
function fifoName(name: string, ordered: boolean): string {
  return ordered && !name.endsWith(".fifo") ? `${name}.fifo` : name;
}

/** Shared SNS/SQS name rules: [A-Za-z0-9_-] up to `max` characters, `.fifo` suffix allowed. */
function queueLikeNameProblems(
  name: string,
  max: number,
  what: string,
): string[] {
  const problems: string[] = [];
  const base = name.endsWith(".fifo") ? name.slice(0, -5) : name;
  if (name.length < 1 || name.length > max) {
    problems.push(
      `"${name}" must be 1-${max} characters (a ".fifo" suffix counts)`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(base)) {
    problems.push(
      `${what} name "${name}" may only use letters, digits, hyphens and underscores (plus a ".fifo" suffix)`,
    );
  }
  return problems;
}

const snsTopic: KindAdapter = {
  behaviorType: "@swamp/aws/sns/topic",
  idField: "TopicArn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const arn = str(a.TopicArn) ?? str(a._identifier) ?? "";
    const name = str(a.TopicName) ?? nameFromArn(arn) ?? "";
    const region = regionFromArn(arn) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("aws", "message-topic", arn),
      provider: "aws",
      kind: "message-topic",
      nativeId: arn,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region,
      source: { behaviorType: snsTopic.behaviorType, behaviorName },
      properties: {
        name,
        ordered: bool(a.FifoTopic) ?? name.endsWith(".fifo"),
        labels: tagsToLabels(a.Tags),
      },
      refs: kmsRefs(a.KmsMasterKeyId, "KmsMasterKeyId"),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "subscriptions, access policies, data protection and delivery-status logging are not translated; recreate them on the target",
    ];
    const ordered = p.ordered === true;
    const topicName = fifoName(targetName, ordered);
    if (topicName !== targetName) {
      losses.push(
        `FIFO topics must end in ".fifo"; the topic is named "${topicName}"`,
      );
    }
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      TopicName: topicName,
      region: target.region,
    };
    if (ordered) globalArguments.FifoTopic = true;
    const kms = firstRef(context, "kms-key");
    if (kms) globalArguments.KmsMasterKeyId = kms;
    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: snsTopic.behaviorType,
      globalArguments,
      expected: { name: topicName, ordered, labels },
      losses,
      decisions: [],
    };
  },
  validateName(name) {
    return queueLikeNameProblems(name, 256, "topic");
  },
};

// ---------------------------------------------------------------------------
// message-queue: @swamp/aws/sqs/queue

/** Cloud Control gives RedrivePolicy as an object or, from some APIs, a JSON string. */
function hasRedrive(policy: unknown): boolean {
  if (obj(policy) !== null) return true;
  const text = str(policy);
  if (text === null) return false;
  try {
    return obj(JSON.parse(text)) !== null;
  } catch {
    return text.includes("deadLetterTargetArn");
  }
}

const sqsQueue: KindAdapter = {
  behaviorType: "@swamp/aws/sqs/queue",
  idField: "Arn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const url = str(a.QueueUrl) ?? str(a._identifier) ?? "";
    const name = str(a.QueueName) ?? lastSegment(url) ?? "";
    const region = regionFromArn(a.Arn) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    // SNS-to-SQS subscriptions live on the topic side (sns/subscription), so
    // the queue's own state never names a topic; the only ARN it shows is a
    // dead-letter queue, which is a queue, not a topic. No topic ref here.
    return {
      id: canonicalId("aws", "message-queue", url),
      provider: "aws",
      kind: "message-queue",
      nativeId: url,
      aliases: [str(a.Arn), name].filter((x): x is string =>
        x !== null && x.length > 0
      ),
      name,
      region,
      source: { behaviorType: sqsQueue.behaviorType, behaviorName },
      properties: {
        name,
        ordered: bool(a.FifoQueue) ?? name.endsWith(".fifo"),
        visibilityTimeoutSeconds: track(
          unknownFields,
          "visibilityTimeoutSeconds",
          num(a.VisibilityTimeout),
        ),
        retentionSeconds: track(
          unknownFields,
          "retentionSeconds",
          num(a.MessageRetentionPeriod),
        ),
        deadLetter: hasRedrive(a.RedrivePolicy),
        labels: tagsToLabels(a.Tags),
      },
      refs: kmsRefs(a.KmsMasterKeyId, "KmsMasterKeyId"),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "access policy and redrive-allow policy are not translated; recreate them on the target",
    ];
    const decisions: string[] = [];
    const ordered = p.ordered === true;
    const queueName = fifoName(targetName, ordered);
    if (queueName !== targetName) {
      losses.push(
        `FIFO queues must end in ".fifo"; the queue is named "${queueName}"`,
      );
    }
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      QueueName: queueName,
      region: target.region,
    };
    if (ordered) globalArguments.FifoQueue = true;
    let visibility: number | null = null;
    if (typeof p.visibilityTimeoutSeconds === "number") {
      visibility = clamp(
        p.visibilityTimeoutSeconds,
        0,
        43200,
        "visibility timeout",
        losses,
      );
      globalArguments.VisibilityTimeout = visibility;
    }
    let retention: number | null = null;
    if (typeof p.retentionSeconds === "number") {
      retention = clamp(
        p.retentionSeconds,
        60,
        1209600,
        "message retention",
        losses,
      );
      globalArguments.MessageRetentionPeriod = retention;
    }
    const kms = firstRef(context, "kms-key");
    if (kms) globalArguments.KmsMasterKeyId = kms;
    else globalArguments.SqsManagedSseEnabled = true;
    if (p.deadLetter === true) {
      decisions.push(
        "source has a dead-letter target; create the target dead-letter queue and set RedrivePolicy (deadLetterTargetArn, maxReceiveCount)",
      );
    }
    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: sqsQueue.behaviorType,
      globalArguments,
      expected: {
        name: queueName,
        ordered,
        visibilityTimeoutSeconds: visibility,
        retentionSeconds: retention,
        deadLetter: false,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return queueLikeNameProblems(name, 80, "queue");
  },
};

// ---------------------------------------------------------------------------
// function: @swamp/aws/lambda/function

/** Lambda `Runtime` values by canonical runtime. The supported set is an assumption: the schema types Runtime as a free string. */
const LAMBDA_RUNTIMES: Record<string, string> = {
  nodejs20: "nodejs20.x",
  nodejs22: "nodejs22.x",
  "python3.9": "python3.9",
  "python3.10": "python3.10",
  "python3.11": "python3.11",
  "python3.12": "python3.12",
  "python3.13": "python3.13",
  java17: "java17",
  java21: "java21",
  dotnet8: "dotnet8",
  "ruby3.2": "ruby3.2",
  "ruby3.3": "ruby3.3",
  "ruby3.4": "ruby3.4",
  "provided.al2": "provided.al2",
  "provided.al2023": "provided.al2023",
};

/** A canonical runtime string from any provider's spelling ("nodejs20.x", "python312"). */
function canonicalRuntime(runtime: string | null): string | null {
  if (!runtime) return null;
  const r = runtime.toLowerCase();
  let m = r.match(/^nodejs(\d+)(?:\.x)?$/);
  if (m) return `nodejs${m[1]}`;
  m = r.match(/^python3\.?(\d+)$/);
  if (m) return `python3.${m[1]}`;
  m = r.match(/^java(\d+)$/);
  if (m) return `java${m[1]}`;
  m = r.match(/^dotnet(?:core)?(\d+)(?:\.\d+)?$/);
  if (m) return `dotnet${m[1]}`;
  m = r.match(/^ruby(\d)\.?(\d)$/);
  if (m) return `ruby${m[1]}.${m[2]}`;
  return r;
}

const lambdaFunction: KindAdapter = {
  behaviorType: "@swamp/aws/lambda/function",
  idField: "Arn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.FunctionName) ?? str(a._identifier) ?? "";
    const image = str(a.PackageType) === "Image";
    // Container-image functions have no runtime or handler; that is not "unknown".
    const runtime = image
      ? null
      : track(unknownFields, "runtime", canonicalRuntime(str(a.Runtime)));
    const region = regionFromArn(a.Arn) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    const vpc = obj(a.VpcConfig);
    const refs: ResourceRef[] = [];
    const role = str(a.Role);
    if (role) refs.push({ kind: "iam-principal", nativeId: role, via: "Role" });
    for (const id of strings(vpc?.SubnetIds)) {
      refs.push({ kind: "subnet", nativeId: id, via: "VpcConfig.SubnetIds" });
    }
    for (const id of strings(vpc?.SecurityGroupIds)) {
      refs.push({
        kind: "firewall",
        nativeId: id,
        via: "VpcConfig.SecurityGroupIds",
      });
    }
    // Environment variables are deliberately never read: they often hold secrets.
    return {
      id: canonicalId("aws", "function", name),
      provider: "aws",
      kind: "function",
      nativeId: name,
      aliases: [str(a.Arn)].filter((x): x is string => x !== null),
      name,
      region,
      source: { behaviorType: lambdaFunction.behaviorType, behaviorName },
      properties: {
        runtime,
        memoryMiB: track(unknownFields, "memoryMiB", num(a.MemorySize)),
        timeoutSeconds: track(unknownFields, "timeoutSeconds", num(a.Timeout)),
        entryPoint: image
          ? null
          : track(unknownFields, "entryPoint", str(a.Handler)),
        labels: tagsToLabels(a.Tags),
      },
      refs,
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "environment variables, layers, triggers, aliases and resource policies are not read or translated (variables often hold secrets: move them through a swamp vault)",
    ];
    const decisions: string[] = [
      "no deployment package is rendered: set Code (a zip, or ImageUri for a container) before creating the function",
    ];
    const globalArguments: Record<string, unknown> = {
      FunctionName: targetName,
      region: target.region,
    };
    const canonical = typeof p.runtime === "string" ? p.runtime : null;
    let expectedRuntime: string | null = null;
    if (canonical) {
      const mapped = LAMBDA_RUNTIMES[canonical];
      if (mapped) {
        globalArguments.Runtime = mapped;
        expectedRuntime = canonical;
      } else {
        decisions.push(
          `runtime "${canonical}" is not available on Lambda; port the function to a supported runtime (or use provided.al2023 with a custom runtime)`,
        );
      }
    } else {
      decisions.push(
        "source runtime unknown or not applicable (container image?); choose the Lambda runtime or image",
      );
    }
    if (typeof p.entryPoint === "string") {
      globalArguments.Handler = p.entryPoint;
    }
    let memory: number | null = null;
    if (typeof p.memoryMiB === "number") {
      memory = clamp(p.memoryMiB, 128, 10240, "memory", losses);
      globalArguments.MemorySize = memory;
    }
    let timeout: number | null = null;
    if (typeof p.timeoutSeconds === "number") {
      timeout = clamp(p.timeoutSeconds, 1, 900, "timeout", losses);
      globalArguments.Timeout = timeout;
    }
    const role = firstRef(context, "iam-principal");
    if (role) globalArguments.Role = role;
    else {decisions.push(
        "no execution role is part of the migration; set Role to a role the function can assume",
      );}
    const subnets = allRefs(context, "subnet");
    if (subnets.length > 0) {
      const groups = allRefs(context, "firewall");
      globalArguments.VpcConfig = groups.length > 0
        ? { SubnetIds: subnets, SecurityGroupIds: groups }
        : { SubnetIds: subnets };
    }
    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: lambdaFunction.behaviorType,
      globalArguments,
      expected: {
        runtime: expectedRuntime,
        memoryMiB: memory,
        timeoutSeconds: timeout,
        entryPoint: typeof p.entryPoint === "string" ? p.entryPoint : null,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 64) {
      problems.push(`"${name}" must be 1-64 characters`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      problems.push(
        `"${name}" may only use letters, digits, hyphens and underscores`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// cache: @swamp/aws/elasticache/replication-group
//
// A replication group is ElastiCache's way to run Redis/Valkey from a single
// node up to a clustered, replicated deployment; the older cache-cluster
// resource only does single-node Redis or Memcached. Memcached cannot be a
// replication group, so it becomes a decision. `memoryGiB` is per node.

/** Common cache node types: GiB of memory per node. */
const CACHE_NODES: { type: string; memoryGiB: number }[] = [
  { type: "cache.t4g.micro", memoryGiB: 0.5 },
  { type: "cache.t4g.small", memoryGiB: 1.37 },
  { type: "cache.t4g.medium", memoryGiB: 3.09 },
  { type: "cache.m6g.large", memoryGiB: 6.38 },
  { type: "cache.m6g.xlarge", memoryGiB: 12.93 },
  { type: "cache.m6g.2xlarge", memoryGiB: 26.04 },
  { type: "cache.r6g.large", memoryGiB: 13.07 },
  { type: "cache.r6g.xlarge", memoryGiB: 26.32 },
  { type: "cache.r6g.2xlarge", memoryGiB: 52.82 },
  { type: "cache.r6g.4xlarge", memoryGiB: 105.81 },
];

const cacheGroup: KindAdapter = {
  behaviorType: "@swamp/aws/elasticache/replication-group",
  idField: "ReplicationGroupId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.ReplicationGroupId) ?? str(a._identifier) ?? "";
    // A record without Engine is not assumed to be redis: it may be a list
    // result that left the field out, so the engine is unknown.
    const engineRaw = str(a.Engine);
    const engine = track(
      unknownFields,
      "engine",
      engineRaw === "redis" || engineRaw === "valkey" ||
        engineRaw === "memcached"
        ? engineRaw
        : null,
    );
    const nodeType = str(a.CacheNodeType);
    const memoryGiB = CACHE_NODES.find((n) => n.type === nodeType)?.memoryGiB ??
      null;
    if (memoryGiB === null) unknownFields.push("memoryGiB");
    // Shards x (primary + replicas) when clustered, else NumCacheClusters
    // (one primary plus the rest as replicas, in a single shard).
    let shards = num(a.NumNodeGroups);
    let replicas = num(a.ReplicasPerNodeGroup);
    const clusters = num(a.NumCacheClusters);
    const nodes = shards !== null && replicas !== null
      ? shards * (replicas + 1)
      : clusters;
    if (shards === null && clusters !== null) shards = 1;
    if (replicas === null && shards === 1 && clusters !== null) {
      replicas = Math.max(0, clusters - 1);
    }
    if (nodes === null) unknownFields.push("nodes");
    // The state carries no ARN or zone to read the region from.
    if (regionFallback === null) unknownFields.push("region");
    return {
      id: canonicalId("aws", "cache", name),
      provider: "aws",
      kind: "cache",
      nativeId: name,
      aliases: [],
      name,
      region: regionFallback,
      source: { behaviorType: cacheGroup.behaviorType, behaviorName },
      properties: {
        engine,
        engineVersion: track(
          unknownFields,
          "engineVersion",
          str(a.EngineVersion),
        ),
        memoryGiB,
        nodes,
        // Extra properties (not in KINDS): the shape that `nodes` flattens,
        // and the exact node type, kept so AWS-to-AWS does not guess.
        shards,
        replicasPerShard: replicas,
        nodeType,
        labels: tagsToLabels(a.Tags),
      },
      refs: strings(a.SecurityGroupIds).map((id): ResourceRef => ({
        kind: "firewall",
        nativeId: id,
        via: "SecurityGroupIds",
      })),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "auth token, user groups, snapshots and parameter groups are not translated; the cache starts empty and is rewarmed by the application",
      "in-transit encryption is left at the service default; enable TLS deliberately and update clients",
    ];
    const decisions: string[] = [
      "ElastiCache needs a cache subnet group in the target VPC: create one (@swamp/aws/elasticache/subnet-group) and set CacheSubnetGroupName",
    ];
    const engine = typeof p.engine === "string" ? p.engine : null;
    const globalArguments: Record<string, unknown> = {
      ReplicationGroupId: targetName,
      ReplicationGroupDescription: `Migrated from ${resource.name}`,
      region: target.region,
      AtRestEncryptionEnabled: true,
    };
    let expectedEngine: string | null = null;
    if (engine === "redis" || engine === "valkey") {
      globalArguments.Engine = engine;
      expectedEngine = engine;
    } else if (engine === "memcached") {
      decisions.push(
        "memcached cannot run as an ElastiCache replication group: use @swamp/aws/elasticache/cache-cluster (or serverless-cache) instead",
      );
    } else {
      decisions.push("source cache engine unknown; choose redis or valkey");
    }
    if (typeof p.engineVersion === "string" && expectedEngine) {
      globalArguments.EngineVersion = p.engineVersion;
      if (resource.provider !== "aws") {
        decisions.push(
          `engine version ${p.engineVersion} must be offered by ElastiCache for ${expectedEngine}: confirm or pick another`,
        );
      }
    }
    const wanted = typeof p.memoryGiB === "number" ? p.memoryGiB : null;
    let node: { type: string; memoryGiB: number } | null = null;
    const sourceType = resource.provider === "aws" ? str(p.nodeType) : null;
    if (sourceType !== null) {
      // Keep the source's own node type even when the size table lacks it.
      node = CACHE_NODES.find((n) => n.type === sourceType) ??
        { type: sourceType, memoryGiB: wanted ?? Number.NaN };
    } else if (wanted === null) {
      node = CACHE_NODES[2];
      decisions.push(
        `source memory unknown; ${node.type} was picked as a placeholder, choose the real node type`,
      );
    } else {
      node = CACHE_NODES.filter((n) =>
        n.memoryGiB >= wanted
      ).sort((x, y) => x.memoryGiB - y.memoryGiB)[0] ?? null;
      if (node) {
        losses.push(
          `${wanted} GiB per node maps to ${node.type} (${node.memoryGiB} GiB), the smallest fitting type`,
        );
      } else {decisions.push(
          `no known node type has ${wanted} GiB per node; choose a node type`,
        );}
    }
    if (node) globalArguments.CacheNodeType = node.type;
    const shards = typeof p.shards === "number" && p.shards >= 1
      ? Math.round(p.shards)
      : 1;
    let nodes: number;
    if (shards > 1) {
      // Cluster mode: NumCacheClusters is not used with more than one shard.
      const replicas = clamp(
        typeof p.replicasPerShard === "number"
          ? p.replicasPerShard
          : typeof p.nodes === "number" && p.nodes >= shards
          ? p.nodes / shards - 1
          : 1,
        0,
        5,
        "replicas per shard",
        losses,
      );
      globalArguments.NumNodeGroups = shards;
      globalArguments.ReplicasPerNodeGroup = replicas;
      // Clustered groups require automatic failover.
      globalArguments.AutomaticFailoverEnabled = true;
      globalArguments.MultiAZEnabled = replicas > 0;
      nodes = shards * (replicas + 1);
    } else {
      // One shard: a primary plus up to 5 replicas, 1-6 clusters in all.
      const wantedNodes = typeof p.nodes === "number" && p.nodes >= 1
        ? p.nodes
        : typeof p.replicasPerShard === "number"
        ? p.replicasPerShard + 1
        : 1;
      nodes = clamp(wantedNodes, 1, 6, "node count", losses);
      globalArguments.NumCacheClusters = nodes;
      globalArguments.AutomaticFailoverEnabled = nodes > 1;
      globalArguments.MultiAZEnabled = nodes > 1;
    }
    const groups = allRefs(context, "firewall");
    if (groups.length > 0) globalArguments.SecurityGroupIds = groups;
    else {
      decisions.push(
        "no security group is part of the migration; set SecurityGroupIds so only the application can reach the cache",
      );
    }
    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: cacheGroup.behaviorType,
      globalArguments,
      expected: {
        engine: expectedEngine,
        memoryGiB: node && Number.isFinite(node.memoryGiB)
          ? node.memoryGiB
          : null,
        nodes,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 40) {
      problems.push(`"${name}" must be 1-40 characters`);
    }
    if (!/^[a-zA-Z]/.test(name)) {
      problems.push(`"${name}" must start with a letter`);
    }
    if (!/^[a-zA-Z0-9-]*$/.test(name)) {
      problems.push(`"${name}" may only use letters, digits and hyphens`);
    }
    if (name.endsWith("-") || name.includes("--")) {
      problems.push(
        `"${name}" must not end with a hyphen or contain two in a row`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// file-share: @swamp/aws/efs/file-system

const efsFileSystem: KindAdapter = {
  behaviorType: "@swamp/aws/efs/file-system",
  idField: "FileSystemId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = str(a.FileSystemId) ?? str(a._identifier) ?? "";
    // EFS names are the "Name" tag; it is the human name, the rest are labels.
    const labels = tagsToLabels(a.FileSystemTags);
    const name = labels.Name ?? id;
    delete labels.Name;
    const region = regionFromArn(a.Arn) ??
      regionFromZone(a.AvailabilityZoneName) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    const encrypted = bool(a.Encrypted);
    let encryption: string | null = null;
    if (encrypted === null) unknownFields.push("encryption");
    else if (!encrypted) encryption = "none";
    else {encryption = customKey(a.KmsKeyId)
        ? "customer-key"
        : "provider-managed";}
    const mode = str(a.PerformanceMode);
    const performance = mode === null
      ? track<string>(unknownFields, "performance", null)
      : mode === "maxIO" || a.ThroughputMode === "provisioned"
      ? "high"
      : "standard";
    return {
      id: canonicalId("aws", "file-share", id),
      provider: "aws",
      kind: "file-share",
      nativeId: id,
      aliases: [str(a.Arn)].filter((x): x is string => x !== null),
      name,
      region,
      source: { behaviorType: efsFileSystem.behaviorType, behaviorName },
      properties: {
        protocol: "nfs",
        // EFS grows and shrinks on its own; there is no provisioned capacity.
        capacityGiB: null,
        performance,
        encryption,
        labels,
      },
      refs: kmsRefs(a.KmsKeyId, "KmsKeyId"),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "mount targets, access points, file system and backup policies and replication are not translated; recreate them in the target subnets",
    ];
    const decisions: string[] = [];
    if (p.protocol === "smb") {
      decisions.push(
        "source uses SMB; EFS is NFS only (consider FSx for Windows File Server)",
      );
    }
    const tagged: Record<string, unknown> = {};
    const labels = addTags(tagged, labelsOf(p), losses, "FileSystemTags");
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      region: target.region,
      Encrypted: true,
      PerformanceMode: p.performance === "high" ? "maxIO" : "generalPurpose",
      ThroughputMode: "elastic",
      FileSystemTags: [
        { Key: "Name", Value: targetName },
        ...(tagged.FileSystemTags as { Key: string; Value: string }[] ?? []),
      ],
    };
    if (p.encryption === "none") {
      losses.push(
        "the target is always encrypted at rest (EFS encryption cannot be changed after creation)",
      );
    }
    let encryption = "provider-managed";
    if (p.encryption === "customer-key") {
      const kms = firstRef(context, "kms-key");
      if (kms) {
        globalArguments.KmsKeyId = kms;
        encryption = "customer-key";
      } else {
        decisions.push(
          "source uses a KMS key that is not part of the migration (it may be the AWS-managed aws/elasticfilesystem key, or customer-managed): set KmsKeyId to a key in the target KMS, or accept the AWS-managed key",
        );
      }
    }
    if (p.performance === "high") {
      losses.push(
        '"high" performance maps to the maxIO performance mode, a legacy mode: review it against elastic throughput',
      );
    }
    return {
      behaviorType: efsFileSystem.behaviorType,
      globalArguments,
      expected: {
        protocol: p.protocol === "smb" ? null : "nfs",
        capacityGiB: null,
        performance: p.performance ?? null,
        encryption,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 256) {
      problems.push(`"${name}" must be 1-256 characters`);
    }
    if (!/^[\p{L}\p{Z}\p{N}_.:/=+\-@]+$/u.test(name)) {
      problems.push(
        `"${name}" may only use letters, digits, spaces and _ . : / = + - @`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// nosql-table: @swamp/aws/dynamodb/global-table
//
// The official extension has no plain table behavior; a global table with a
// single replica in its own region is the table resource it offers
// (AWS::DynamoDB::GlobalTable). Tags and point-in-time recovery therefore
// live on the replica.

/** The replica for `region`, or the only replica. */
function replicaFor(
  a: Record<string, unknown>,
  region: string | null,
): Record<string, unknown> | null {
  const replicas = arr(a.Replicas).map(obj).filter((
    r,
  ): r is Record<string, unknown> => r !== null);
  return replicas.find((r) => region !== null && r.Region === region) ??
    (replicas.length === 1 ? replicas[0] : null);
}

const dynamoTable: KindAdapter = {
  behaviorType: "@swamp/aws/dynamodb/global-table",
  idField: "TableName",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.TableName) ?? str(a._identifier) ?? "";
    const region = regionFromArn(a.Arn) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    const keys = arr(a.KeySchema)
      .map(obj)
      .filter((k): k is Record<string, unknown> => k !== null)
      .sort((x, y) =>
        (x.KeyType === "HASH" ? 0 : 1) - (y.KeyType === "HASH" ? 0 : 1)
      )
      .map((k) => str(k.AttributeName))
      .filter((k): k is string => k !== null);
    if (keys.length === 0) unknownFields.push("keys");
    const replica = replicaFor(a, region);
    const pitr = bool(
      obj(replica?.PointInTimeRecoverySpecification)
        ?.PointInTimeRecoveryEnabled,
    );
    if (pitr === null) unknownFields.push("pointInTimeRecovery");
    return {
      id: canonicalId("aws", "nosql-table", name),
      provider: "aws",
      kind: "nosql-table",
      nativeId: name,
      aliases: [str(a.Arn)].filter((x): x is string => x !== null),
      name,
      region,
      source: { behaviorType: dynamoTable.behaviorType, behaviorName },
      properties: {
        name,
        keys,
        // CloudFormation's default when BillingMode is absent is PROVISIONED.
        billing: str(a.BillingMode) === "PAY_PER_REQUEST"
          ? "on-demand"
          : "provisioned",
        pointInTimeRecovery: pitr,
        labels: tagsToLabels(replica?.Tags),
      },
      refs: kmsRefs(
        obj(replica?.SSESpecification)?.KMSMasterKeyId,
        "Replicas.SSESpecification.KMSMasterKeyId",
      ),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [
      "secondary indexes, TTL, streams and autoscaling are not translated; recreate them on the target",
    ];
    const decisions: string[] = [];
    const keys = arr(p.keys).map(str).filter((k): k is string => k !== null);
    const globalArguments: Record<string, unknown> = {
      TableName: targetName,
      region: target.region,
      BillingMode: "PAY_PER_REQUEST",
    };
    if (p.billing === "provisioned") {
      decisions.push(
        "source uses provisioned capacity, which is not carried; the table is on-demand: set read/write capacity if you want provisioned billing",
      );
    }
    const used = keys.slice(0, 2);
    if (used.length === 0) {
      decisions.push(
        "source key schema unknown; define KeySchema and AttributeDefinitions",
      );
    } else {
      globalArguments.KeySchema = used.map((AttributeName, i) => ({
        AttributeName,
        KeyType: i === 0 ? "HASH" : "RANGE",
      }));
      globalArguments.AttributeDefinitions = used.map((AttributeName) => ({
        AttributeName,
        AttributeType: "S",
      }));
      decisions.push(
        "key attribute types are not carried; they are assumed to be string (S): confirm against the data",
      );
      if (keys.length > 2) {
        decisions.push(
          `source has ${keys.length} key attributes; DynamoDB allows two (partition and sort)`,
        );
      }
    }
    const replica: Record<string, unknown> = { Region: target.region };
    const labels = addTags(replica, labelsOf(p), losses);
    if (typeof p.pointInTimeRecovery === "boolean") {
      replica.PointInTimeRecoverySpecification = {
        PointInTimeRecoveryEnabled: p.pointInTimeRecovery,
      };
    }
    const kms = firstRef(context, "kms-key");
    if (kms) {
      globalArguments.SSESpecification = { SSEEnabled: true, SSEType: "KMS" };
      replica.SSESpecification = { KMSMasterKeyId: kms };
    }
    globalArguments.Replicas = [replica];
    return {
      behaviorType: dynamoTable.behaviorType,
      globalArguments,
      expected: {
        name: targetName,
        keys: used,
        billing: "on-demand",
        pointInTimeRecovery: typeof p.pointInTimeRecovery === "boolean"
          ? p.pointInTimeRecovery
          : null,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 3 || name.length > 255) {
      problems.push(`"${name}" must be 3-255 characters`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      problems.push(`"${name}" may only use letters, digits, "_", "." and "-"`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// kms-key: @swamp/aws/kms/key

const kmsKey: KindAdapter = {
  behaviorType: "@swamp/aws/kms/key",
  idField: "Arn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const keyId = str(a.KeyId) ?? str(a._identifier) ?? "";
    const labels = tagsToLabels(a.Tags);
    // Keys have no name of their own; the "Name" tag is the convention.
    const name = labels.Name ?? keyId;
    const usage = str(a.KeyUsage);
    const purpose = usage === "ENCRYPT_DECRYPT"
      ? "encrypt"
      : usage === "SIGN_VERIFY"
      ? "sign"
      : null;
    if (usage === null) unknownFields.push("purpose");
    const region = regionFromArn(a.Arn) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("aws", "kms-key", keyId),
      provider: "aws",
      kind: "kms-key",
      nativeId: keyId,
      aliases: [str(a.Arn)].filter((x): x is string => x !== null),
      name,
      region,
      source: { behaviorType: kmsKey.behaviorType, behaviorName },
      properties: {
        purpose,
        // CloudFormation's default when absent is rotation off.
        rotation: bool(a.EnableKeyRotation) ?? false,
        labels,
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const losses: string[] = [
      "key policy and aliases are not translated; the key gets the default policy (account root): add your own and an alias",
    ];
    const decisions: string[] = [];
    const sign = p.purpose === "sign";
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      region: target.region,
      Description: `Migrated from ${resource.name}`,
      KeyUsage: sign ? "SIGN_VERIFY" : "ENCRYPT_DECRYPT",
    };
    if (sign) {
      globalArguments.KeySpec = "RSA_2048";
      decisions.push(
        "signing key algorithm is not carried; RSA_2048 was assumed: choose the key spec",
      );
    } else if (p.purpose !== "encrypt") {
      decisions.push(
        "source key purpose is unknown or neither encrypt nor sign; the target is a symmetric encryption key: confirm",
      );
    }
    let rotation: boolean | null = null;
    if (typeof p.rotation === "boolean") {
      if (sign) {
        if (p.rotation) {
          losses.push(
            "automatic rotation is not available for asymmetric signing keys",
          );
        }
        rotation = false;
      } else {
        globalArguments.EnableKeyRotation = p.rotation;
        rotation = p.rotation;
      }
    }
    const labels = addTags(globalArguments, labelsOf(p), losses);
    return {
      behaviorType: kmsKey.behaviorType,
      globalArguments,
      expected: { purpose: sign ? "sign" : "encrypt", rotation, labels },
      losses,
      decisions,
    };
  },
  validateName(name) {
    // The instance name doubles as the key's Name tag and future alias.
    const problems: string[] = [];
    if (name.length < 1 || name.length > 250) {
      problems.push(`"${name}" must be 1-250 characters`);
    }
    if (!/^[a-zA-Z0-9/_-]+$/.test(name)) {
      problems.push(
        `"${name}" may only use letters, digits, "/", "_" and "-" (key alias rules)`,
      );
    }
    if (name.startsWith("aws/")) {
      problems.push(
        `"${name}" must not start with "aws/" (reserved for AWS-managed keys)`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// secret: @swamp/aws/secretsmanager/secret

const secret: KindAdapter = {
  behaviorType: "@swamp/aws/secretsmanager/secret",
  idField: "Id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    // SecretString and GenerateSecretString are deliberately never read.
    const id = str(a.Id) ?? str(a._identifier) ?? str(a.Name) ?? "";
    const name = str(a.Name) ?? nameFromArn(id) ?? "";
    const region = regionFromArn(id) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("aws", "secret", id),
      provider: "aws",
      kind: "secret",
      nativeId: id,
      aliases: [name].filter((x) => x.length > 0),
      name,
      region,
      source: { behaviorType: secret.behaviorType, behaviorName },
      properties: {
        name,
        // The rotation schedule is a separate behavior, so the state never shows it.
        rotation: null,
        labels: tagsToLabels(a.Tags),
      },
      refs: kmsRefs(a.KmsKeyId, "KmsKeyId"),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    // Only the container is rendered: no SecretString, no GenerateSecretString.
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      Name: targetName,
      region: target.region,
    };
    const kms = firstRef(context, "kms-key");
    if (kms) globalArguments.KmsKeyId = kms;
    const losses = [
      "the secret is created empty: its value is not copied (use a vault) and replication is not translated",
    ];
    const labels = addTags(globalArguments, labelsOf(p), losses);
    if (p.rotation === true) {
      losses.push(
        "rotation schedule is not translated; reconfigure rotation on the target",
      );
    }
    return {
      behaviorType: secret.behaviorType,
      globalArguments,
      expected: { name: targetName, rotation: null, labels },
      losses,
      decisions: [],
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 512) {
      problems.push(`"${name}" must be 1-512 characters`);
    }
    if (!/^[A-Za-z0-9/_+=.@-]+$/.test(name)) {
      problems.push(`"${name}" may only use letters, digits and / _ + = . @ -`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// iam-principal: @swamp/aws/iam/role

const iamRole: KindAdapter = {
  behaviorType: "@swamp/aws/iam/role",
  idField: "Arn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const name = str(a.RoleName) ?? str(a._identifier) ?? nameFromArn(a.Arn) ??
      "";
    return {
      id: canonicalId("aws", "iam-principal", name),
      provider: "aws",
      kind: "iam-principal",
      nativeId: name,
      aliases: [str(a.Arn), str(a.RoleId)].filter((x): x is string =>
        x !== null
      ),
      name,
      // IAM is global; the fallback only says where the scope was inventoried.
      region: regionFallback,
      source: { behaviorType: iamRole.behaviorType, behaviorName },
      properties: {
        name,
        principalType: "role",
        description: str(a.Description),
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields: [],
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const description = typeof p.description === "string"
      ? p.description
      : null;
    const globalArguments: Record<string, unknown> = {
      RoleName: targetName,
      region: target.region,
    };
    if (description) globalArguments.Description = description;
    return {
      behaviorType: iamRole.behaviorType,
      globalArguments,
      expected: { name: targetName, principalType: "role", description },
      losses: [],
      decisions: [
        "an IAM role needs a trust policy (AssumeRolePolicyDocument) saying who may assume it: write it for the target workload; none is rendered",
        "attached and inline policies are not translated: attach least-privilege policies for the target's resources",
      ],
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 64) {
      problems.push(`"${name}" must be 1-64 characters`);
    }
    if (!/^[\w+=,.@-]+$/.test(name)) {
      problems.push(`"${name}" may only use letters, digits and + = , . @ - _`);
    }
    return problems;
  },
};

/** Kind adapters merged into the provider in its main file. */
export const awsServiceKinds: ProviderAdapter["kinds"] = {
  "sql-database": dbInstance,
  "container-registry": ecrRepository,
  "message-topic": snsTopic,
  "message-queue": sqsQueue,
  function: lambdaFunction,
  cache: cacheGroup,
  "file-share": efsFileSystem,
  "nosql-table": dynamoTable,
  "kms-key": kmsKey,
  secret,
  "iam-principal": iamRole,
};

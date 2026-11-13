/**
 * Google Cloud adapters, over the official `@swamp/gcp/*` behaviors. Their
 * state attributes are the Google REST API's JSON field names.
 *
 * @module
 */
import {
  arr,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  obj,
  type ProviderAdapter,
  str,
  stringMap,
  toGcpLabels,
} from "../adapter.ts";
import { gcpInfraKinds } from "./gcp_infra.ts";
import { gcpServiceKinds } from "./gcp_services.ts";
import {
  bucketCaveats,
  bucketExpected,
  commonBucketNameProblems,
} from "./aws.ts";

const GCS_TIERS: Record<string, string> = {
  STANDARD: "hot",
  MULTI_REGIONAL: "hot",
  REGIONAL: "hot",
  NEARLINE: "cool",
  COLDLINE: "cold",
  ARCHIVE: "archive",
};

const GCS_CLASS_FOR_TIER: Record<string, string> = {
  hot: "STANDARD",
  cool: "NEARLINE",
  cold: "COLDLINE",
  archive: "ARCHIVE",
};

const bucket: KindAdapter = {
  behaviorType: "@swamp/gcp/storage/buckets",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? str(a.id) ?? "";

    const versioningBlock = obj(a.versioning);
    const versioning = versioningBlock
      ? versioningBlock.enabled === true
      : null;
    if (versioning === null) unknownFields.push("versioning");

    // GCS always encrypts; a default KMS key means customer-managed.
    const kmsKey = str(obj(a.encryption)?.defaultKmsKeyName);
    const encryption = kmsKey ? "customer-key" : "provider-managed";

    const prevention = str(obj(a.iamConfiguration)?.publicAccessPrevention);
    const publicAccess = prevention === "enforced"
      ? "blocked"
      : prevention === null
      ? null
      : "allowed";
    if (publicAccess === null) unknownFields.push("publicAccess");

    const storageClass = str(a.storageClass);
    const tier = storageClass ? GCS_TIERS[storageClass] ?? null : null;
    if (tier === null) unknownFields.push("tier");

    const location = str(a.location)?.toLowerCase() ?? regionFallback;
    if (location === null) unknownFields.push("region");

    return {
      id: canonicalId("gcp", "object-bucket", name),
      provider: "gcp",
      kind: "object-bucket",
      nativeId: name,
      aliases: [str(a.selfLink), str(a.id)].filter((x): x is string =>
        x !== null
      ),
      name,
      region: location,
      source: { behaviorType: bucket.behaviorType, behaviorName },
      properties: {
        versioning,
        encryption,
        publicAccess,
        tier,
        labels: stringMap(a.labels),
        lifecycleRules: arr(obj(a.lifecycle)?.rule).length,
        cors: arr(a.cors).length > 0,
        website: obj(a.website) !== null,
        retentionLocked: obj(a.retentionPolicy)?.isLocked === true,
      },
      refs: kmsKey
        ? [{
          kind: "kms-key",
          nativeId: kmsKey,
          via: "encryption.defaultKmsKeyName",
        }]
        : [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const { losses, decisions } = bucketCaveats(p);
    if (!target.project) {
      decisions.push("target.project is required to create a GCS bucket");
    }
    const tier = typeof p.tier === "string" ? p.tier : "hot";
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      location: target.region.toUpperCase(),
      storageClass: GCS_CLASS_FOR_TIER[tier] ?? "STANDARD",
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: true },
        publicAccessPrevention: p.publicAccess === "allowed"
          ? "inherited"
          : "enforced",
      },
    };
    if (target.project) globalArguments.project = target.project;
    if (typeof p.versioning === "boolean") {
      globalArguments.versioning = { enabled: p.versioning };
    }
    if (p.encryption === "none") {
      losses.push(
        "GCS always encrypts at rest; the target uses Google-managed keys",
      );
    }
    const gcpLabels = toGcpLabels((p.labels ?? {}) as Record<string, string>);
    losses.push(...gcpLabels.losses);
    if (Object.keys(gcpLabels.labels).length > 0) {
      globalArguments.labels = gcpLabels.labels;
    }
    // Fine-grained ACLs do not survive uniform bucket-level access.
    if (resource.provider !== "gcp") {
      losses.push(
        "object ACLs are not carried over; the target uses uniform bucket-level IAM",
      );
    }
    return {
      behaviorType: bucket.behaviorType,
      globalArguments,
      expected: { ...bucketExpected(p, true), labels: gcpLabels.labels },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems = commonBucketNameProblems(name);
    if (!/^[a-z0-9._-]+$/.test(name)) {
      problems.push(
        `"${name}" may only use lowercase letters, digits, "-", "_" and "." on GCS`,
      );
    }
    if (name.includes(".")) {
      problems.push(
        `"${name}" contains "." which needs Search Console domain verification on GCS`,
      );
    }
    if (name.startsWith("goog") || name.includes("google")) {
      problems.push(
        `"${name}" must not start with "goog" or contain "google" on GCS`,
      );
    }
    return problems;
  },
};

/** The Google Cloud provider adapter. */
export const gcp: ProviderAdapter = {
  id: "gcp",
  displayName: "Google Cloud",
  kinds: {
    "object-bucket": bucket,
    ...gcpInfraKinds,
    ...gcpServiceKinds,
  },
};

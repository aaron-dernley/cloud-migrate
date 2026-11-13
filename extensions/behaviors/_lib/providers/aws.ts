/**
 * Amazon Web Services adapters, over the official `@swamp/aws/*` behaviors.
 * Their state attributes are AWS Cloud Control (CloudFormation) property
 * names, so that is what these adapters read and render.
 *
 * @module
 */
import {
  arr,
  bool,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  obj,
  type ProviderAdapter,
  str,
  tagsToLabels,
} from "../adapter.ts";
import { awsInfraKinds, awsTags, withoutReserved } from "./aws_infra.ts";
import { awsServiceKinds } from "./aws_services.ts";

/** Bucket-name rules shared by S3 and GCS: 3-63 chars, lowercase start/end. */
export function commonBucketNameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length < 3 || name.length > 63) {
    problems.push(`"${name}" must be 3-63 characters`);
  }
  if (!/^[a-z0-9].*[a-z0-9]$/.test(name)) {
    problems.push(
      `"${name}" must start and end with a lowercase letter or digit`,
    );
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    problems.push(`"${name}" must not look like an IP address`);
  }
  return problems;
}

/** Losses and decisions every object-bucket target shares. */
export function bucketCaveats(
  p: Record<string, unknown>,
): { losses: string[]; decisions: string[] } {
  const losses: string[] = [];
  const decisions: string[] = [];
  const rules = typeof p.lifecycleRules === "number" ? p.lifecycleRules : 0;
  if (rules > 0) {
    losses.push(
      `${rules} lifecycle rule(s) are not translated; rewrite them for the target`,
    );
  }
  if (p.cors === true) {
    losses.push("CORS policy is not translated; recreate it on the target");
  }
  if (p.website === true) {
    losses.push(
      "static website hosting is not translated; the target serves websites differently (CDN/load balancer)",
    );
  }
  if (p.encryption === "customer-key") {
    decisions.push(
      "source uses a customer-managed key; choose or create a key in the target's KMS",
    );
  }
  if (p.retentionLocked === true) {
    decisions.push(
      "source has a locked retention policy / object lock; confirm the target retention before any data lands (locks are irreversible)",
    );
  }
  if (p.publicAccess === "allowed") {
    decisions.push(
      "source allows public access; confirm the target should be public too",
    );
  }
  return { losses, decisions };
}

/** What every target bucket ends up as: untranslated features start off. */
export function bucketExpected(
  p: Record<string, unknown>,
  hasBucketTier: boolean,
): Record<string, unknown> {
  return {
    versioning: p.versioning ?? null,
    encryption: p.encryption === "none"
      ? "provider-managed"
      : p.encryption ?? null,
    publicAccess: p.publicAccess === "allowed" ? "allowed" : "blocked",
    tier: hasBucketTier ? p.tier ?? "hot" : null,
    retentionLocked: p.retentionLocked ?? null,
    lifecycleRules: 0,
    cors: false,
    website: false,
  };
}

const S3_REGION_FROM_DOMAIN = /\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/;

/** Bucket configuration blocks a get/sync record carries and a bare list result does not. */
const CONFIG_FIELDS = [
  "BucketEncryption",
  "PublicAccessBlockConfiguration",
  "Tags",
  "LifecycleConfiguration",
  "CorsConfiguration",
  "WebsiteConfiguration",
  "ObjectLockConfiguration",
  "ObjectLockEnabled",
  "OwnershipControls",
  "NotificationConfiguration",
  "LoggingConfiguration",
  "ReplicationConfiguration",
];

const bucket: KindAdapter = {
  behaviorType: "@swamp/aws/s3/bucket",
  idField: "BucketName",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.BucketName) ?? str(a._identifier) ?? "";

    // A get/sync record that carries any bucket configuration but no
    // VersioningConfiguration describes an unversioned bucket (Cloud Control
    // omits unset properties). Only a bare list result, which has none of the
    // configuration blocks at all, leaves versioning genuinely unknown.
    let versioningStatus = str(obj(a.VersioningConfiguration)?.Status);
    if (versioningStatus === null) {
      const looksBare = !CONFIG_FIELDS.some((f) => a[f] !== undefined);
      if (looksBare) unknownFields.push("versioning");
      else versioningStatus = "Suspended";
    }

    const sse = arr(obj(a.BucketEncryption)?.ServerSideEncryptionConfiguration)
      .map((rule) => obj(obj(rule)?.ServerSideEncryptionByDefault))
      .find((d) => d !== null);
    let encryption: string | null = null;
    if (sse) {
      encryption = str(sse.KMSMasterKeyID)
        ? "customer-key"
        : "provider-managed";
    } else if (a.BucketEncryption === undefined) {
      // S3 encrypts every new object with SSE-S3 since 2023-01, but an
      // absent block may also just mean the list call did not return it.
      unknownFields.push("encryption");
    }

    const pab = obj(a.PublicAccessBlockConfiguration);
    let publicAccess: string | null = null;
    if (pab) {
      publicAccess = pab.BlockPublicAcls === true &&
          pab.BlockPublicPolicy === true &&
          pab.IgnorePublicAcls === true &&
          pab.RestrictPublicBuckets === true
        ? "blocked"
        : "allowed";
    } else {
      unknownFields.push("publicAccess");
    }

    const domain = str(a.RegionalDomainName);
    const region = domain?.match(S3_REGION_FROM_DOMAIN)?.[1] ?? regionFallback;
    if (region === null) unknownFields.push("region");

    const kmsKey = sse ? str(sse.KMSMasterKeyID) : null;
    return {
      id: canonicalId("aws", "object-bucket", name),
      provider: "aws",
      kind: "object-bucket",
      nativeId: name,
      aliases: [str(a.Arn)].filter((x): x is string => x !== null),
      name,
      region,
      source: { behaviorType: bucket.behaviorType, behaviorName },
      properties: {
        versioning: versioningStatus === null
          ? null
          : versioningStatus === "Enabled",
        encryption,
        publicAccess,
        // S3 has no bucket-level default storage class.
        tier: null,
        labels: tagsToLabels(a.Tags),
        lifecycleRules: arr(obj(a.LifecycleConfiguration)?.Rules).length,
        cors: arr(obj(a.CorsConfiguration)?.CorsRules).length > 0,
        website: obj(a.WebsiteConfiguration) !== null,
        retentionLocked: bool(a.ObjectLockEnabled) === true ||
          obj(a.ObjectLockConfiguration)?.ObjectLockEnabled === "Enabled",
      },
      refs: kmsKey
        ? [{ kind: "kms-key", nativeId: kmsKey, via: "KMSMasterKeyID" }]
        : [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const { losses, decisions } = bucketCaveats(p);
    const globalArguments: Record<string, unknown> = {
      BucketName: targetName,
      region: target.region,
    };
    if (typeof p.versioning === "boolean") {
      globalArguments.VersioningConfiguration = {
        Status: p.versioning ? "Enabled" : "Suspended",
      };
    }
    if (p.encryption === "provider-managed" || p.encryption === "none") {
      if (p.encryption === "none") {
        losses.push("S3 always encrypts at rest; the target uses SSE-S3");
      }
      globalArguments.BucketEncryption = {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
        }],
      };
    }
    if (p.publicAccess !== "allowed") {
      globalArguments.PublicAccessBlockConfiguration = {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      };
    }
    const allLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(p.labels) ?? {})) {
      if (typeof v === "string") allLabels[k] = v;
    }
    const { tags, losses: tagLosses } = awsTags(allLabels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    const labels = withoutReserved(allLabels);
    if (typeof p.tier === "string" && p.tier !== "hot") {
      decisions.push(
        `source default tier is "${p.tier}"; S3 has no bucket default class, so choose a lifecycle transition or Intelligent-Tiering`,
      );
    }
    return {
      behaviorType: bucket.behaviorType,
      globalArguments,
      expected: { ...bucketExpected(p, false), labels },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems = commonBucketNameProblems(name);
    if (!/^[a-z0-9.-]+$/.test(name)) {
      problems.push(
        `"${name}" may only use lowercase letters, digits, "." and "-" on S3`,
      );
    }
    if (name.includes("..")) problems.push(`"${name}" must not contain ".."`);
    return problems;
  },
};

/** The AWS provider adapter. */
export const aws: ProviderAdapter = {
  id: "aws",
  displayName: "Amazon Web Services",
  kinds: {
    "object-bucket": bucket,
    ...awsInfraKinds,
    ...awsServiceKinds,
  },
};

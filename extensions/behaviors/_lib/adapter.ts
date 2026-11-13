/**
 * The adapter contract every provider implements, and small helpers for
 * reading loosely typed provider records.
 *
 * @module
 */
import type { ResourceKind } from "./kinds.ts";

/** A reference from one resource to another, by the other's native id. */
export interface ResourceRef {
  kind: ResourceKind;
  /** Any id the other resource is known by: an id, ARN, self link or name. */
  nativeId: string;
  /** The field it came from, for messages, e.g. "SubnetId". */
  via: string;
}

/** One provider resource, normalised. */
export interface CanonicalResource {
  /** Stable id: `<provider>:<kind>:<nativeId>`. */
  id: string;
  provider: string;
  kind: ResourceKind;
  /** The provider's primary identifier. */
  nativeId: string;
  /** Other identifiers other resources may use for it (ARN, self link, name). */
  aliases: string[];
  /** Human name, used to derive target names. */
  name: string;
  /** Region/location, or null when the record does not carry it. */
  region: string | null;
  /** The swamp behavior whose data this came from. */
  source: { behaviorType: string; behaviorName: string };
  /** Canonical properties for this kind; see KINDS[kind].properties. */
  properties: Record<string, unknown>;
  /** References to other resources, resolved into dependsOn by inventory. */
  refs: ResourceRef[];
  /** Canonical ids this resource needs to exist first (filled by inventory). */
  dependsOn: string[];
  /** Refs that matched nothing in scope (filled by inventory). */
  unresolvedRefs?: ResourceRef[];
  /** Data volume in bytes when the record says, for egress estimates. */
  dataBytes: number | null;
  /** Properties the record lacked; mapping asks for a refresh before trusting them. */
  unknownFields: string[];
}

/** Where target resources go. */
export interface TargetSettings {
  provider: string;
  region: string;
  /** Project/account/subscription scope, for providers that need one (GCP). */
  project?: string;
}

/** What render needs to know about the rest of the migration. */
export interface RenderContext {
  /**
   * A swamp CEL expression that resolves to the provisioned target id of a
   * dependency, or null when that dependency is not part of the migration.
   * `field` is the attribute on the dependency's target state data; it
   * defaults to that kind adapter's `idField`.
   */
  refTo(sourceId: string, field?: string): string | null;
  /** Canonical ids of this resource's dependencies, by kind. */
  dependencies(kind: ResourceKind): string[];
  /** The target name of a dependency, or null when it is not migrated. */
  targetNameOf(sourceId: string): string | null;
}

/** The global arguments for a target behavior, plus what could not carry over. */
export interface RenderResult {
  behaviorType: string;
  globalArguments: Record<string, unknown>;
  /** Canonical properties the provisioned target must show (parity compares these). */
  expected: Record<string, unknown>;
  /** Things the target cannot express exactly; each makes the mapping "lossy". */
  losses: string[];
  /** Things a person must decide first; each makes the mapping "needs-decision". */
  decisions: string[];
}

/** One supported kind on one provider. */
export interface KindAdapter {
  /** The swamp behavior type that models this resource. */
  behaviorType: string;
  /** The state attribute holding the id other target resources reference. */
  idField: string;
  /**
   * For a behavior type that models more than one kind (DigitalOcean's
   * database clusters are SQL databases or caches by engine): whether this
   * record is this kind. Omit when the type models one kind only.
   */
  accepts?(attributes: Record<string, unknown>): boolean;
  /** `state` attributes → canonical. `region` is a fallback from the scope. */
  normalise(
    attributes: Record<string, unknown>,
    behaviorName: string,
    region: string | null,
  ): CanonicalResource;
  /** Canonical (from any provider) → this provider's global arguments. */
  render(
    resource: CanonicalResource,
    targetName: string,
    target: TargetSettings,
    context: RenderContext,
  ): RenderResult;
  /** Problems with `name` as a resource name on this provider; [] when fine. */
  validateName(name: string): string[];
}

/** A cloud provider: an id and the kinds it supports. */
export interface ProviderAdapter {
  id: string;
  displayName: string;
  kinds: Partial<Record<ResourceKind, KindAdapter>>;
}

// ---------------------------------------------------------------------------
// Helpers for reading provider records

/** `value` as a plain object, or null. */
export function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `value` as an array, or []. */
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `value` as a non-empty string, or null. */
export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `value` as a finite number (numeric strings included), or null. */
export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** `value` as a boolean, or null. */
export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** AWS-style `[{Key, Value}]` tags → a label map. */
export function tagsToLabels(tags: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of arr(tags)) {
    const t = obj(tag);
    const key = str(t?.Key);
    if (key && typeof t?.Value === "string") labels[key] = t.Value;
  }
  return labels;
}

/** A label map → AWS-style `[{Key, Value}]` tags. */
export function labelsToTags(
  labels: Record<string, string>,
): { Key: string; Value: string }[] {
  return Object.entries(labels).map(([Key, Value]) => ({ Key, Value }));
}

/** A plain string map from an object of labels, ignoring non-string values. */
export function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(value) ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Labels rewritten to GCP's rules (lowercase keys starting with a letter,
 * `[a-z0-9_-]`, ≤63 chars), with a loss for every label that changed.
 */
export function toGcpLabels(
  labels: Record<string, string>,
): { labels: Record<string, string>; losses: string[] } {
  const out: Record<string, string> = {};
  const losses: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    let key = k.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!/^[a-z]/.test(key)) key = `l_${key}`;
    key = key.slice(0, 63);
    const value = v.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
    if (key !== k || value !== v) {
      losses.push(
        `label "${k}=${v}" becomes "${key}=${value}" (GCP label rules)`,
      );
    }
    out[key] = value;
  }
  return { labels: out, losses };
}

/** Labels flattened to `key:value` / `key` strings, for providers with string tags (DigitalOcean). */
export function labelsToStringTags(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([k, v]) => (v ? `${k}:${v}` : k));
}

/** String tags (`key:value` or `key`) back to a label map. */
export function stringTagsToLabels(tags: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of arr(tags)) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    const i = tag.indexOf(":");
    if (i === -1) out[tag] = "";
    else out[tag.slice(0, i)] = tag.slice(i + 1);
  }
  return out;
}

/** Push `field` onto `unknown` when `value` is null; returns `value`. */
export function track<T>(
  unknown: string[],
  field: string,
  value: T | null,
): T | null {
  if (value === null) unknown.push(field);
  return value;
}

/** Build the canonical id for a resource. */
export function canonicalId(
  provider: string,
  kind: ResourceKind,
  nativeId: string,
): string {
  return `${provider}:${kind}:${nativeId}`;
}

/** The last path segment of a URL or resource path (`.../zones/europe-west2-a` → `europe-west2-a`). */
export function lastSegment(value: unknown): string | null {
  const s = str(value);
  return s ? s.split("/").filter(Boolean).pop() ?? null : null;
}

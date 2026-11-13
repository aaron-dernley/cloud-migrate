/**
 * Provider-neutral planning: resolving dependencies between inventoried
 * resources, mapping them onto a target, ordering them into waves, and
 * comparing a provisioned target against what the mapping promised. Pure
 * functions over plain data, so every rule here is unit-tested without a
 * cloud.
 *
 * @module
 */
import type {
  CanonicalResource,
  RenderContext,
  ResourceRef,
  TargetSettings,
} from "./adapter.ts";
import { KINDS, type ResourceKind } from "./kinds.ts";
import {
  getProvider,
  type TransferStrategy,
  transferStrategy,
} from "./providers.ts";

/**
 * How faithfully a resource carries over. "excluded" means a person decided
 * to leave it out of the migration.
 */
export type Fidelity =
  | "exact"
  | "lossy"
  | "needs-decision"
  | "unsupported"
  | "excluded";

/** A person's answer to one or all of a resource's open decisions. */
export interface Resolution {
  /**
   * Text that identifies the decision this settles (a substring of it), or
   * null to settle every decision open on the resource.
   */
  decision: string | null;
  /** What was decided, in the person's words. */
  resolution: string;
  /** Merged into the target's global arguments; a null value removes a key. */
  overrides: Record<string, unknown>;
  /** Leave the resource out of the migration. */
  exclude: boolean;
  /**
   * Replace the planned data transfer method, e.g. "rebuild from config
   * management" where the default would replicate disks.
   */
  transfer?: { id: string; description: string } | null;
  /** Who decided. */
  by: string;
  at: string;
}

/** Every resolution recorded for a migration, by source id, oldest first. */
export type Resolutions = Record<string, Resolution[]>;

/** A decision a resolution settled. */
export interface ResolvedDecision {
  decision: string;
  resolution: string;
  by: string;
  at: string;
}

export interface MappingEntry {
  sourceId: string;
  kind: ResourceKind;
  sourceName: string;
  targetName: string;
  /** Name of the swamp behavior to create on the target. */
  targetBehaviorName: string;
  targetBehaviorType: string | null;
  globalArguments: Record<string, unknown>;
  fidelity: Fidelity;
  losses: string[];
  decisions: string[];
  /** Canonical properties the target must show once provisioned. */
  expected: Record<string, unknown> | null;
  dependsOn: string[];
  /** Decisions a person has settled (see `resolve`). */
  resolved: ResolvedDecision[];
  /** Resolutions whose decision text no longer matches any decision. */
  staleResolutions: string[];
  /**
   * Every resolution applied to the entry, including ones that only set
   * values or the transfer method and so settled no decision.
   */
  appliedResolutions: AppliedResolution[];
  /** A person's replacement for the planned transfer method, if any. */
  transferOverride: { id: string; description: string } | null;
}

/** A resolution as it shows on the entry it was applied to. */
export interface AppliedResolution {
  resolution: string;
  by: string;
  at: string;
  /** Top-level global arguments it set. */
  overrideKeys: string[];
  exclude: boolean;
  transfer: string | null;
}

/** Fill `{name}` in a target name template, lowercased. */
export function targetNameFor(template: string, sourceName: string): string {
  return template.replaceAll("{name}", sourceName).toLowerCase();
}

/** Behavior names must be filesystem- and CEL-friendly. */
export function behaviorNameFor(
  migration: string,
  kind: string,
  targetName: string,
): string {
  return `${migration}-${kind}-${targetName}`.toLowerCase().replace(
    /[^a-z0-9-]/g,
    "-",
  )
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Resolve each resource's refs to the canonical ids of other inventoried
 * resources (by native id or alias). Refs that match nothing are kept in
 * `unresolvedRefs`: the mapping asks a person whether that dependency moves
 * too or stays where it is.
 */
export function resolveDependencies(
  resources: CanonicalResource[],
): CanonicalResource[] {
  const index = new Map<string, string>();
  for (const r of resources) {
    for (const key of [r.nativeId, ...r.aliases]) {
      if (key) index.set(`${r.kind}|${key}`, r.id);
    }
  }
  return resources.map((r) => {
    const dependsOn = new Set<string>();
    const unresolvedRefs: ResourceRef[] = [];
    for (const ref of r.refs) {
      const id = index.get(`${ref.kind}|${ref.nativeId}`);
      if (id && id !== r.id) dependsOn.add(id);
      else if (!id) unresolvedRefs.push(ref);
    }
    return { ...r, dependsOn: [...dependsOn].sort(), unresolvedRefs };
  });
}

/**
 * Map every inventoried resource onto the target provider, then apply the
 * resolutions people have recorded. Resources a resolution excludes are not
 * migrated, so their dependents render as if the dependency stays behind.
 */
export function mapResources(
  resources: CanonicalResource[],
  target: TargetSettings,
  migration: string,
  nameTemplate: string,
  resolutions: Resolutions = {},
): MappingEntry[] {
  const provider = getProvider(target.provider);
  const excluded = new Set(
    Object.entries(resolutions).filter(([, rs]) => rs.some((r) => r.exclude))
      .map(([id]) => id),
  );
  const byId = new Map(
    resources.filter((r) => !excluded.has(r.id)).map((r) => [r.id, r]),
  );
  // The source's address space: networks and subnets, kept even when they
  // move, because during the dual run the source copies still exist.
  const sourceRanges = resources
    .filter((r) => r.kind === "network" || r.kind === "subnet")
    .filter((r) => typeof r.properties.cidr === "string")
    .map((r) => ({ id: r.id, cidr: r.properties.cidr as string }));
  const names = new Map(
    resources.map((r) => {
      const targetName = targetNameFor(nameTemplate, r.name);
      return [r.id, {
        targetName,
        behaviorName: behaviorNameFor(migration, r.kind, targetName),
      }];
    }),
  );

  return resources.map((resource) => {
    const { targetName, behaviorName } = names.get(resource.id)!;
    const base = {
      sourceId: resource.id,
      kind: resource.kind,
      sourceName: resource.name,
      targetName,
      targetBehaviorName: behaviorName,
      dependsOn: resource.dependsOn.filter((id) => !excluded.has(id)),
      resolved: [],
      staleResolutions: [],
      appliedResolutions: [],
      transferOverride: null,
    };
    const adapter = provider.kinds[resource.kind];
    if (!adapter) {
      return applyResolutions({
        ...base,
        targetBehaviorType: null,
        globalArguments: {},
        fidelity: "unsupported" as const,
        losses: [],
        decisions: [
          `${provider.displayName} has no adapter for kind "${resource.kind}" yet; recreate it by hand or leave it out of scope`,
        ],
        expected: null,
      }, resolutions[resource.id] ?? []);
    }

    const context: RenderContext = {
      refTo(sourceId, field) {
        const dep = byId.get(sourceId);
        const depAdapter = dep ? provider.kinds[dep.kind] : undefined;
        const depName = names.get(sourceId)?.behaviorName;
        if (!dep || !depAdapter || !depName) return null;
        return `\${{ data.findBySpec(${
          JSON.stringify(depName)
        }, "state")[0].attributes.${field ?? depAdapter.idField} }}`;
      },
      dependencies(kind) {
        return resource.dependsOn.filter((id) => byId.get(id)?.kind === kind);
      },
      targetNameOf(sourceId) {
        return byId.has(sourceId)
          ? names.get(sourceId)?.targetName ?? null
          : null;
      },
    };

    const rendered = adapter.render(resource, targetName, target, context);
    const rs = resolutions[resource.id] ?? [];
    // What the target will really be once overrides apply: parity and the
    // range check both judge that, not the first render.
    const finalArgs = rs.reduce(
      (args, r) => deepMerge(args, r.overrides),
      rendered.globalArguments,
    );
    const expected = rs.some((r) => Object.keys(r.overrides).length > 0)
      ? refreshExpected(
        rendered.expected,
        adapter.normalise(finalArgs, behaviorName, target.region).properties,
        KINDS[resource.kind].parityFields,
      )
      : rendered.expected;
    const decisions = [
      ...KINDS[resource.kind].alwaysDecide,
      ...adapter.validateName(targetName).map((p) => `target name: ${p}`),
      ...resource.unknownFields.map((f) =>
        `source field "${f}" is unknown; run the source behavior's get/sync for ${resource.name} and re-run inventory`
      ),
      ...(resource.unresolvedRefs ?? []).map((ref) =>
        `depends on ${ref.kind} "${ref.nativeId}" (via ${ref.via}), which is not in scope: add it to the migration, or confirm it stays where it is and is reachable from the target`
      ),
      ...rendered.decisions,
      ...rangeOverlaps(expected?.cidr, sourceRanges).map((r) =>
        `target range ${expected?.cidr} overlaps the source's ${r.cidr} (${r.id}): while both clouds run, nothing can be routed between them (no VPN back to what stays behind); choose a range that does not overlap, or confirm nothing on the target needs to reach the source`
      ),
    ];
    return applyResolutions({
      ...base,
      targetBehaviorType: rendered.behaviorType,
      globalArguments: rendered.globalArguments,
      fidelity: gradeFidelity(decisions.length, rendered.losses.length),
      losses: rendered.losses,
      decisions,
      expected,
    }, rs);
  });
}

/**
 * Parity's expectations after a person's overrides: each parity field the
 * overridden arguments state (non-null once normalised) replaces what the
 * first render expected, so parity checks what was actually asked for.
 */
export function refreshExpected(
  expected: Record<string, unknown>,
  fromOverrides: Record<string, unknown>,
  parityFields: string[],
): Record<string, unknown> {
  const out = { ...expected };
  for (const field of parityFields) {
    const value = fromOverrides[field];
    if (value === null || value === undefined) continue;
    if (field === "labels" && Object.keys(value as object).length === 0) {
      continue;
    }
    out[field] = value;
  }
  return out;
}

/** An IPv4 CIDR as [first, last] address numbers, or null when not one. */
export function cidrRange(cidr: string): [number, number] | null {
  const m = cidr.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/,
  );
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const base = octets.reduce((n, o) => n * 256 + o, 0);
  const size = 2 ** (32 - bits);
  const first = Math.floor(base / size) * size;
  return [first, first + size - 1];
}

/** The source ranges `cidr` overlaps; [] when it is not a CIDR. */
export function rangeOverlaps(
  cidr: unknown,
  sources: { id: string; cidr: string }[],
): { id: string; cidr: string }[] {
  if (typeof cidr !== "string") return [];
  const target = cidrRange(cidr);
  if (!target) return [];
  return sources.filter((s) => {
    const r = cidrRange(s.cidr);
    return r !== null && r[0] <= target[1] && target[0] <= r[1];
  });
}

function gradeFidelity(openDecisions: number, losses: number): Fidelity {
  return openDecisions > 0 ? "needs-decision" : losses > 0 ? "lossy" : "exact";
}

/**
 * Objects merge key by key; anything else in `patch` replaces the base
 * value, and a null in `patch` removes the key.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (value === null) {
      delete out[key];
    } else if (
      typeof value === "object" && !Array.isArray(value) &&
      typeof current === "object" && current !== null && !Array.isArray(current)
    ) {
      out[key] = deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Settle an entry's decisions with the resolutions recorded for it, oldest
 * first: a resolution with decision text settles the decisions containing
 * that text, one without settles every decision still open. Overrides merge
 * into the global arguments in the same order. An unsupported kind can only
 * be excluded; overrides cannot give it an adapter.
 */
export function applyResolutions(
  entry: MappingEntry,
  resolutions: Resolution[],
): MappingEntry {
  if (resolutions.length === 0) return entry;
  let open = [...entry.decisions];
  const resolved: ResolvedDecision[] = [];
  const stale: string[] = [];
  let globalArguments = entry.globalArguments;
  let transferOverride = entry.transferOverride;
  const applied: AppliedResolution[] = [];
  for (const r of resolutions) {
    applied.push({
      resolution: r.resolution,
      by: r.by,
      at: r.at,
      overrideKeys: Object.keys(r.overrides).sort(),
      exclude: r.exclude,
      transfer: r.transfer?.id ?? null,
    });
    if (r.transfer) transferOverride = r.transfer;
    const settles = open.filter((d) =>
      r.decision === null || d.includes(r.decision)
    );
    if (settles.length === 0 && r.decision !== null && !r.exclude) {
      stale.push(r.decision);
    }
    for (const d of settles) {
      resolved.push({
        decision: d,
        resolution: r.resolution,
        by: r.by,
        at: r.at,
      });
    }
    open = open.filter((d) => !settles.includes(d));
    globalArguments = deepMerge(globalArguments, r.overrides);
  }
  const exclude = resolutions.some((r) => r.exclude);
  const fidelity: Fidelity = exclude
    ? "excluded"
    : entry.fidelity === "unsupported"
    ? (open.length > 0 ? "unsupported" : "excluded")
    : gradeFidelity(open.length, entry.losses.length);
  return {
    ...entry,
    globalArguments,
    decisions: open,
    resolved,
    staleResolutions: stale,
    appliedResolutions: applied,
    transferOverride,
    fidelity,
  };
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exact `swamp behavior create` command for a mapped entry, with every
 * global argument as a `--global-arg key=value` (objects and arrays as JSON).
 */
export function createCommand(entry: MappingEntry): string {
  const parts = [
    "swamp behavior create",
    shellQuote(entry.targetBehaviorType ?? ""),
    shellQuote(entry.targetBehaviorName),
  ];
  for (const [key, value] of Object.entries(entry.globalArguments)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push("--global-arg", shellQuote(`${key}=${text}`));
  }
  return parts.join(" ");
}

/**
 * Order resources into waves: every resource lands in a later wave than
 * everything it depends on, and no wave holds more than `maxPerWave`.
 * Throws on a dependency cycle, naming the resources in it.
 */
export function buildWaves(
  resources: Pick<CanonicalResource, "id" | "dependsOn">[],
  maxPerWave: number,
): string[][] {
  const ids = new Set(resources.map((r) => r.id));
  const remaining = new Map(
    resources.map((r) => [r.id, r.dependsOn.filter((d) => ids.has(d))]),
  );
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.every((d) => done.has(d)))
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      throw new Error(
        `Dependency cycle among: ${[...remaining.keys()].sort().join(", ")}`,
      );
    }
    for (let i = 0; i < ready.length; i += maxPerWave) {
      waves.push(ready.slice(i, i + maxPerWave));
    }
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return waves;
}

export interface PlanStep {
  sourceId: string;
  kind: ResourceKind;
  targetBehaviorName: string;
  targetBehaviorType: string | null;
  fidelity: Fidelity;
  transfer: TransferStrategy;
  /** Bytes to move, when the source said; feeds the egress estimate. */
  dataBytes: number | null;
  /** swamp commands that provision the target, for the person to review. */
  provision: string[];
  verify: string;
  rollback: string;
}

export interface Wave {
  index: number;
  steps: PlanStep[];
  /** Sum of known dataBytes in the wave; null when none are known. */
  dataBytes: number | null;
}

/** Turn mapping entries and waves into an ordered, reviewable plan. */
export function buildPlan(
  entries: MappingEntry[],
  resources: CanonicalResource[],
  waves: string[][],
  sourceProvider: string,
  targetProvider: string,
  migrationBehavior: string,
): Wave[] {
  const byId = new Map(entries.map((e) => [e.sourceId, e]));
  const bytes = new Map(resources.map((r) => [r.id, r.dataBytes]));
  return waves.map((ids, index) => {
    const steps = ids.map((id): PlanStep => {
      const e = byId.get(id);
      if (!e) throw new Error(`Wave references unmapped resource ${id}`);
      return {
        sourceId: id,
        kind: e.kind,
        targetBehaviorName: e.targetBehaviorName,
        targetBehaviorType: e.targetBehaviorType,
        fidelity: e.fidelity,
        transfer: e.transferOverride
          ? {
            ...e.transferOverride,
            providerNative: false,
            needsDecision: false,
          }
          : transferStrategy(e.kind, sourceProvider, targetProvider),
        dataBytes: bytes.get(id) ?? null,
        provision: e.targetBehaviorType
          ? [
            createCommand(e),
            `swamp behavior run ${e.targetBehaviorName} create`,
          ]
          : [],
        verify:
          `swamp behavior run ${e.targetBehaviorName} sync && swamp behavior run ${migrationBehavior} parity`,
        rollback:
          `Before cutover: delete ${e.targetBehaviorName} (check it with swamp behavior get first); the source is untouched. After cutover: point clients back at ${e.sourceName}, which stays until decommission.`,
      };
    });
    const known = steps.map((s) => s.dataBytes).filter((b): b is number =>
      b !== null
    );
    return {
      index: index + 1,
      steps,
      dataBytes: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null,
    };
  });
}

export type CheckStatus = "passed" | "failed" | "missing";

export interface ParityResult {
  sourceId: string;
  targetBehaviorName: string;
  status: CheckStatus;
  mismatches: { field: string; expected: unknown; actual: unknown }[];
}

/** JSON with object keys sorted and arrays sorted, so order never matters. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).sort().join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${
      Object.keys(o).sort().map((k) =>
        `${JSON.stringify(k)}:${stableJson(o[k])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare a target's canonical properties with what the mapping expected,
 * over the kind's parity fields. An expected null is skipped; an actual null
 * where something was expected is a mismatch, so parity passes on evidence,
 * never on absence. Labels must include every expected label; the target
 * may carry more (providers add their own).
 */
export function compareParity(
  entry: MappingEntry,
  actual: Record<string, unknown> | null,
): ParityResult {
  const base = {
    sourceId: entry.sourceId,
    targetBehaviorName: entry.targetBehaviorName,
  };
  if (actual === null || entry.expected === null) {
    return { ...base, status: "missing", mismatches: [] };
  }
  const mismatches: ParityResult["mismatches"] = [];
  for (const field of KINDS[entry.kind].parityFields) {
    const want = entry.expected[field];
    if (want === null || want === undefined) continue;
    if (field === "labels") {
      const have = (actual.labels ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(want as Record<string, string>)) {
        if (have[k] !== v) {
          mismatches.push({
            field: `labels.${k}`,
            expected: v,
            actual: have[k] ?? null,
          });
        }
      }
      continue;
    }
    const got = actual[field] ?? null;
    if (stableJson(want) !== stableJson(got)) {
      mismatches.push({ field, expected: want, actual: got });
    }
  }
  return {
    ...base,
    status: mismatches.length === 0 ? "passed" : "failed",
    mismatches,
  };
}

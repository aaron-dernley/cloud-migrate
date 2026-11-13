/**
 * Plan and verify a migration of infrastructure from one cloud to another.
 *
 * This behavior never calls a cloud API and never changes infrastructure.
 * The official per-cloud behaviors (`@swamp/aws/s3/bucket`,
 * `@swamp/gcp/storage/buckets`, ...) already read and write each cloud;
 * their `list`/`sync`/`get` runs record every resource as `state` data.
 * This behavior reads that data with `queryData`, so it works with any
 * provider an adapter in `_lib/providers.ts` describes, without depending
 * on every cloud extension.
 *
 * The methods run in order, each reading the last one's output:
 * {@linkcode behavior.methods.inventory} → `map` → `plan` → (a person or
 * agent provisions the target and moves the data) → `parity`. The
 * stagecraft factory shipped beside this extension (`factory/`) drives
 * them and stops for a person before anything irreversible.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type CanonicalResource,
  findKindByBehaviorType,
  getProvider,
} from "./_lib/providers.ts";
import {
  buildPlan,
  buildWaves,
  compareParity,
  type MappingEntry,
  mapResources,
  type ParityResult,
  type Resolution,
  type Resolutions,
  resolveDependencies,
  type Wave,
} from "./_lib/planning.ts";

const GlobalArgsSchema = z.object({
  source: z.object({
    provider: z.string().min(1).describe(
      "Source provider id, e.g. aws or gcp.",
    ),
    behaviors: z.array(z.string().min(1)).default([]).describe(
      "Names of the source provider behaviors whose state data is in scope. Run their list/sync first.",
    ),
    snapshot: z.string().min(1).optional().describe(
      "Path (relative to the repo) to a JSON snapshot of provider records, {records: [{behaviorName, behaviorType, name, attributes}]}, read instead of live swamp data: for assessing an exported estate offline, or a demo.",
    ),
    discover: z.boolean().default(false).describe(
      "Also take in every behavior, of any type an adapter supports for source.provider, that has state data. For a whole-estate migration.",
    ),
    include: z.array(z.string().min(1)).optional().describe(
      "Only these resource names (exact match). Omit to migrate everything the behaviors recorded.",
    ),
    region: z.string().optional().describe(
      "Source region, used when a record does not carry its own.",
    ),
  }),
  target: z.object({
    provider: z.string().min(1).describe(
      "Target provider id, e.g. gcp or aws.",
    ),
    region: z.string().min(1).describe("Target region or location."),
    project: z.string().optional().describe(
      "Target project/account scope, for providers that need one (GCP).",
    ),
    nameTemplate: z.string().default("{name}").describe(
      'Target resource name; "{name}" is the source name. Bucket names are global, so a suffix avoids clashes.',
    ),
  }),
  maxPerWave: z.number().int().min(1).default(10).describe(
    "Most resources in one wave.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One record as `queryData` returns it. */
interface DataRecord {
  name: string;
  modelName?: string;
  modelType?: string;
  specName?: string;
  attributes: Record<string, unknown>;
}

/** The context fields these methods use. */
interface MigrateContext {
  globalArgs: GlobalArgs;
  repoDir?: string;
  /** Resolves a file shipped with this extension (pulled or source-loaded). */
  extensionFile?: (path: string) => string;
  definition: { name: string };
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warn: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  queryData?: (predicate: string) => Promise<unknown[]>;
}

/** Quote a value for a CEL string literal. */
export function celString(value: string): string {
  return JSON.stringify(value);
}

async function query(
  context: MigrateContext,
  predicate: string,
): Promise<DataRecord[]> {
  if (!context.queryData) {
    throw new Error(
      "queryData is unavailable in this context; run the method through swamp",
    );
  }
  return await context.queryData(predicate) as DataRecord[];
}

async function readOwn<T>(
  context: MigrateContext,
  name: string,
  method: string,
): Promise<T> {
  const data = context.readResource ? await context.readResource(name) : null;
  if (!data) {
    throw new Error(`No ${name} recorded yet; run ${method} first`);
  }
  return data as T;
}

/** One record in a `source.snapshot` file. */
interface SnapshotRecord {
  behaviorName: string;
  behaviorType: string;
  name: string;
  attributes: Record<string, unknown>;
}

/**
 * Read a snapshot file into records shaped like `queryData`'s, so inventory
 * treats them exactly as live data. Paths are relative to the repo.
 */
export async function readSnapshot(
  path: string,
  repoDir: string | undefined,
  extensionFile?: (path: string) => string,
): Promise<DataRecord[]> {
  const candidates = path.startsWith("/") || !repoDir
    ? [path]
    : [`${repoDir}/${path}`];
  // A file shipped with the package (the demo estate) lives with the
  // extension, not in the repo, for anyone who pulled it.
  if (!path.startsWith("/") && extensionFile) {
    candidates.push(extensionFile(path));
  }
  let text: string | null = null;
  let full = candidates[0];
  for (const candidate of candidates) {
    try {
      text = await Deno.readTextFile(candidate);
      full = candidate;
      break;
    } catch {
      // try the next location
    }
  }
  if (text === null) {
    throw new Error(
      `source.snapshot ${path} was not found (looked in: ${
        candidates.join(", ")
      })`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parse error quotes the file's content, which may be anything (a
    // mistyped path to a .env file, say), so it is never repeated.
    throw new Error(`source.snapshot ${full} is not valid JSON`);
  }
  const records = (parsed as { records?: unknown })?.records;
  if (!Array.isArray(records)) {
    throw new Error(`source.snapshot ${full} has no "records" array`);
  }
  return records.map((r, i) => {
    const rec = (r ?? {}) as Partial<SnapshotRecord>;
    if (
      typeof r !== "object" || r === null || Array.isArray(r) ||
      typeof rec.behaviorName !== "string" ||
      typeof rec.behaviorType !== "string" ||
      typeof rec.attributes !== "object" || rec.attributes === null ||
      Array.isArray(rec.attributes)
    ) {
      throw new Error(
        `source.snapshot record ${i} needs behaviorName, behaviorType and attributes`,
      );
    }
    return {
      name: typeof rec.name === "string" ? rec.name : `record-${i}`,
      modelName: rec.behaviorName,
      modelType: rec.behaviorType,
      specName: "state",
      attributes: rec.attributes,
    };
  });
}

const SECRET_KEY =
  /password|passwd|passphrase|secret|token|credential|private.?key|api.?key/i;

/** Keys anywhere in `value` that look like they hold a secret. */
export function secretLikeKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => secretLikeKeys(v, `${prefix}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(SECRET_KEY.test(k) ? [`${prefix}${k}`] : []),
    ...secretLikeKeys(v, `${prefix}${k}.`),
  ]);
}

/** The resolutions recorded so far, or none. */
async function readResolutions(context: MigrateContext): Promise<Resolutions> {
  const data = context.readResource
    ? await context.readResource("resolutions")
    : null;
  return ((data as { bySource?: Resolutions } | null)?.bySource) ?? {};
}

/** A source record whose behavior type no adapter knows. */
interface UnsupportedRecord {
  behaviorName: string;
  behaviorType: string;
  name: string;
}

interface InventoryData {
  sourceProvider: string;
  resources: CanonicalResource[];
  unsupported: UnsupportedRecord[];
  capturedAt: string;
}

interface MappingData {
  targetProvider: string;
  entries: MappingEntry[];
  summary: Record<string, number>;
  capturedAt: string;
}

const InventorySchema = z.object({
  sourceProvider: z.string(),
  resources: z.array(z.record(z.string(), z.unknown())),
  unsupported: z.array(z.record(z.string(), z.unknown())),
  capturedAt: z.string(),
});

const MappingSchema = z.object({
  targetProvider: z.string(),
  entries: z.array(z.record(z.string(), z.unknown())),
  summary: z.record(z.string(), z.number()),
  capturedAt: z.string(),
});

const PlanSchema = z.object({
  sourceProvider: z.string(),
  targetProvider: z.string(),
  waves: z.array(z.record(z.string(), z.unknown())),
  blocked: z.array(z.string()),
  mappingCapturedAt: z.string(),
  capturedAt: z.string(),
});

const ResolutionsSchema = z.object({
  bySource: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  updatedAt: z.string(),
});

const ParitySchema = z.object({
  status: z.enum(["passed", "failed"]),
  results: z.array(z.record(z.string(), z.unknown())),
  notChecked: z.array(z.string()),
  capturedAt: z.string(),
});

/**
 * The `@aaronge/cloud-migrate` behavior: one instance per migration (or per
 * wave of a large one), with `inventory`, `map`, `resolve`, `plan` and
 * `parity` methods.
 */
export const behavior = {
  type: "@aaronge/cloud-migrate",
  version: "2026.11.13.1",
  globalArguments: GlobalArgsSchema,
  // Rendered after every method, so the approver always has a current plan.
  reports: ["@aaronge/cloud-migrate-plan"],
  resources: {
    inventory: {
      description:
        "Every in-scope source resource in canonical form, plus records no adapter understands.",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    mapping: {
      description:
        "Each resource mapped onto the target: target behavior type and global arguments, fidelity, losses and decisions.",
      schema: MappingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    plan: {
      description:
        "Dependency-ordered waves with provisioning, data transfer, verification and rollback per resource.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    resolutions: {
      description:
        "Decisions people have settled, by source resource: what was decided, by whom, overrides and exclusions. map applies them.",
      schema: ResolutionsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    parity: {
      description:
        "The provisioned target compared with what the mapping promised.",
      schema: ParitySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    inventory: {
      description:
        "Read the source behaviors' state data and normalise every in-scope resource. Calls no cloud API.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MigrateContext,
      ) => {
        const { source } = context.globalArgs;
        const provider = getProvider(source.provider);
        if (
          source.behaviors.length === 0 && !source.discover && !source.snapshot
        ) {
          throw new Error(
            "Nothing in scope: name source.behaviors, set source.discover to true, or give a source.snapshot",
          );
        }
        context.logger.info(
          "Inventorying {count} named source behavior(s) on {provider}{discover}",
          {
            count: source.behaviors.length,
            provider: source.provider,
            discover: source.discover ? ", discovering the rest" : "",
          },
        );

        // Records grouped by the behavior that wrote them.
        const byBehavior = new Map<string, DataRecord[]>();
        for (const behaviorName of source.behaviors) {
          const records = await query(
            context,
            `modelName == ${celString(behaviorName)} && specName == "state"`,
          );
          if (records.length === 0) {
            context.logger.warn(
              "Behavior {behaviorName} has no state data; run its list or sync first",
              { behaviorName },
            );
          }
          byBehavior.set(behaviorName, records);
        }
        if (source.discover) {
          const types = new Set(
            Object.values(provider.kinds).map((k) => k!.behaviorType),
          );
          for (const type of types) {
            const records = await query(
              context,
              `modelType == ${celString(type)} && specName == "state"`,
            );
            for (const record of records) {
              const owner = record.modelName ?? type;
              if (source.behaviors.includes(owner)) continue;
              byBehavior.set(owner, [...(byBehavior.get(owner) ?? []), record]);
            }
          }
          context.logger.info("Discovered {count} source behavior(s)", {
            count: [...byBehavior.keys()].filter((b) =>
              !source.behaviors.includes(b)
            ).length,
          });
        }

        if (source.snapshot) {
          const records = await readSnapshot(
            source.snapshot,
            context.repoDir,
            context.extensionFile,
          );
          for (const record of records) {
            const owner = record.modelName!;
            byBehavior.set(owner, [...(byBehavior.get(owner) ?? []), record]);
          }
          context.logger.info("Read {count} record(s) from snapshot {path}", {
            count: records.length,
            path: source.snapshot,
          });
        }

        const resources: CanonicalResource[] = [];
        const unsupported: UnsupportedRecord[] = [];
        for (const [behaviorName, records] of byBehavior) {
          for (const record of records) {
            const behaviorType = record.modelType ?? "";
            const match = findKindByBehaviorType(
              behaviorType,
              record.attributes,
            );
            if (!match || match.provider.id !== source.provider) {
              unsupported.push({
                behaviorName,
                behaviorType,
                name: record.name,
              });
              continue;
            }
            const resource = match.adapter.normalise(
              record.attributes,
              behaviorName,
              source.region ?? null,
            );
            if (!resource.nativeId || !resource.name) {
              context.logger.warn(
                "Skipped a {type} record from {behaviorName} with no id or name",
                { type: behaviorType, behaviorName },
              );
              unsupported.push({
                behaviorName,
                behaviorType,
                name: record.name,
              });
              continue;
            }
            if (source.include && !source.include.includes(resource.name)) {
              continue;
            }
            // The same resource can be recorded by two behaviors (one ran
            // list, another get): keep the fuller record.
            const seen = resources.findIndex((r) => r.id === resource.id);
            if (seen !== -1) {
              if (
                resource.unknownFields.length <
                  resources[seen].unknownFields.length
              ) {
                resources[seen] = resource;
              }
              context.logger.info(
                "{id} was recorded more than once; keeping the fuller record",
                { id: resource.id },
              );
              continue;
            }
            resources.push(resource);
          }
        }
        if (source.include) {
          const found = new Set(resources.map((r) => r.name));
          const missing = source.include.filter((n) => !found.has(n));
          if (missing.length > 0) {
            throw new Error(
              `source.include names resources the source behaviors have not recorded: ${
                missing.join(", ")
              }`,
            );
          }
        }

        context.logger.info(
          "Inventoried {resources} resource(s); {unsupported} record(s) have no adapter",
          { resources: resources.length, unsupported: unsupported.length },
        );
        const data: InventoryData = {
          sourceProvider: source.provider,
          resources: resolveDependencies(resources),
          unsupported,
          capturedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "inventory",
          "inventory",
          data as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    map: {
      description:
        "Map every inventoried resource onto the target provider, grading each exact, lossy, needs-decision or unsupported.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MigrateContext,
      ) => {
        const { target } = context.globalArgs;
        const inventory = await readOwn<InventoryData>(
          context,
          "inventory",
          "inventory",
        );
        context.logger.info("Mapping {count} resource(s) onto {provider}", {
          count: inventory.resources.length,
          provider: target.provider,
        });

        const resolutions = await readResolutions(context);
        const entries = mapResources(
          inventory.resources,
          target,
          context.definition.name,
          target.nameTemplate,
          resolutions,
        );
        const summary: Record<string, number> = {
          exact: 0,
          lossy: 0,
          "needs-decision": 0,
          unsupported: 0,
          excluded: 0,
        };
        for (const e of entries) summary[e.fidelity]++;
        // Names only need to be unique within a kind (a bucket and a VM may share one).
        const names = entries.filter((e) => e.fidelity !== "excluded")
          .map((e) => `${e.kind} ${e.targetName}`);
        const clashes = names.filter((n, i) => names.indexOf(n) !== i);
        if (clashes.length > 0) {
          throw new Error(
            `Target names clash: ${
              [...new Set(clashes)].join(", ")
            }; change target.nameTemplate or exclude one with resolve`,
          );
        }
        // Behavior names are sanitised, so two different target names (e.g.
        // "logs.example" and "logs-example") can still meet here; parity
        // would then read one resource's state for both.
        const behaviors = entries.filter((e) => e.fidelity !== "excluded")
          .map((e) => e.targetBehaviorName);
        const behaviorClashes = behaviors.filter((n, i) =>
          behaviors.indexOf(n) !== i
        );
        if (behaviorClashes.length > 0) {
          throw new Error(
            `Target behavior names clash after sanitising: ${
              [...new Set(behaviorClashes)].join(", ")
            }; change target.nameTemplate or exclude one with resolve`,
          );
        }

        context.logger.info(
          "Mapped: {exact} exact, {lossy} lossy, {decision} need a decision, {unsupported} unsupported",
          {
            exact: summary.exact,
            lossy: summary.lossy,
            decision: summary["needs-decision"],
            unsupported: summary.unsupported,
          },
        );
        const data: MappingData = {
          targetProvider: target.provider,
          entries,
          summary,
          capturedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "mapping",
          "mapping",
          data as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    plan: {
      description:
        "Order mapped resources into dependency waves with provisioning, data transfer, verification and rollback steps. Changes nothing.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MigrateContext,
      ) => {
        const { source, target, maxPerWave } = context.globalArgs;
        const inventory = await readOwn<InventoryData>(
          context,
          "inventory",
          "inventory",
        );
        const mapping = await readOwn<MappingData>(context, "mapping", "map");
        context.logger.info("Planning {count} mapped resource(s)", {
          count: mapping.entries.length,
        });

        const plannable = new Set(
          mapping.entries.filter((e) =>
            e.fidelity !== "unsupported" && e.fidelity !== "excluded"
          )
            .map((e) => e.sourceId),
        );
        const waves: Wave[] = buildPlan(
          mapping.entries,
          inventory.resources,
          buildWaves(
            inventory.resources.filter((r) => plannable.has(r.id)),
            maxPerWave,
          ),
          source.provider,
          target.provider,
          context.definition.name,
        );
        const blocked = mapping.entries
          .filter((e) =>
            e.fidelity === "needs-decision" || e.fidelity === "unsupported"
          )
          .map((e) => e.sourceId);

        context.logger.info(
          "Planned {waves} wave(s); {blocked} resource(s) wait on a decision",
          { waves: waves.length, blocked: blocked.length },
        );
        const handle = await context.writeResource("plan", "plan", {
          sourceProvider: source.provider,
          targetProvider: target.provider,
          waves,
          blocked,
          // Lets readers spot a plan older than the mapping it came from.
          mappingCapturedAt: mapping.capturedAt,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    resolve: {
      description:
        "Record a person's decision on a mapped resource: settle one decision (or all), set target global arguments, or exclude the resource. Run map again to apply it.",
      arguments: z.object({
        sourceId: z.string().min(1).describe(
          "The resource's source id from the mapping, e.g. aws:vm:i-0abc.",
        ),
        resolution: z.string().min(1).describe(
          "What was decided, in the person's words.",
        ),
        by: z.string().min(1).describe(
          "Who decided. Record only a person's decision, never an agent's own.",
        ),
        decision: z.string().min(1).optional().describe(
          "Text identifying the decision this settles (a substring of it). Omit to settle every open decision on the resource.",
        ),
        overrides: z.record(z.string(), z.unknown()).default({}).describe(
          'Merged into the target\'s global arguments, e.g. {"ImageId": "ami-..."}. A null value removes a key.',
        ),
        exclude: z.boolean().default(false).describe(
          "Leave this resource out of the migration.",
        ),
        transfer: z.string().min(1).optional().describe(
          "Replace the planned data transfer method with this one, in the person's words (e.g. rebuild from configuration management instead of replicating disks).",
        ),
        clear: z.boolean().default(false).describe(
          "Forget every resolution recorded for this resource instead.",
        ),
      }),
      execute: async (
        args: {
          sourceId: string;
          resolution: string;
          by: string;
          decision?: string;
          overrides?: Record<string, unknown>;
          exclude?: boolean;
          transfer?: string;
          clear?: boolean;
        },
        context: MigrateContext,
      ) => {
        const inventory = await readOwn<InventoryData>(
          context,
          "inventory",
          "inventory",
        );
        if (!inventory.resources.some((r) => r.id === args.sourceId)) {
          throw new Error(
            `${args.sourceId} is not in the inventory; use a sourceId from the mapping`,
          );
        }
        const secretKeys = secretLikeKeys(args.overrides ?? {});
        if (secretKeys.length > 0) {
          throw new Error(
            `overrides may not carry secrets (${
              secretKeys.join(", ")
            }): resolutions, the mapping and the plan are stored in plain data. Set them on the target behavior's own definition as a vault expression after creating it.`,
          );
        }
        const bySource = await readResolutions(context);
        if (args.clear) {
          delete bySource[args.sourceId];
          context.logger.info("Cleared resolutions for {sourceId}", {
            sourceId: args.sourceId,
          });
        } else {
          const entry: Resolution = {
            decision: args.decision ?? null,
            resolution: args.resolution,
            overrides: args.overrides ?? {},
            exclude: args.exclude ?? false,
            transfer: args.transfer
              ? { id: "person-chosen", description: args.transfer }
              : null,
            by: args.by,
            at: new Date().toISOString(),
          };
          bySource[args.sourceId] = [...(bySource[args.sourceId] ?? []), entry];
          context.logger.info(
            "Recorded {by}'s resolution for {sourceId}; run map to apply it",
            { by: args.by, sourceId: args.sourceId },
          );
        }
        const handle = await context.writeResource(
          "resolutions",
          "resolutions",
          {
            bySource,
            updatedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    parity: {
      description:
        "Compare each provisioned target resource (from its behavior's state data) with what the mapping promised.",
      arguments: z.object({
        wave: z.number().int().min(1).optional().describe(
          "Only check this wave's resources. Omit to check every planned resource.",
        ),
      }),
      execute: async (args: { wave?: number }, context: MigrateContext) => {
        const { target } = context.globalArgs;
        const mapping = await readOwn<MappingData>(context, "mapping", "map");
        const plan = await readOwn<{ waves: Wave[] }>(context, "plan", "plan");
        const waves = args.wave === undefined
          ? plan.waves
          : plan.waves.filter((w) => w.index === args.wave);
        if (waves.length === 0) {
          throw new Error(
            args.wave === undefined
              ? "The plan has no waves, so there is nothing to check"
              : `The plan has no wave ${args.wave}`,
          );
        }
        const inScope = new Set(
          waves.flatMap((w) => w.steps.map((s) => s.sourceId)),
        );
        const entries = mapping.entries.filter((e) => inScope.has(e.sourceId));
        context.logger.info("Checking parity of {count} target resource(s)", {
          count: entries.length,
        });

        const adapter = getProvider(target.provider);
        const results: ParityResult[] = [];
        for (const entry of entries) {
          const kindAdapter =
            adapter.kinds[entry.kind as CanonicalResource["kind"]];
          const records = kindAdapter
            ? await query(
              context,
              `modelName == ${
                celString(entry.targetBehaviorName)
              } && specName == "state"`,
            )
            : [];
          // A behavior can hold several state records (after a list): use
          // the one for this target, never just the first.
          const normalised = kindAdapter
            ? records.map((r) =>
              kindAdapter.normalise(
                r.attributes,
                entry.targetBehaviorName,
                target.region,
              )
            )
            : [];
          const own = normalised.find((n) => n.name === entry.targetName) ??
            (normalised.length === 1 ? normalised[0] : undefined);
          const actual = own ? own.properties : null;
          results.push(compareParity(entry, actual));
        }
        const status = results.every((r) => r.status === "passed")
          ? "passed"
          : "failed";
        if (status === "failed") {
          context.logger.warn("Parity failed for {count} resource(s)", {
            count: results.filter((r) => r.status !== "passed").length,
          });
        }
        context.logger.info("Parity {status} for {count} resource(s)", {
          status,
          count: results.length,
        });
        const handle = await context.writeResource("parity", "parity", {
          status,
          results,
          // Object counts and checksums come from the transfer tool's own
          // report, which the work item records as evidence.
          notChecked: [
            "object counts and checksums (record the transfer report)",
          ],
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

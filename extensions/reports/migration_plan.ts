/**
 * A Markdown migration plan for a person to approve, built from the latest
 * `inventory`, `mapping`, `plan`, `parity` and `resolutions` data of an
 * `@aaronge/cloud-migrate` behavior.
 *
 * Scope is `model`: the report reads the latest version of each resource by
 * name instead of one method's output handles, so it shows the whole picture
 * whichever method just ran (an `inventory` run still renders what is known,
 * and a `parity` run sees the plan and mapping). It calls no cloud API. The
 * mapping's global arguments appear only inside each step's provisioning
 * command, and all free text passes through {@linkcode scrub}; `resolve`
 * refuses secret-looking overrides, so none should be there to mask.
 *
 * @module
 */

type Json = Record<string, unknown>;

/** The slice of the report context this report uses. */
export interface PlanReportContext {
  modelType: unknown;
  modelId: string;
  definition: { name: string };
  globalArgs?: Json;
  logger?: {
    info: (message: string, props?: Json) => void;
    warn?: (message: string, props?: Json) => void;
  };
  dataRepository: {
    getContent(
      type: never,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

/** Fidelities the mapping uses today, in display order; others are kept too. */
const FIDELITY_ORDER = [
  "exact",
  "lossy",
  "needs-decision",
  "unsupported",
  "excluded",
];

interface Entry {
  sourceId: string;
  kind: string;
  sourceName: string;
  targetName: string;
  targetBehaviorName: string;
  targetBehaviorType: string | null;
  fidelity: string;
  losses: string[];
  decisions: string[];
  dependsOn: string[];
  globalArgumentCount: number;
}

interface Resolution {
  decision: string;
  resolution: string;
  overrideKeys: string[];
  exclude: boolean;
  by: string;
  at: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bdop_v1_[a-f0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // Matches compound keys too (MasterUserPassword=..., DB_PASSWORD: ...).
  /\b([A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z_]*)(\s*[=:]\s*)[^\s,}]+/gi,
  // The same inside JSON: "rootPassword":"..." or "SecretString": "..."
  /("[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z_]*"\s*:\s*)"[^"]*"/gi,
];

/** Mask anything in free text that looks like a credential. */
export function scrub(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (_m, ...g) => {
      const key = typeof g[0] === "string" && /^[a-z_-]+$/i.test(g[0]) &&
          typeof g[1] === "string" && /[=:]/.test(g[1])
        ? `${g[0]}${g[1]}`
        : "";
      return `${key}[redacted]`;
    });
  }
  return out;
}

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function strOr(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x) => x !== null && x !== undefined).map((x) => String(x))
    : [];
}
/** Make text safe inside a Markdown table cell. */
function cell(v: unknown): string {
  const s = v === null || v === undefined || v === "" ? "-" : String(v);
  return scrub(s).replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
}
function line(v: unknown): string {
  return scrub(String(v)).replaceAll(/\s*\n\s*/g, " ");
}

/** A byte count as a human string, or "unknown". */
export function formatBytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

function toEntry(raw: unknown): Entry | null {
  if (!isObj(raw) || typeof raw.sourceId !== "string") return null;
  return {
    sourceId: raw.sourceId,
    kind: strOr(raw.kind, "unknown"),
    sourceName: strOr(raw.sourceName, raw.sourceId),
    targetName: strOr(raw.targetName),
    targetBehaviorName: strOr(raw.targetBehaviorName),
    targetBehaviorType: typeof raw.targetBehaviorType === "string"
      ? raw.targetBehaviorType
      : null,
    fidelity: strOr(raw.fidelity, "unknown"),
    losses: strList(raw.losses),
    decisions: strList(raw.decisions),
    dependsOn: strList(raw.dependsOn),
    globalArgumentCount: isObj(raw.globalArguments)
      ? Object.keys(raw.globalArguments).length
      : 0,
  };
}

/**
 * Reads the behavior's `resolutions` data, `{ bySource: { <sourceId>: [..] } }`
 * (a bare `{ <sourceId>: [..] }` map is accepted too). Override values are
 * dropped; only their keys are kept.
 */
export function parseResolutions(raw: unknown): Map<string, Resolution[]> {
  const out = new Map<string, Resolution[]>();
  if (!isObj(raw)) return out;
  const map = isObj(raw.bySource) ? raw.bySource : raw;
  for (const [sourceId, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue;
    const items: Resolution[] = [];
    for (const r of list) {
      if (!isObj(r)) continue;
      items.push({
        decision: strOr(r.decision),
        resolution: strOr(r.resolution),
        overrideKeys: isObj(r.overrides) ? Object.keys(r.overrides).sort() : [],
        exclude: r.exclude === true,
        by: strOr(r.by, "unknown"),
        at: strOr(r.at),
      });
    }
    if (items.length > 0) out.set(sourceId, items);
  }
  return out;
}

function count<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

function orderedFidelities(counts: Record<string, number>): string[] {
  const extra = Object.keys(counts).filter((k) => !FIDELITY_ORDER.includes(k))
    .sort();
  return [...FIDELITY_ORDER, ...extra];
}

async function readData(
  context: PlanReportContext,
  name: string,
  problems: string[],
): Promise<Json | null> {
  let raw: Uint8Array | null;
  try {
    raw = await context.dataRepository.getContent(
      context.modelType as never,
      context.modelId,
      name,
    );
  } catch (err) {
    problems.push(`${name}: could not be read (${errorText(err)})`);
    return null;
  }
  // No content means the method has not run yet, which is normal.
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (isObj(parsed)) return parsed;
    problems.push(`${name}: stored data is not an object`);
  } catch {
    problems.push(`${name}: stored data is not valid JSON`);
  }
  return null;
}

function errorText(err: unknown): string {
  return scrub(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** Render the migration plan from already-loaded data. Exported for tests. */
export function render(input: {
  behaviorName: string;
  targetRegion: string | null;
  inventory: Json | null;
  mapping: Json | null;
  plan: Json | null;
  parity: Json | null;
  resolutions: Json | null;
  /** Data that exists but could not be read; the plan is not approvable. */
  readProblems?: string[];
}): { markdown: string; json: Json } {
  const { inventory, mapping, plan, parity } = input;
  const readProblems = input.readProblems ?? [];
  const entries = (Array.isArray(mapping?.entries) ? mapping!.entries : [])
    .map(toEntry).filter((e): e is Entry => e !== null);
  const byId = new Map(entries.map((e) => [e.sourceId, e]));
  const resolutions = parseResolutions(input.resolutions);
  const resources = Array.isArray(inventory?.resources)
    ? inventory!.resources as unknown[]
    : [];
  const unsupportedRecords = Array.isArray(inventory?.unsupported)
    ? inventory!.unsupported as unknown[]
    : [];
  const unresolved: { id: string; refs: string[] }[] = [];
  for (const r of resources) {
    if (!isObj(r) || !Array.isArray(r.unresolvedRefs)) continue;
    if (r.unresolvedRefs.length === 0) continue;
    unresolved.push({
      id: strOr(r.id, "?"),
      refs: r.unresolvedRefs.map((u) =>
        isObj(u)
          ? `${strOr(u.kind, "?")} ${strOr(u.nativeId, "?")} (via ${
            strOr(u.via, "?")
          })`
          : String(u)
      ),
    });
  }

  const sourceProvider = strOr(plan?.sourceProvider) ||
    strOr(inventory?.sourceProvider) || "?";
  const targetProvider = strOr(plan?.targetProvider) ||
    strOr(mapping?.targetProvider) || "?";
  const fidelityCounts = count(entries, (e) => e.fidelity);
  const kindCounts = count(entries, (e) => e.kind);

  // map moves settled decisions to `resolved`, so what is left is open; the
  // exact-text filter only matters for data written before resolutions existed.
  const open: { entry: Entry; decisions: string[] }[] = [];
  const resolved: {
    entry: Entry | null;
    sourceId: string;
    items: Resolution[];
  }[] = [];
  for (const e of entries) {
    const rs = resolutions.get(e.sourceId) ?? [];
    const answered = new Set(rs.map((r) => r.decision));
    const pending = e.fidelity === "excluded"
      ? []
      : e.decisions.filter((d) => !answered.has(d));
    if (pending.length > 0) open.push({ entry: e, decisions: pending });
  }
  for (const [sourceId, items] of resolutions) {
    resolved.push({ entry: byId.get(sourceId) ?? null, sourceId, items });
  }

  const unsupportedEntries = entries.filter((e) =>
    e.fidelity === "unsupported"
  );
  const md: string[] = [];
  md.push(`# Migration plan: ${line(input.behaviorName)}`, "");
  md.push(
    `**${line(sourceProvider)} -> ${line(targetProvider)}**` +
      (input.targetRegion
        ? ` (target region ${line(input.targetRegion)})`
        : ""),
    "",
  );
  if (!mapping) {
    md.push(
      "_No mapping recorded yet. Run `inventory`, `map` and `plan` first._",
      "",
    );
  } else {
    const blocking = open.length;
    md.push(
      blocking > 0
        ? `**Not ready for approval: ${blocking} resource(s) have open decisions.**`
        : "**No open decisions.**",
      "",
    );
  }
  md.push("| Fidelity | Resources |", "| --- | ---: |");
  for (const f of orderedFidelities(fidelityCounts)) {
    if (f in fidelityCounts || FIDELITY_ORDER.includes(f)) {
      md.push(`| ${cell(f)} | ${fidelityCounts[f] ?? 0} |`);
    }
  }
  md.push("", "| Kind | Resources |", "| --- | ---: |");
  for (const k of Object.keys(kindCounts).sort()) {
    md.push(`| ${cell(k)} | ${kindCounts[k]} |`);
  }
  md.push("");

  // A plan made before the latest map lacks any later resolutions, so its
  // provisioning commands are out of date.
  const stale = !!plan && !!mapping &&
    typeof plan.mappingCapturedAt === "string" &&
    plan.mappingCapturedAt !== mapping.capturedAt;
  if (stale) {
    md.push(
      "> **The plan is out of date:** it was made from an earlier mapping. Run `plan` again before approving.",
      "",
    );
  }

  if (readProblems.length > 0) {
    md.push(
      "> **Some data could not be read, so this plan is incomplete:**",
      ...readProblems.map((p) => `> - ${line(p)}`),
      "",
    );
  }

  md.push("## Open decisions", "");
  if (open.length === 0) {
    md.push("None.", "");
  } else {
    for (const { entry, decisions } of open) {
      md.push(
        `### ${line(entry.kind)} ${line(entry.sourceName)} (\`${
          line(entry.sourceId)
        }\`)`,
        "",
      );
      for (const d of decisions) md.push(`- ${line(d)}`);
      md.push("");
    }
  }

  md.push("## Resolved decisions", "");
  if (resolved.length === 0) {
    md.push("None recorded.", "");
  } else {
    for (const { entry, sourceId, items } of resolved) {
      md.push(
        `### ${
          entry ? `${line(entry.kind)} ${line(entry.sourceName)} ` : ""
        }(\`${line(sourceId)}\`)`,
        "",
      );
      for (const r of items) {
        const extras = [
          r.exclude ? "excluded from migration" : "",
          r.overrideKeys.length > 0
            ? `overrides: ${r.overrideKeys.map(line).join(", ")}`
            : "",
        ].filter(Boolean).join("; ");
        md.push(
          `- ${line(r.decision)} -> ${line(r.resolution || "(no text)")}${
            extras ? ` [${extras}]` : ""
          } - resolved by ${line(r.by)}${r.at ? ` at ${line(r.at)}` : ""}`,
        );
      }
      md.push("");
    }
  }

  md.push("## Waves", "");
  const waves = Array.isArray(plan?.waves) ? plan!.waves as unknown[] : [];
  if (waves.length === 0) {
    md.push("_No plan recorded yet._", "");
  }
  for (const w of waves) {
    if (!isObj(w)) continue;
    const steps = Array.isArray(w.steps) ? w.steps.filter(isObj) : [];
    md.push(
      `### Wave ${
        line(w.index ?? "?")
      } (${steps.length} resource(s), known data ${formatBytes(w.dataBytes)})`,
      "",
      "| Kind | Source -> Target | Target behavior type | Fidelity | Transfer | Data |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const s of steps) {
      const id = strOr(s.sourceId);
      const e = byId.get(id);
      const transfer = isObj(s.transfer)
        ? `${strOr(s.transfer.id, "?")}${
          s.transfer.needsDecision === true ? " (needs decision)" : ""
        }${s.transfer.providerNative === false ? " via your host" : ""}`
        : strOr(s.transfer);
      md.push(
        `| ${cell(s.kind)} | ${cell(e?.sourceName ?? id)} -> ${
          cell(e?.targetName || s.targetBehaviorName)
        } | ${cell(s.targetBehaviorType)} | ${cell(s.fidelity)} | ${
          cell(transfer)
        } | ${formatBytes(s.dataBytes)} |`,
      );
    }
    md.push("");
    for (const s of steps) {
      md.push(
        `**${line(strOr(s.targetBehaviorName, strOr(s.sourceId)))}**`,
        "",
      );
      const prov = strList(s.provision);
      if (prov.length === 0) md.push("- Provision: none (nothing to create)");
      for (const p of prov) md.push(`- Provision: \`${line(p)}\``);
      if (s.verify) md.push(`- Verify: \`${line(s.verify)}\``);
      if (s.rollback) md.push(`- Rollback: ${line(s.rollback)}`);
      md.push("");
    }
  }
  const blockedIds = strList(plan?.blocked);
  if (blockedIds.length > 0) {
    md.push(
      `Blocked in the plan (waiting on a decision or unsupported): ${
        blockedIds.map((b) => `\`${line(b)}\``).join(", ")
      }`,
      "",
    );
  }

  md.push("## What will not carry over", "");
  const lossy = entries.filter((e) => e.losses.length > 0);
  if (lossy.length === 0) {
    md.push("Nothing recorded.", "");
  } else {
    for (const e of lossy) {
      md.push(
        `### ${line(e.kind)} ${line(e.sourceName)} (\`${line(e.sourceId)}\`)`,
        "",
      );
      for (const l of e.losses) md.push(`- ${line(l)}`);
      md.push("");
    }
  }

  md.push("## Unsupported and unresolved", "");
  if (
    unsupportedEntries.length === 0 && unsupportedRecords.length === 0 &&
    unresolved.length === 0
  ) {
    md.push("None.", "");
  }
  if (unsupportedEntries.length > 0) {
    md.push("Resources with no equivalent on the target:", "");
    for (const e of unsupportedEntries) {
      md.push(
        `- ${line(e.kind)} ${line(e.sourceName)} (\`${line(e.sourceId)}\`)${
          e.decisions.length > 0 ? `: ${e.decisions.map(line).join("; ")}` : ""
        }`,
      );
    }
    md.push("");
  }
  if (unsupportedRecords.length > 0) {
    md.push("Source records no adapter understands (not migrated):", "");
    for (const u of unsupportedRecords) {
      if (!isObj(u)) continue;
      md.push(
        `- ${line(strOr(u.name, "?"))} (${
          line(strOr(u.behaviorType, "?"))
        }, behavior ${line(strOr(u.behaviorName, "?"))})`,
      );
    }
    md.push("");
  }
  if (unresolved.length > 0) {
    md.push("Dependencies that matched nothing in scope:", "");
    for (const u of unresolved) {
      md.push(`- \`${line(u.id)}\` needs ${u.refs.map(line).join(", ")}`);
    }
    md.push("");
  }

  md.push("## Parity", "");
  const results = Array.isArray(parity?.results)
    ? parity!.results.filter(isObj)
    : [];
  if (!parity) {
    md.push("Not checked yet.", "");
  } else {
    md.push(`Overall: **${line(strOr(parity.status, "unknown"))}**`, "");
    const rank = (s: string) => s === "failed" ? 0 : s === "missing" ? 1 : 2;
    const sorted = [...results].sort((a, b) =>
      rank(strOr(a.status)) - rank(strOr(b.status))
    );
    for (const r of sorted) {
      md.push(
        `- ${line(strOr(r.status, "unknown"))}: \`${
          line(strOr(r.sourceId))
        }\` -> ${line(strOr(r.targetBehaviorName))}`,
      );
      const mm = Array.isArray(r.mismatches) ? r.mismatches.filter(isObj) : [];
      for (const m of mm) {
        md.push(
          `  - ${line(strOr(m.field, "?"))}: expected ${
            line(JSON.stringify(m.expected))
          }, actual ${line(JSON.stringify(m.actual))}`,
        );
      }
    }
    const nc = strList(parity.notChecked);
    if (nc.length > 0) {
      md.push("", "Not checked:", ...nc.map((n) => `- ${line(n)}`));
    }
    md.push("");
  }

  const json: Json = {
    behavior: input.behaviorName,
    sourceProvider,
    targetProvider,
    targetRegion: input.targetRegion,
    readyForApproval: !!mapping && open.length === 0 && !stale &&
      readProblems.length === 0,
    readProblems,
    planStale: stale,
    counts: { fidelity: fidelityCounts, kind: kindCounts },
    openDecisions: open.map(({ entry, decisions }) => ({
      sourceId: entry.sourceId,
      kind: entry.kind,
      name: entry.sourceName,
      decisions: decisions.map(scrub),
    })),
    resolvedDecisions: resolved.flatMap(({ sourceId, items }) =>
      items.map((r) => ({
        sourceId,
        decision: scrub(r.decision),
        resolution: scrub(r.resolution),
        overrideKeys: r.overrideKeys,
        exclude: r.exclude,
        by: r.by,
        at: r.at,
      }))
    ),
    waves: waves.filter(isObj).map((w) => ({
      index: w.index,
      dataBytes: typeof w.dataBytes === "number" ? w.dataBytes : null,
      resources: (Array.isArray(w.steps) ? w.steps.filter(isObj) : []).map((
        s,
      ) => ({
        sourceId: s.sourceId,
        kind: s.kind,
        fidelity: s.fidelity,
        targetBehaviorType: s.targetBehaviorType ?? null,
        targetBehaviorName: s.targetBehaviorName,
      })),
    })),
    losses: lossy.map((e) => ({
      sourceId: e.sourceId,
      losses: e.losses.map(scrub),
    })),
    unsupported: unsupportedEntries.map((e) => e.sourceId),
    unsupportedRecords: unsupportedRecords.length,
    unresolvedDependencies: unresolved,
    parity: parity
      ? {
        status: strOr(parity.status, "unknown"),
        failed: results.filter((r) => r.status === "failed").map((r) =>
          r.sourceId
        ),
        missing: results.filter((r) => r.status === "missing").map((r) =>
          r.sourceId
        ),
      }
      : null,
  };
  return { markdown: md.join("\n") + "\n", json };
}

/** The `@aaronge/cloud-migrate-plan` report. */
export const report = {
  name: "@aaronge/cloud-migrate-plan",
  description:
    "Markdown migration plan for approval: open and resolved decisions, waves, losses, unsupported resources and parity.",
  scope: "model" as const,
  labels: ["migration", "plan", "approval"],
  execute: async (
    context: PlanReportContext,
  ): Promise<{ markdown: string; json: Json }> => {
    const readProblems: string[] = [];
    const [inventory, mapping, plan, parity, resolutions] = await Promise.all([
      readData(context, "inventory", readProblems),
      readData(context, "mapping", readProblems),
      readData(context, "plan", readProblems),
      readData(context, "parity", readProblems),
      readData(context, "resolutions", readProblems),
    ]);
    if (readProblems.length > 0) {
      context.logger?.warn?.("Some data could not be read: {problems}", {
        problems: readProblems.join("; "),
      });
    }
    context.logger?.info("Rendering migration plan for {name}", {
      name: context.definition.name,
    });
    // Only the target region is read from the global arguments; nothing else.
    const target = context.globalArgs && isObj(context.globalArgs.target)
      ? context.globalArgs.target
      : null;
    return render({
      behaviorName: context.definition.name,
      targetRegion: target && typeof target.region === "string"
        ? target.region
        : null,
      inventory,
      mapping,
      plan,
      parity,
      resolutions,
      readProblems,
    });
  },
};

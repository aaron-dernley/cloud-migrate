// Run with `deno test -A`. Fixtures are shaped like the cloud-migrate
// behavior's inventory/mapping/plan/parity data; ids and names are made up.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "jsr:@swamp-club/swamp-testing@0.20261030.68";
import {
  formatBytes,
  parseResolutions,
  render,
  report,
  scrub,
} from "./migration_plan.ts";

const TYPE = "@aaronge/cloud-migrate";
const ID = "mig-1";

const inventory = {
  sourceProvider: "aws",
  capturedAt: "2026-11-12T00:00:00Z",
  unsupported: [{
    behaviorName: "odd",
    behaviorType: "@x/odd",
    name: "odd-thing",
  }],
  resources: [
    {
      id: "aws:object-bucket:example-assets",
      unresolvedRefs: [{ kind: "kms-key", nativeId: "key-9", via: "KmsKeyId" }],
    },
  ],
};

const mapping = {
  targetProvider: "gcp",
  capturedAt: "2026-11-12T00:00:00Z",
  summary: {},
  entries: [
    {
      sourceId: "aws:object-bucket:example-assets",
      kind: "object-bucket",
      sourceName: "example-assets",
      targetName: "example-assets-gcp",
      targetBehaviorName: "gcp-example-assets",
      targetBehaviorType: "@swamp/gcp/storage/buckets",
      globalArguments: { password: "hunter2-SECRET", name: "x" },
      fidelity: "lossy",
      losses: ["Tags become labels; keys are lowercased"],
      decisions: [],
      expected: {},
      dependsOn: [],
    },
    {
      sourceId: "aws:sql-database:orders",
      kind: "sql-database",
      sourceName: "orders",
      targetName: "orders",
      targetBehaviorName: "gcp-orders",
      targetBehaviorType: "@swamp/gcp/sql/instances",
      globalArguments: {},
      fidelity: "needs-decision",
      losses: [],
      decisions: ["Pick a machine tier", "Choose HA or single zone"],
      expected: {},
      dependsOn: [],
    },
    {
      sourceId: "aws:queue:jobs",
      kind: "queue",
      sourceName: "jobs",
      targetName: "jobs",
      targetBehaviorName: "gcp-jobs",
      targetBehaviorType: null,
      globalArguments: {},
      fidelity: "unsupported",
      losses: [],
      decisions: ["No equivalent queue behavior"],
      expected: null,
      dependsOn: [],
    },
    {
      sourceId: "aws:cache:sessions",
      kind: "cache",
      sourceName: "sessions",
      targetName: "sessions",
      targetBehaviorName: "gcp-sessions",
      targetBehaviorType: null,
      globalArguments: {},
      fidelity: "excluded",
      losses: [],
      decisions: [],
      expected: null,
      dependsOn: [],
    },
    {
      sourceId: "aws:dns-zone:example",
      kind: "dns-zone",
      sourceName: "example",
      targetName: "example",
      targetBehaviorName: "gcp-example",
      targetBehaviorType: "@swamp/gcp/dns/zones",
      globalArguments: {},
      fidelity: "brand-new-fidelity",
      losses: [],
      decisions: [],
      expected: {},
      dependsOn: [],
    },
  ],
};

const plan = {
  sourceProvider: "aws",
  targetProvider: "gcp",
  blocked: ["aws:sql-database:orders", "aws:queue:jobs"],
  capturedAt: "x",
  waves: [{
    index: 1,
    dataBytes: 5368709120,
    steps: [{
      sourceId: "aws:object-bucket:example-assets",
      kind: "object-bucket",
      targetBehaviorName: "gcp-example-assets",
      targetBehaviorType: "@swamp/gcp/storage/buckets",
      fidelity: "lossy",
      transfer: {
        id: "gcp-storage-transfer-service",
        description: "x",
        providerNative: true,
        needsDecision: false,
      },
      dataBytes: 5368709120,
      provision: ["swamp behavior run gcp-example-assets create"],
      verify: "swamp behavior run gcp-example-assets sync",
      rollback: "Delete gcp-example-assets before cutover.",
    }],
  }],
};

const parity = {
  status: "failed",
  notChecked: ["object counts"],
  capturedAt: "x",
  results: [
    {
      sourceId: "ok:1",
      targetBehaviorName: "t1",
      status: "passed",
      mismatches: [],
    },
    {
      sourceId: "aws:object-bucket:example-assets",
      targetBehaviorName: "gcp-example-assets",
      status: "failed",
      mismatches: [{ field: "versioning", expected: true, actual: false }],
    },
  ],
};

const resolutions = {
  "aws:sql-database:orders": [{
    decision: "Pick a machine tier",
    resolution: "db-custom-2-7680",
    overrides: { tier: "db-custom-2-7680", password: "hunter2-SECRET" },
    exclude: false,
    by: "alice",
    at: "2026-11-12T10:00:00Z",
  }],
};

function seed(name: string, value: unknown) {
  const content = new TextEncoder().encode(JSON.stringify(value));
  return {
    modelType: TYPE,
    modelId: ID,
    data: {
      name,
      kind: "resource" as const,
      dataId: `d-${name}`,
      version: 1,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

async function run(data: Record<string, unknown>) {
  const { context } = createReportTestContext({
    scope: "model",
    modelType: TYPE,
    modelId: ID,
    definition: { id: ID, name: "aws-to-gcp", version: 1, tags: {} },
    globalArgs: {
      target: { provider: "gcp", region: "europe-west2" },
      token: "tok-SECRET",
    },
    methodName: "plan",
    executionStatus: "succeeded",
    dataHandles: [],
    dataArtifacts: Object.entries(data).map(([k, v]) => seed(k, v)),
  });
  // deno-lint-ignore no-explicit-any
  return await report.execute(context as any);
}

Deno.test("renders open decisions before everything else, with waves and losses", async () => {
  const r = await run({ inventory, mapping, plan, parity, resolutions });
  const md = r.markdown;
  assertStringIncludes(md, "aws -> gcp");
  assertStringIncludes(md, "europe-west2");
  const order = [
    "## Open decisions",
    "## Resolved decisions",
    "## Waves",
    "## What will not carry over",
    "## Unsupported and unresolved",
    "## Parity",
  ]
    .map((h) => md.indexOf(h));
  assert(order.every((i) => i >= 0), "all sections present");
  assertEquals([...order].sort((a, b) => a - b), order);
  // Open: unanswered decision only; the resolved one is not open.
  const open = md.slice(order[0], order[1]);
  assertStringIncludes(open, "Choose HA or single zone");
  assert(!open.includes("Pick a machine tier"));
  assertStringIncludes(open, "No equivalent queue behavior");
  // Resolved shows who.
  assertStringIncludes(md.slice(order[1], order[2]), "resolved by alice");
  // Wave table.
  assertStringIncludes(
    md,
    "| object-bucket | example-assets -> example-assets-gcp | @swamp/gcp/storage/buckets | lossy | gcp-storage-transfer-service | 5.0 GiB |",
  );
  assertStringIncludes(md, "Rollback: Delete gcp-example-assets");
  // Losses, unsupported, unresolved.
  assertStringIncludes(md, "Tags become labels");
  assertStringIncludes(md, "odd-thing");
  assertStringIncludes(md, "kms-key key-9 (via KmsKeyId)");
  // Counts incl. excluded and unknown fidelity.
  assertStringIncludes(md, "| excluded | 1 |");
  assertStringIncludes(md, "| brand-new-fidelity | 1 |");
  assertEquals(r.json.readyForApproval, false);
});

Deno.test("parity lists failed fields first", async () => {
  const md = (await run({ mapping, plan, parity })).markdown;
  const failed = md.indexOf("failed: `aws:object-bucket");
  const passed = md.indexOf("passed: `ok:1`");
  assert(failed > 0 && passed > failed);
  assertStringIncludes(md, "versioning: expected true, actual false");
});

Deno.test("never renders secret values", async () => {
  const r = await run({ inventory, mapping, plan, parity, resolutions });
  const all = r.markdown + JSON.stringify(r.json);
  assert(!all.includes("hunter2"));
  assert(!all.includes("tok-SECRET"));
  // Override keys are shown, values are not.
  assertStringIncludes(r.markdown, "overrides: password, tier");
});

Deno.test("scrub masks credential-looking text", () => {
  assertEquals(scrub("use password=abc123 now"), "use password=[redacted] now");
  // Built at runtime so secret scanners don't flag a fake key in the source.
  const fakeKeyId = "AKIA" + "ABCDEFGHIJKLMNOP";
  assert(!scrub(`key ${fakeKeyId}`).includes("AKIA"));
});

Deno.test("missing parity and resolutions render gracefully", async () => {
  const r = await run({ inventory, mapping, plan });
  assertStringIncludes(r.markdown, "Not checked yet.");
  assertStringIncludes(r.markdown, "None recorded.");
  assertStringIncludes(r.markdown, "Pick a machine tier"); // now open
  assertEquals(r.json.parity, null);
});

Deno.test("no data at all does not throw", async () => {
  const r = await run({});
  assertStringIncludes(r.markdown, "No mapping recorded yet");
  assertStringIncludes(r.markdown, "No plan recorded yet");
});

Deno.test("all decisions resolved makes the plan ready", async () => {
  const m = structuredClone(mapping);
  m.entries = m.entries.filter((e) => e.fidelity !== "unsupported");
  const r = await run({ mapping: m, resolutions });
  assertStringIncludes(r.markdown, "Choose HA or single zone");
  const res = {
    "aws:sql-database:orders": [
      ...resolutions["aws:sql-database:orders"],
      {
        decision: "Choose HA or single zone",
        resolution: "single",
        by: "bob",
        at: "t",
      },
    ],
  };
  const ready = await run({
    mapping: m,
    resolutions: { bySource: res, updatedAt: "" },
  });
  assertStringIncludes(ready.markdown, "**No open decisions.**");
  assertEquals(ready.json.readyForApproval, true);
});

Deno.test("helpers", () => {
  assertEquals(formatBytes(null), "unknown");
  assertEquals(formatBytes(512), "512 B");
  assertEquals(parseResolutions("nope").size, 0);
});

Deno.test("scrub masks compound and JSON secret keys", () => {
  assert(!scrub("--global-arg MasterUserPassword=hunter2").includes("hunter2"));
  assert(!scrub(`{"rootPassword":"s3cret"}`).includes("s3cret"));
  assertEquals(scrub("KmsKeyId=arn:aws:kms:x"), "KmsKeyId=arn:aws:kms:x");
});

Deno.test("data that exists but can't be read is reported, not shown as missing", () => {
  const r = render({
    behaviorName: "m",
    targetRegion: null,
    inventory: null,
    mapping: { entries: [], summary: {}, capturedAt: "t" },
    plan: null,
    parity: null,
    resolutions: null,
    readProblems: ["plan: stored data is not valid JSON"],
  });
  assertStringIncludes(r.markdown, "could not be read");
  assertStringIncludes(r.markdown, "plan: stored data is not valid JSON");
  assertEquals(r.json.readyForApproval, false);
});

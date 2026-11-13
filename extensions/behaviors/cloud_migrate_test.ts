// Method outputs are untyped JSON; tests index into them freely.
// deno-lint-ignore-file no-explicit-any
// Run with `deno test -A`. No cloud is touched: queryData is stubbed with
// records shaped like what @swamp/aws/s3/bucket and
// @swamp/gcp/storage/buckets write from their list/sync methods. Names
// and ids are made up.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261030.68";
import {
  behavior,
  celString,
  readSnapshot,
  secretLikeKeys,
} from "./cloud_migrate.ts";
import {
  applyResolutions,
  buildWaves,
  cidrRange,
  compareParity,
  createCommand,
  deepMerge,
  mapResources,
  rangeOverlaps,
  targetNameFor,
} from "./_lib/planning.ts";
import { getProvider, PROVIDERS, transferStrategy } from "./_lib/providers.ts";
import { KINDS } from "./_lib/kinds.ts";

const S3_BUCKET = {
  BucketName: "example-assets",
  Arn: "arn:aws:s3:::example-assets",
  RegionalDomainName: "example-assets.s3.eu-west-2.amazonaws.com",
  VersioningConfiguration: { Status: "Enabled" },
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [{
      ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
    }],
  },
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
  Tags: [{ Key: "Team", Value: "Web" }],
};

const GCS_BUCKET = {
  name: "example-assets-gcp",
  location: "EUROPE-WEST2",
  storageClass: "STANDARD",
  versioning: { enabled: true },
  iamConfiguration: { publicAccessPrevention: "enforced" },
  labels: { l_team: "web" },
};

const BASE_ARGS = {
  source: { provider: "aws", behaviors: ["aws-buckets"] },
  target: {
    provider: "gcp",
    region: "europe-west2",
    project: "example-project",
    nameTemplate: "{name}-gcp",
  },
  maxPerWave: 10,
};

type Records = Record<
  string,
  { modelType: string; name: string; attributes: unknown }[]
>;

/** A test context whose queryData answers `modelName == "<x>"` from `records`. */
function contextWith(
  records: Records,
  stored: Record<string, Record<string, unknown>> = {},
  globalArgs: object = BASE_ARGS,
) {
  const helpers = createModelTestContext({
    globalArgs,
    definition: { name: "assets-move" },
    storedResources: stored,
  });
  const ctx = helpers.context as unknown as Record<string, unknown>;
  ctx.queryData = (predicate: string) => {
    const name = predicate.match(/modelName == "([^"]+)"/)?.[1] ?? "";
    return Promise.resolve(records[name] ?? []);
  };
  return { ...helpers, context: ctx as any };
}

function written(helpers: ReturnType<typeof contextWith>, spec: string) {
  const w = helpers.getWrittenResources().find((r) => r.specName === spec);
  assert(w, `nothing written to ${spec}`);
  return w.data as any;
}

Deno.test("celString escapes quotes so names cannot break the predicate", () => {
  assertEquals(celString('a"b'), '"a\\"b"');
});

Deno.test("aws adapter normalises an S3 bucket", () => {
  const r = getProvider("aws").kinds["object-bucket"]!.normalise(
    S3_BUCKET,
    "aws-buckets",
    null,
  );
  assertEquals(r.id, "aws:object-bucket:example-assets");
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.properties.versioning, true);
  assertEquals(r.properties.encryption, "provider-managed");
  assertEquals(r.properties.publicAccess, "blocked");
  assertEquals(r.properties.tier, null);
  assertEquals(r.properties.labels, { Team: "Web" });
  assertEquals(r.unknownFields, []);
});

Deno.test("aws adapter marks fields the list call did not return as unknown", () => {
  const r = getProvider("aws").kinds["object-bucket"]!.normalise(
    { BucketName: "bare-bucket" },
    "aws-buckets",
    "us-east-1",
  );
  assertEquals(r.region, "us-east-1");
  assertEquals(r.unknownFields.sort(), [
    "encryption",
    "publicAccess",
    "versioning",
  ]);
});

Deno.test("gcp adapter normalises a GCS bucket", () => {
  const r = getProvider("gcp").kinds["object-bucket"]!.normalise(
    GCS_BUCKET,
    "gcs",
    null,
  );
  assertEquals(r.region, "europe-west2");
  assertEquals(r.properties.tier, "hot");
  assertEquals(r.properties.publicAccess, "blocked");
  assertEquals(r.unknownFields, []);
});

Deno.test("unknown provider names the supported ones", () => {
  assertThrows(() => getProvider("azure"), Error, "Supported: aws, gcp");
});

Deno.test("S3 → GCS mapping renames labels and records the loss", () => {
  const resource = getProvider("aws").kinds["object-bucket"]!.normalise(
    S3_BUCKET,
    "b",
    null,
  );
  const [entry] = mapResources(
    [resource],
    BASE_ARGS.target,
    "assets-move",
    "{name}-gcp",
  );
  assertEquals(entry.targetName, "example-assets-gcp");
  assertEquals(
    entry.targetBehaviorName,
    "assets-move-object-bucket-example-assets-gcp",
  );
  assertEquals(entry.targetBehaviorType, "@swamp/gcp/storage/buckets");
  assertEquals(entry.fidelity, "lossy");
  assertEquals(entry.globalArguments.labels, { team: "web" });
  assertEquals(entry.globalArguments.location, "EUROPE-WEST2");
  assert(entry.losses.some((l) => l.includes('"Team=Web"')));
});

Deno.test("customer keys, locks and bad names need a decision", () => {
  const resource = getProvider("aws").kinds["object-bucket"]!.normalise(
    {
      ...S3_BUCKET,
      BucketName: "my.dotted.bucket",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: "aws:kms",
            KMSMasterKeyID: "k",
          },
        }],
      },
      ObjectLockEnabled: true,
    },
    "b",
    null,
  );
  const [entry] = mapResources([resource], BASE_ARGS.target, "m", "{name}");
  assertEquals(entry.fidelity, "needs-decision");
  assert(entry.decisions.some((d) => d.includes("customer-managed key")));
  assert(entry.decisions.some((d) => d.includes("irreversible")));
  assert(entry.decisions.some((d) => d.includes("domain verification")));
});

Deno.test("GCS → S3 maps back with a public access block and tags", () => {
  const resource = getProvider("gcp").kinds["object-bucket"]!.normalise(
    GCS_BUCKET,
    "g",
    null,
  );
  const [entry] = mapResources(
    [resource],
    { provider: "aws", region: "eu-west-2" },
    "m",
    "{name}",
  );
  assertEquals(entry.fidelity, "exact");
  assertEquals(entry.globalArguments.Tags, [{ Key: "l_team", Value: "web" }]);
  assertEquals(
    (entry.globalArguments.PublicAccessBlockConfiguration as Record<
      string,
      boolean
    >)
      .BlockPublicAcls,
    true,
  );
});

Deno.test("buildWaves orders dependencies and caps wave size", () => {
  const waves = buildWaves([
    { id: "c", dependsOn: ["a", "b"] },
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: [] },
    { id: "d", dependsOn: [] },
  ], 2);
  assertEquals(waves, [["a", "b"], ["d"], ["c"]]);
});

Deno.test("buildWaves names a dependency cycle", () => {
  assertThrows(
    () =>
      buildWaves(
        [{ id: "x", dependsOn: ["y"] }, { id: "y", dependsOn: ["x"] }],
        5,
      ),
    Error,
    "Dependency cycle among: x, y",
  );
});

Deno.test("transferStrategy prefers provider-native paths", () => {
  assertEquals(
    transferStrategy("object-bucket", "aws", "gcp").id,
    "gcp-storage-transfer-service",
  );
  assertEquals(
    transferStrategy("object-bucket", "gcp", "aws").id,
    "aws-datasync",
  );
  const fallback = transferStrategy("object-bucket", "aws", "hetzner");
  assertEquals(fallback.needsDecision, true);
});

Deno.test("targetNameFor lowercases", () => {
  assertEquals(targetNameFor("{name}-NEW", "Logs"), "logs-new");
});

Deno.test("a behaviorType shared by several kinds is told apart by accepts", () => {
  const byType = new Map<string, number>();
  for (const p of Object.values(PROVIDERS)) {
    for (const k of Object.values(p.kinds)) {
      byType.set(k!.behaviorType, (byType.get(k!.behaviorType) ?? 0) + 1);
    }
  }
  for (const p of Object.values(PROVIDERS)) {
    for (const k of Object.values(p.kinds)) {
      if (byType.get(k!.behaviorType)! > 1) {
        assert(
          k!.accepts,
          `${k!.behaviorType} models several kinds but has no accepts`,
        );
      }
    }
  }
});

Deno.test("inventory → map → plan end to end on stubbed data", async () => {
  const records: Records = {
    "aws-buckets": [
      {
        modelType: "@swamp/aws/s3/bucket",
        name: "example-assets",
        attributes: S3_BUCKET,
      },
      { modelType: "@swamp/aws/s3/bucket-policy", name: "p", attributes: {} },
    ],
  };
  const inv = contextWith(records);
  await behavior.methods.inventory.execute({}, inv.context);
  const inventory = written(inv, "inventory");
  assertEquals(inventory.resources.length, 1);
  assertEquals(inventory.unsupported, [{
    behaviorName: "aws-buckets",
    behaviorType: "@swamp/aws/s3/bucket-policy",
    name: "p",
  }]);

  const mapCtx = contextWith(records, { inventory });
  await behavior.methods.map.execute({}, mapCtx.context);
  const mapping = written(mapCtx, "mapping");
  assertEquals(mapping.summary.lossy, 1);

  const planCtx = contextWith(records, { inventory, mapping });
  await behavior.methods.plan.execute({}, planCtx.context);
  const plan = written(planCtx, "plan");
  assertEquals(plan.waves.length, 1);
  assertEquals(
    plan.waves[0].steps[0].transfer.id,
    "gcp-storage-transfer-service",
  );
  assertEquals(plan.blocked, []);
});

Deno.test("inventory fails when include names a resource nobody recorded", async () => {
  const { context } = contextWith(
    { "aws-buckets": [] },
    {},
    { ...BASE_ARGS, source: { ...BASE_ARGS.source, include: ["ghost"] } },
  );
  await assertRejects(
    () => behavior.methods.inventory.execute({}, context),
    Error,
    "ghost",
  );
});

Deno.test("map refuses to run before inventory", async () => {
  const { context } = contextWith({});
  await assertRejects(
    () => behavior.methods.map.execute({}, context),
    Error,
    "run inventory",
  );
});

Deno.test("parity passes on a matching target and fails on drift", async () => {
  const resource = getProvider("aws").kinds["object-bucket"]!.normalise(
    S3_BUCKET,
    "b",
    null,
  );
  const [entry] = mapResources(
    [resource],
    BASE_ARGS.target,
    "assets-move",
    "{name}-gcp",
  );
  const mapping = {
    targetProvider: "gcp",
    entries: [entry],
    summary: {},
    capturedAt: "",
  };
  const plan = { waves: [{ index: 1, steps: [{ sourceId: entry.sourceId }] }] };
  const target = {
    name: "example-assets-gcp",
    location: "EUROPE-WEST2",
    storageClass: "STANDARD",
    versioning: { enabled: true },
    iamConfiguration: { publicAccessPrevention: "enforced" },
    labels: { team: "web" },
  };

  const ok = contextWith(
    {
      "assets-move-object-bucket-example-assets-gcp": [{
        modelType: "@swamp/gcp/storage/buckets",
        name: "example-assets-gcp",
        attributes: target,
      }],
    },
    { mapping, plan },
  );
  await behavior.methods.parity.execute({}, ok.context);
  assertEquals(written(ok, "parity").status, "passed");

  const drift = contextWith(
    {
      "assets-move-object-bucket-example-assets-gcp": [{
        modelType: "@swamp/gcp/storage/buckets",
        name: "example-assets-gcp",
        attributes: { ...target, versioning: { enabled: false } },
      }],
    },
    { mapping, plan },
  );
  await behavior.methods.parity.execute({}, drift.context);
  const parity = written(drift, "parity");
  assertEquals(parity.status, "failed");
  assertEquals(parity.results[0].mismatches[0].field, "versioning");
});

Deno.test("parity reports a target that was never provisioned as missing", () => {
  const resource = getProvider("aws").kinds["object-bucket"]!.normalise(
    S3_BUCKET,
    "b",
    null,
  );
  const [entry] = mapResources([resource], BASE_ARGS.target, "m", "{name}-gcp");
  assertEquals(compareParity(entry, null).status, "missing");
});

Deno.test("AWS network stack → GCP: dependencies resolve, waves order, refs wire by CEL", async () => {
  const records: Records = {
    "aws-net": [
      {
        modelType: "@swamp/aws/ec2/vpc",
        name: "vpc-0aaa",
        attributes: {
          VpcId: "vpc-0aaa",
          CidrBlock: "10.0.0.0/16",
          Tags: [{ Key: "Name", Value: "main" }],
        },
      },
      {
        modelType: "@swamp/aws/ec2/subnet",
        name: "subnet-0bbb",
        attributes: {
          SubnetId: "subnet-0bbb",
          VpcId: "vpc-0aaa",
          CidrBlock: "10.0.1.0/24",
          AvailabilityZone: "eu-west-2a",
          MapPublicIpOnLaunch: false,
          Tags: [{ Key: "Name", Value: "app" }],
        },
      },
      {
        modelType: "@swamp/aws/ec2/security-group",
        name: "sg-0ccc",
        attributes: {
          GroupId: "sg-0ccc",
          GroupName: "web",
          GroupDescription: "web tier",
          VpcId: "vpc-0aaa",
          SecurityGroupIngress: [{
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIp: "0.0.0.0/0",
          }],
          SecurityGroupEgress: [{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }],
        },
      },
      {
        modelType: "@swamp/aws/ec2/instance",
        name: "i-0eee",
        attributes: {
          InstanceId: "i-0eee",
          InstanceType: "t3.medium",
          ImageId: "ami-0fff",
          SubnetId: "subnet-0bbb",
          SecurityGroupIds: ["sg-0ccc"],
          AvailabilityZone: "eu-west-2a",
          PrivateIpAddress: "10.0.1.5",
          Tags: [{ Key: "Name", Value: "app-1" }],
        },
      },
    ],
  };
  const args = {
    ...BASE_ARGS,
    source: { provider: "aws", behaviors: ["aws-net"] },
  };

  const inv = contextWith(records, {}, args);
  await behavior.methods.inventory.execute({}, inv.context);
  const inventory = written(inv, "inventory");
  assertEquals(inventory.resources.length, 4);
  const byKind = Object.fromEntries(
    inventory.resources.map((r: any) => [r.kind, r]),
  );
  assertEquals(byKind.subnet.dependsOn, ["aws:network:vpc-0aaa"]);
  assertEquals(byKind.firewall.dependsOn, ["aws:network:vpc-0aaa"]);
  assertEquals(byKind.vm.dependsOn, [
    "aws:firewall:sg-0ccc",
    "aws:subnet:subnet-0bbb",
  ]);

  const mapCtx = contextWith(records, { inventory }, args);
  await behavior.methods.map.execute({}, mapCtx.context);
  const mapping = written(mapCtx, "mapping");
  const vm = mapping.entries.find((e: any) => e.kind === "vm");
  assertEquals(vm.targetBehaviorType, "@swamp/gcp/compute/instances");
  // Images never cross clouds, so a VM always waits on a person.
  assertEquals(vm.fidelity, "needs-decision");
  const wiring = JSON.stringify(vm.globalArguments);
  assert(
    wiring.includes(
      'data.findBySpec(\\"assets-move-subnet-app-gcp\\", \\"state\\")',
    ),
    `vm should reference its migrated subnet by CEL: ${wiring}`,
  );

  const planCtx = contextWith(records, { inventory, mapping }, args);
  await behavior.methods.plan.execute({}, planCtx.context);
  const plan = written(planCtx, "plan");
  const waveOf = (kind: string) =>
    plan.waves.findIndex((w: any) => w.steps.some((s: any) => s.kind === kind));
  assert(waveOf("network") < waveOf("subnet"));
  assert(waveOf("network") < waveOf("firewall"));
  assert(waveOf("subnet") < waveOf("vm"));
  assert(waveOf("firewall") < waveOf("vm"));
  const vmStep = plan.waves.flatMap((w: any) => w.steps).find((s: any) =>
    s.kind === "vm"
  );
  assertEquals(vmStep.transfer.id, "gcp-migrate-to-virtual-machines");
});

Deno.test("every registered kind adapter names a real canonical kind", () => {
  for (const p of Object.values(PROVIDERS)) {
    for (const [kind, adapter] of Object.entries(p.kinds)) {
      assert(kind in KINDS, `${p.id} registers unknown kind ${kind}`);
      assert(
        adapter!.behaviorType.startsWith("@swamp/"),
        `${p.id}/${kind}: ${adapter!.behaviorType}`,
      );
    }
  }
});

const NET_RECORDS: Records = {
  "aws-net": [
    {
      modelType: "@swamp/aws/ec2/vpc",
      name: "vpc-0aaa",
      attributes: {
        VpcId: "vpc-0aaa",
        CidrBlock: "10.0.0.0/16",
        Tags: [{ Key: "Name", Value: "main" }],
      },
    },
    {
      modelType: "@swamp/aws/ec2/subnet",
      name: "subnet-0bbb",
      attributes: {
        SubnetId: "subnet-0bbb",
        VpcId: "vpc-0aaa",
        CidrBlock: "10.0.1.0/24",
        AvailabilityZone: "eu-west-2a",
        MapPublicIpOnLaunch: false,
        Tags: [{ Key: "Name", Value: "app" }],
      },
    },
    {
      modelType: "@swamp/aws/ec2/instance",
      name: "i-0eee",
      attributes: {
        InstanceId: "i-0eee",
        InstanceType: "t3.medium",
        ImageId: "ami-0fff",
        SubnetId: "subnet-0bbb",
        AvailabilityZone: "eu-west-2a",
        PrivateIpAddress: "10.0.1.5",
        Tags: [{ Key: "Name", Value: "app-1" }],
      },
    },
  ],
};
const NET_ARGS = {
  ...BASE_ARGS,
  source: { provider: "aws", behaviors: ["aws-net"] },
};

/** Run inventory then map with the given stored resolutions; returns the mapping. */
async function mapWith(stored: Record<string, Record<string, unknown>> = {}) {
  const inv = contextWith(NET_RECORDS, {}, NET_ARGS);
  await behavior.methods.inventory.execute({}, inv.context);
  const inventory = written(inv, "inventory");
  const m = contextWith(NET_RECORDS, { inventory, ...stored }, NET_ARGS);
  await behavior.methods.map.execute({}, m.context);
  return { inventory, mapping: written(m, "mapping") };
}

Deno.test("resolve settles a VM's decisions, applies overrides and unblocks the plan", async () => {
  const { inventory, mapping } = await mapWith();
  const vm = mapping.entries.find((e: any) => e.kind === "vm");
  assertEquals(vm.fidelity, "needs-decision");

  const r = contextWith(NET_RECORDS, { inventory }, NET_ARGS);
  await behavior.methods.resolve.execute({
    sourceId: vm.sourceId,
    resolution: "Use Debian 12 from the public image family",
    by: "the migration owner",
    overrides: {
      disks: [{
        boot: true,
        initializeParams: {
          sourceImage: "projects/debian-cloud/global/images/family/debian-12",
        },
      }],
    },
  }, r.context);
  const resolutions = written(r, "resolutions");
  assertEquals(resolutions.bySource[vm.sourceId].length, 1);

  const { mapping: after } = await mapWith({ resolutions });
  const vm2 = after.entries.find((e: any) => e.kind === "vm");
  assertEquals(vm2.decisions, []);
  assert(vm2.resolved.length >= 1);
  assertEquals(vm2.resolved[0].by, "the migration owner");
  assert(vm2.fidelity === "lossy" || vm2.fidelity === "exact");
  assertEquals(
    vm2.globalArguments.disks[0].initializeParams.sourceImage,
    "projects/debian-cloud/global/images/family/debian-12",
  );

  const p = contextWith(NET_RECORDS, { inventory, mapping: after }, NET_ARGS);
  await behavior.methods.plan.execute({}, p.context);
  const plan = written(p, "plan");
  assert(!plan.blocked.includes(vm.sourceId));
  const step = plan.waves.flatMap((w: any) => w.steps).find((s: any) =>
    s.kind === "vm"
  );
  assert(
    step.provision[0].startsWith(
      "swamp behavior create @swamp/gcp/compute/instances ",
    ),
  );
  assert(step.provision[0].includes("--global-arg"));
});

Deno.test("excluding a network drops it from the plan and its dependents stop waiting on it", async () => {
  const { inventory } = await mapWith();
  const r = contextWith(NET_RECORDS, { inventory }, NET_ARGS);
  await behavior.methods.resolve.execute({
    sourceId: "aws:network:vpc-0aaa",
    resolution: "The target project already has its network",
    by: "the migration owner",
    exclude: true,
  }, r.context);
  const resolutions = written(r, "resolutions");
  const { mapping } = await mapWith({ resolutions });
  const byKind = Object.fromEntries(
    mapping.entries.map((e: any) => [e.kind, e]),
  );
  assertEquals(byKind.network.fidelity, "excluded");
  assertEquals(mapping.summary.excluded, 1);
  assertEquals(byKind.subnet.dependsOn, []);
  // The subnet no longer gets a CEL ref to a network that will not exist.
  assert(
    !JSON.stringify(byKind.subnet.globalArguments).includes("network-main"),
  );

  const p = contextWith(NET_RECORDS, { inventory, mapping }, NET_ARGS);
  await behavior.methods.plan.execute({}, p.context);
  const kinds = written(p, "plan").waves.flatMap((w: any) =>
    w.steps.map((s: any) => s.kind)
  );
  assert(!kinds.includes("network"));
});

Deno.test("resolve refuses an unknown source id and can clear what it recorded", async () => {
  const { inventory } = await mapWith();
  const bad = contextWith(NET_RECORDS, { inventory }, NET_ARGS);
  await assertRejects(
    () =>
      behavior.methods.resolve.execute(
        { sourceId: "aws:vm:nope", resolution: "x", by: "someone" },
        bad.context,
      ),
    Error,
    "not in the inventory",
  );
  const stored = {
    bySource: {
      "aws:vm:i-0eee": [{
        decision: null,
        resolution: "x",
        overrides: {},
        exclude: false,
        by: "a",
        at: "",
      }],
    },
    updatedAt: "",
  };
  const c = contextWith(
    NET_RECORDS,
    { inventory, resolutions: stored },
    NET_ARGS,
  );
  await behavior.methods.resolve.execute(
    { sourceId: "aws:vm:i-0eee", resolution: "undo", by: "a", clear: true },
    c.context,
  );
  assertEquals(written(c, "resolutions").bySource, {});
});

Deno.test("a resolution whose decision text matches nothing is reported stale", () => {
  const entry = {
    sourceId: "s",
    kind: "vm" as const,
    sourceName: "n",
    targetName: "n",
    targetBehaviorName: "b",
    targetBehaviorType: "t",
    globalArguments: { a: 1 },
    fidelity: "needs-decision" as const,
    losses: [],
    decisions: ["choose an image"],
    expected: null,
    dependsOn: [],
    resolved: [],
    staleResolutions: [],
    appliedResolutions: [],
    transferOverride: null,
  };
  const out = applyResolutions(entry, [
    {
      decision: "zone",
      resolution: "x",
      overrides: {},
      exclude: false,
      by: "p",
      at: "",
    },
  ]);
  assertEquals(out.staleResolutions, ["zone"]);
  assertEquals(out.fidelity, "needs-decision");
});

Deno.test("deepMerge merges objects, replaces arrays and deletes on null", () => {
  assertEquals(
    deepMerge({ a: { b: 1, c: 2 }, d: [1], e: "x" }, {
      a: { c: 3 },
      d: [2],
      e: null,
    }),
    { a: { b: 1, c: 3 }, d: [2] },
  );
});

Deno.test("createCommand quotes JSON and CEL safely for the shell", () => {
  const cmd = createCommand({
    sourceId: "s",
    kind: "subnet",
    sourceName: "n",
    targetName: "n",
    targetBehaviorName: "m-subnet-n",
    targetBehaviorType: "@swamp/aws/ec2/subnet",
    globalArguments: {
      region: "eu-west-2",
      VpcId:
        '${{ data.findBySpec("m-network-x", "state")[0].attributes.VpcId }}',
      Tags: [{ Key: "it's", Value: "v" }],
    },
    fidelity: "exact",
    losses: [],
    decisions: [],
    expected: null,
    dependsOn: [],
    resolved: [],
    staleResolutions: [],
    appliedResolutions: [],
    transferOverride: null,
  });
  assert(
    cmd.startsWith(
      "swamp behavior create @swamp/aws/ec2/subnet m-subnet-n --global-arg region=eu-west-2 ",
    ),
  );
  assert(
    cmd.includes(
      `'VpcId=\${{ data.findBySpec("m-network-x", "state")[0].attributes.VpcId }}'`,
    ),
  );
  assert(cmd.includes(`'Tags=[{"Key":"it'\\''s","Value":"v"}]'`));
});

Deno.test("discover takes in every supported behavior on the source provider", async () => {
  const records: Records = {
    "aws-net": NET_RECORDS["aws-net"],
    "aws-buckets": [{
      modelType: "@swamp/aws/s3/bucket",
      name: "example-assets",
      attributes: S3_BUCKET,
    }],
  };
  const helpers = contextWith(records, {}, {
    ...BASE_ARGS,
    source: { provider: "aws", behaviors: [], discover: true },
  });
  // Answer type queries too: group every record by modelType.
  helpers.context.queryData = (predicate: string) => {
    const type = predicate.match(/modelType == "([^"]+)"/)?.[1];
    const name = predicate.match(/modelName == "([^"]+)"/)?.[1];
    const all = Object.entries(records).flatMap(([modelName, rs]) =>
      rs.map((r) => ({ ...r, modelName }))
    );
    return Promise.resolve(
      all.filter((r) => (type ? r.modelType === type : r.modelName === name)),
    );
  };
  await behavior.methods.inventory.execute({}, helpers.context);
  const inventory = written(helpers, "inventory");
  assertEquals(inventory.resources.map((r: any) => r.kind).sort(), [
    "network",
    "object-bucket",
    "subnet",
    "vm",
  ]);
});

Deno.test("inventory with nothing in scope says how to fix it", async () => {
  const { context } = contextWith({}, {}, {
    ...BASE_ARGS,
    source: { provider: "aws", behaviors: [] },
  });
  await assertRejects(
    () => behavior.methods.inventory.execute({}, context),
    Error,
    "source.discover",
  );
});

Deno.test("the demo snapshot plans end to end onto GCP", async () => {
  const args = {
    ...BASE_ARGS,
    source: {
      provider: "aws",
      behaviors: [],
      snapshot: "examples/demo-aws-estate.json",
    },
    target: {
      provider: "gcp",
      region: "europe-west2",
      project: "example-project",
      nameTemplate: "{name}",
    },
  };
  const repoDir = new URL("../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const inv = contextWith({}, {}, args);
  inv.context.repoDir = repoDir;
  await behavior.methods.inventory.execute({}, inv.context);
  const inventory = written(inv, "inventory");
  assertEquals(inventory.resources.length, 17);
  assertEquals(inventory.unsupported.length, 1);

  const m = contextWith({}, { inventory }, args);
  await behavior.methods.map.execute({}, m.context);
  const mapping = written(m, "mapping");
  assertEquals(
    Object.values(mapping.summary).reduce(
      (a: number, b) => a + (b as number),
      0,
    ),
    17,
  );

  const p = contextWith({}, { inventory, mapping }, args);
  await behavior.methods.plan.execute({}, p.context);
  const plan = written(p, "plan");
  assert(plan.waves.length >= 3, "network, then subnets/firewalls, then VMs");
  assert(
    plan.blocked.length > 0,
    "VMs, KMS, secret and IAM always wait on a person",
  );
});

Deno.test("a snapshot without records is refused clearly", async () => {
  await assertRejects(
    () => readSnapshot("/nonexistent/snap.json", undefined),
    Error,
    "was not found",
  );
});

// The cases below replay what the mig-1 demo found (2026-11-13).

Deno.test("cidrRange and rangeOverlaps", () => {
  assertEquals(cidrRange("10.20.1.0/24"), [169083136, 169083391]);
  assertEquals(cidrRange("not-a-cidr"), null);
  assertEquals(
    rangeOverlaps("10.20.1.0/24", [{ id: "v", cidr: "10.20.0.0/16" }]).length,
    1,
  );
  assertEquals(
    rangeOverlaps("10.30.1.0/24", [{ id: "v", cidr: "10.20.0.0/16" }]),
    [],
  );
  assertEquals(rangeOverlaps(null, [{ id: "v", cidr: "10.20.0.0/16" }]), []);
});

Deno.test("a subnet reusing the source range needs a decision; overriding the range clears it and updates parity", async () => {
  const { inventory, mapping } = await mapWith();
  const subnet = mapping.entries.find((e: any) => e.kind === "subnet");
  assertEquals(subnet.fidelity, "needs-decision");
  assert(
    subnet.decisions.some((d: string) =>
      d.includes("overlaps the source's 10.0.0.0/16")
    ),
  );

  const r = contextWith(NET_RECORDS, { inventory }, NET_ARGS);
  await behavior.methods.resolve.execute({
    sourceId: subnet.sourceId,
    resolution: "Use 10.30.1.0/24 so a VPN can route back to AWS",
    by: "the migration owner",
    overrides: { ipCidrRange: "10.30.1.0/24" },
  }, r.context);
  const { mapping: after } = await mapWith({
    resolutions: written(r, "resolutions"),
  });
  const s2 = after.entries.find((e: any) => e.kind === "subnet");
  assertEquals(s2.globalArguments.ipCidrRange, "10.30.1.0/24");
  assertEquals(
    s2.expected.cidr,
    "10.30.1.0/24",
    "parity must expect what was asked for",
  );
  assert(!s2.decisions.some((d: string) => d.includes("overlaps")));
  assertEquals(s2.appliedResolutions[0].overrideKeys, ["ipCidrRange"]);
});

Deno.test("a person's transfer choice replaces the planned method", async () => {
  const { inventory, mapping } = await mapWith();
  const vm = mapping.entries.find((e: any) => e.kind === "vm");
  const r = contextWith(NET_RECORDS, { inventory }, NET_ARGS);
  await behavior.methods.resolve.execute({
    sourceId: vm.sourceId,
    resolution: "Rebuild on Ubuntu 22.04",
    by: "the migration owner",
    transfer: "Rebuild from configuration management; no disk replication",
  }, r.context);
  const { mapping: after } = await mapWith({
    resolutions: written(r, "resolutions"),
  });
  const vm2 = after.entries.find((e: any) => e.kind === "vm");
  assertEquals(vm2.transferOverride.id, "person-chosen");
  assertEquals(vm2.appliedResolutions[0].transfer, "person-chosen");
  const p = contextWith(NET_RECORDS, { inventory, mapping: after }, NET_ARGS);
  await behavior.methods.plan.execute({}, p.context);
  const step = written(p, "plan").waves.flatMap((w: any) => w.steps).find((
    s: any,
  ) => s.kind === "vm");
  assertEquals(
    step.transfer.description,
    "Rebuild from configuration management; no disk replication",
  );
});

// Cases from the pre-publish adversarial review (2026-11-13).

Deno.test("two target names that sanitise to one behavior name are refused", async () => {
  const records: Records = {
    "aws-buckets": [
      {
        modelType: "@swamp/aws/s3/bucket",
        name: "a",
        attributes: { ...S3_BUCKET, BucketName: "logs.example" },
      },
      {
        modelType: "@swamp/aws/s3/bucket",
        name: "b",
        attributes: { ...S3_BUCKET, BucketName: "logs-example" },
      },
    ],
  };
  const args = {
    ...BASE_ARGS,
    source: { provider: "aws", behaviors: ["aws-buckets"] },
  };
  const inv = contextWith(records, {}, args);
  await behavior.methods.inventory.execute({}, inv.context);
  const m = contextWith(
    records,
    { inventory: written(inv, "inventory") },
    args,
  );
  await assertRejects(
    () => behavior.methods.map.execute({}, m.context),
    Error,
    "behavior names clash",
  );
});

Deno.test("the same resource recorded by two behaviors is kept once", async () => {
  const records: Records = {
    "aws-list": [{
      modelType: "@swamp/aws/s3/bucket",
      name: "x",
      attributes: { BucketName: "example-assets" },
    }],
    "aws-get": [{
      modelType: "@swamp/aws/s3/bucket",
      name: "x",
      attributes: S3_BUCKET,
    }],
  };
  const args = {
    ...BASE_ARGS,
    source: { provider: "aws", behaviors: ["aws-list", "aws-get"] },
  };
  const inv = contextWith(records, {}, args);
  await behavior.methods.inventory.execute({}, inv.context);
  const inventory = written(inv, "inventory");
  assertEquals(inventory.resources.length, 1);
  assertEquals(
    inventory.resources[0].unknownFields,
    [],
    "the fuller record wins",
  );
});

Deno.test("resolve refuses secret-looking overrides, however nested", async () => {
  const { inventory } = await mapWith();
  const r = contextWith(NET_RECORDS, { inventory }, NET_ARGS);
  await assertRejects(
    () =>
      behavior.methods.resolve.execute({
        sourceId: "aws:vm:i-0eee",
        resolution: "x",
        by: "p",
        overrides: {
          metadata: { items: [{ key: "x", dbPassword: "hunter2" }] },
        },
      }, r.context),
    Error,
    "may not carry secrets",
  );
  assertEquals(
    secretLikeKeys({
      BypassPolicyLockoutSafetyCheck: true,
      authorizedNetwork: "n",
    }),
    [],
  );
});

Deno.test("snapshots: bad records are refused, missing files say where they looked, parse errors never echo content", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/bad.json`,
    JSON.stringify({ records: [null] }),
  );
  await assertRejects(
    () => readSnapshot("bad.json", dir),
    Error,
    "record 0 needs",
  );
  await Deno.writeTextFile(
    `${dir}/arr.json`,
    JSON.stringify({
      records: [{ behaviorName: "b", behaviorType: "t", attributes: [] }],
    }),
  );
  await assertRejects(
    () => readSnapshot("arr.json", dir),
    Error,
    "record 0 needs",
  );
  await Deno.writeTextFile(`${dir}/env.json`, "AWS_SECRET=leaky");
  const err = await assertRejects(
    () => readSnapshot("env.json", dir),
    Error,
    "is not valid JSON",
  );
  assert(!err.message.includes("leaky"));
  await assertRejects(
    () => readSnapshot("nope.json", dir, (p) => `/shipped/${p}`),
    Error,
    "/shipped/nope.json",
  );
  // A shipped file is found through extensionFile when the repo has none.
  await Deno.writeTextFile(
    `${dir}/shipped.json`,
    JSON.stringify({ records: [] }),
  );
  assertEquals(
    await readSnapshot(
      "demo.json",
      "/nonexistent",
      () => `${dir}/shipped.json`,
    ),
    [],
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("parity on a plan with no waves says so plainly", async () => {
  const { context } = contextWith({}, {
    mapping: { entries: [] },
    plan: { waves: [] },
  });
  await assertRejects(
    () => behavior.methods.parity.execute({}, context),
    Error,
    "no waves",
  );
});

// Run with `deno test -A`. Renders a representative canonical resource of
// every AWS kind and checks the global arguments against the real Zod
// `globalArguments` of the pulled @swamp/aws/* model (the same schema swamp
// validates a model definition with), so a missing required argument or a
// wrong shape fails here instead of at `swamp model create`.
//
// The pulled models live under `.swamp/pulled-extensions/` (not committed):
// a case is skipped, not failed, when its file is absent, so the suite still
// passes on a clean checkout. After `swamp extension pull @swamp/aws/<pkg>`
// the cases run.
//
// CEL: dependencies render as `${{ ... }}` strings, which only resolve at run
// time. A schema issue whose offending value is such a string is ignored, so
// a CEL expression standing in for a number or boolean does not fail the
// test; every other issue (missing argument, wrong type, unknown shape) does.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  KindAdapter,
  RenderContext,
  TargetSettings,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { aws } from "./aws.ts";

const TARGET: TargetSettings = { provider: "aws", region: "eu-west-2" };
const PULLED = new URL(
  "../../../../.swamp/pulled-extensions/@swamp/aws/",
  import.meta.url,
);

/** Pulled model file for each behavior type, relative to PULLED. */
const MODEL_FILES: Record<string, string> = {
  "@swamp/aws/s3/bucket": "s3/models/bucket.ts",
  "@swamp/aws/ec2/vpc": "ec2/models/vpc.ts",
  "@swamp/aws/ec2/subnet": "ec2/models/subnet.ts",
  "@swamp/aws/ec2/security-group": "ec2/models/security_group.ts",
  "@swamp/aws/ec2/instance": "ec2/models/instance.ts",
  "@swamp/aws/ec2/volume": "ec2/models/volume.ts",
  "@swamp/aws/elasticloadbalancingv2/load-balancer":
    "elasticloadbalancingv2/models/load_balancer.ts",
  "@swamp/aws/route53/hosted-zone": "route53/models/hosted_zone.ts",
  "@swamp/aws/route53/record-set": "route53/models/record_set.ts",
  "@swamp/aws/eks/cluster": "eks/models/cluster.ts",
  "@swamp/aws/rds/dbinstance": "rds/models/dbinstance.ts",
  "@swamp/aws/ecr/repository": "ecr/models/repository.ts",
  "@swamp/aws/sns/topic": "sns/models/topic.ts",
  "@swamp/aws/sqs/queue": "sqs/models/queue.ts",
  "@swamp/aws/lambda/function": "lambda/models/function.ts",
  "@swamp/aws/elasticache/replication-group":
    "elasticache/models/replication_group.ts",
  "@swamp/aws/efs/file-system": "efs/models/file_system.ts",
  "@swamp/aws/dynamodb/global-table": "dynamodb/models/global_table.ts",
  "@swamp/aws/kms/key": "kms/models/key.ts",
  "@swamp/aws/secretsmanager/secret": "secretsmanager/models/secret.ts",
  "@swamp/aws/iam/role": "iam/models/role.ts",
};

const LABELS = { team: "web", "aws:cloudformation:stack-name": "x" };

/** Representative canonical properties per kind (as another provider would carry them). */
const PROPS: Record<string, Record<string, unknown>[]> = {
  "object-bucket": [{
    versioning: true,
    encryption: "provider-managed",
    publicAccess: "blocked",
    tier: null,
    labels: LABELS,
    lifecycleRules: 1,
    cors: true,
    website: false,
    retentionLocked: false,
  }],
  network: [{ cidr: "10.0.0.0/16", labels: LABELS }],
  subnet: [{
    cidr: "10.0.1.0/24",
    zone: "europe-west2-a",
    publicIpOnLaunch: false,
    labels: LABELS,
  }],
  firewall: [{
    description: "web",
    rules: [
      {
        direction: "ingress",
        protocol: "tcp",
        ports: "443",
        cidrs: ["0.0.0.0/0", "::/0"],
      },
      {
        direction: "ingress",
        protocol: "icmp",
        ports: null,
        cidrs: ["10.0.0.0/8"],
      },
      {
        direction: "egress",
        protocol: "all",
        ports: null,
        cidrs: ["0.0.0.0/0"],
      },
    ],
    labels: LABELS,
  }],
  vm: [
    {
      machineType: "e2-medium",
      vcpus: 2,
      memoryMiB: 4096,
      architecture: "x86_64",
      image: "debian-12",
      publicIp: true,
      bootDiskGiB: 20,
      labels: LABELS,
    },
    {
      machineType: "t3.small",
      vcpus: 2,
      memoryMiB: 2048,
      architecture: "x86_64",
      image: "ami-0abc",
      publicIp: null,
      bootDiskGiB: null,
      labels: {},
    },
  ],
  "block-volume": [{
    sizeGiB: 100,
    media: "ssd",
    iops: 6000,
    encryption: "customer-key",
    zone: "europe-west2-a",
    labels: LABELS,
  }],
  "load-balancer": [{
    scheme: "internet",
    layer: "application",
    listeners: [{ protocol: "HTTPS", port: 443 }],
    labels: LABELS,
  }],
  "dns-zone": [
    { domain: "example.com", private: false, labels: LABELS },
    { domain: "corp.internal", private: true, labels: {} },
  ],
  "dns-record": [
    { name: "www.example.com", type: "A", ttl: 300, values: ["192.0.2.1"] },
    {
      name: "mail.example.com",
      type: "MX",
      ttl: 60,
      values: ["10 mx.example.net"],
    },
    {
      name: "x.example.com",
      type: "CNAME",
      ttl: 300,
      values: ["y.example.net"],
    },
    { name: "example.com", type: "NS", ttl: 300, values: ["ns-1.example.net"] },
  ],
  "kubernetes-cluster": [{
    version: "1.30.2-gke.100",
    nodeCount: 3,
    privateEndpoint: true,
    labels: LABELS,
  }],
  "sql-database": [{
    engine: "postgres",
    engineVersion: "15",
    instanceClass: "db-custom-2-8192",
    vcpus: 2,
    memoryMiB: 8192,
    storageGiB: 100,
    highAvailability: true,
    backupRetentionDays: 7,
    publicAccess: false,
    labels: LABELS,
  }],
  "container-registry": [{
    name: "team/app",
    immutableTags: true,
    scanOnPush: true,
    labels: LABELS,
  }],
  "message-topic": [{ name: "events", ordered: true, labels: LABELS }],
  "message-queue": [{
    name: "jobs",
    ordered: false,
    visibilityTimeoutSeconds: 30,
    retentionSeconds: 345600,
    deadLetter: true,
    labels: LABELS,
  }],
  function: [{
    runtime: "python3.12",
    memoryMiB: 256,
    timeoutSeconds: 30,
    entryPoint: "main.handler",
    labels: LABELS,
  }],
  cache: [
    {
      engine: "redis",
      engineVersion: "7.0",
      memoryGiB: 4,
      nodes: 2,
      labels: LABELS,
    },
    {
      engine: "redis",
      engineVersion: "7.0",
      memoryGiB: 4,
      nodes: 9,
      shards: 3,
      replicasPerShard: 2,
      labels: {},
    },
    { engine: "redis", memoryGiB: 4, nodes: 20, labels: {} },
  ],
  "file-share": [{
    protocol: "nfs",
    capacityGiB: null,
    performance: "high",
    encryption: "provider-managed",
    labels: LABELS,
  }],
  "nosql-table": [{
    name: "orders",
    keys: ["id", "created"],
    billing: "on-demand",
    pointInTimeRecovery: true,
    labels: LABELS,
  }],
  "kms-key": [{ purpose: "encrypt", rotation: true, labels: LABELS }],
  secret: [{ name: "api", rotation: false, labels: LABELS }],
  "iam-principal": [{
    name: "app",
    principalType: "role",
    description: "app role",
  }],
};

function resource(
  kind: ResourceKind,
  provider: string,
  properties: Record<string, unknown>,
): CanonicalResource {
  return {
    id: `${provider}:${kind}:x`,
    provider,
    kind,
    nativeId: "x",
    aliases: [],
    name: "thing",
    region: provider === "aws" ? "eu-west-2" : "europe-west2",
    source: { behaviorType: "x", behaviorName: "x" },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
  };
}

/** A context where every kind has two migrated dependencies (or none). */
function context(withDeps: boolean): RenderContext {
  return {
    refTo: (id, field) =>
      `\${{ data.findBySpec("${id}", "state")[0].attributes.${
        field ?? "id"
      } }}`,
    dependencies: (kind) => withDeps ? [`dep-${kind}-1`, `dep-${kind}-2`] : [],
    targetNameOf: (id) => withDeps ? `t-${id}` : null,
  };
}

const isCel = (v: unknown) => typeof v === "string" && v.includes("${{");

/** Value at `path` in `root`, or undefined. */
function at(root: unknown, path: PropertyKey[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

interface ZodLike {
  safeParse(v: unknown): {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
}

function exists(file: string): boolean {
  try {
    return Deno.statSync(new URL(file, PULLED)).isFile;
  } catch {
    return false;
  }
}

async function schemaOf(file: string): Promise<ZodLike> {
  const mod = await import(new URL(file, PULLED).href);
  return mod.model.globalArguments as ZodLike;
}

for (
  const [kind, adapter] of Object.entries(aws.kinds) as [
    ResourceKind,
    KindAdapter,
  ][]
) {
  const file = MODEL_FILES[adapter.behaviorType];
  const present = file !== undefined && exists(file);
  Deno.test({
    name: `schema: ${kind} renders valid ${adapter.behaviorType} arguments`,
    ignore: !present,
    fn: async () => {
      assert(file, `no model file registered for ${adapter.behaviorType}`);
      const schema = await schemaOf(file);
      const cases = PROPS[kind];
      assert(cases, `no representative properties for ${kind}`);
      let n = 0;
      for (const provider of ["gcp", "aws"]) {
        for (const props of cases) {
          for (const withDeps of [false, true]) {
            const out = adapter.render(
              resource(kind, provider, props),
              "tgt-name",
              TARGET,
              context(withDeps),
            );
            const res = schema.safeParse(out.globalArguments);
            const issues = (res.error?.issues ?? []).filter((i) =>
              !isCel(at(out.globalArguments, i.path))
            );
            assertEquals(
              issues.map((i) => `${i.path.join(".")}: ${i.message}`),
              [],
              `${kind} from ${provider} ${
                withDeps ? "with" : "without"
              } deps: ${JSON.stringify(out.globalArguments)}`,
            );
            n++;
          }
        }
      }
      assert(n > 0);
    },
  });
}

Deno.test("schema table covers every AWS kind", () => {
  for (const [kind, adapter] of Object.entries(aws.kinds)) {
    assert(MODEL_FILES[adapter!.behaviorType], `${kind} has no model file`);
    assert(PROPS[kind], `${kind} has no representative properties`);
  }
});

// ---------------------------------------------------------------------------
// S3 bucket (aws.ts)

const bucket = aws.kinds["object-bucket"]!;

Deno.test("s3: a configured bucket with no VersioningConfiguration is unversioned", () => {
  const r = bucket.normalise(
    {
      BucketName: "b-1234",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
        }],
      },
    },
    "b",
    "eu-west-2",
  );
  assertEquals(r.properties.versioning, false);
  assertEquals(r.unknownFields.includes("versioning"), false);
});

Deno.test("s3: a bare list result leaves versioning unknown", () => {
  const r = bucket.normalise({ BucketName: "b-1234" }, "b", "eu-west-2");
  assertEquals(r.properties.versioning, null);
  assert(r.unknownFields.includes("versioning"));
  const enabled = bucket.normalise(
    { BucketName: "b-1234", VersioningConfiguration: { Status: "Enabled" } },
    "b",
    "eu-west-2",
  );
  assertEquals(enabled.properties.versioning, true);
});

Deno.test("s3: the reserved aws: tag prefix is dropped with a loss", () => {
  const out = bucket.render(
    resource("object-bucket", "gcp", {
      versioning: false,
      encryption: "provider-managed",
      publicAccess: "blocked",
      labels: LABELS,
    }),
    "b-1234",
    TARGET,
    context(false),
  );
  assertEquals(out.globalArguments.Tags, [{ Key: "team", Value: "web" }]);
  assert(out.losses.some((l) => l.includes("aws:")));
  assertEquals(out.expected.labels, { team: "web" });
});

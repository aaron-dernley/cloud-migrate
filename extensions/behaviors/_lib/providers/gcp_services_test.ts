// Rendered global arguments are untyped JSON; tests index into them freely.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  RenderContext,
  TargetSettings,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { gcpServiceKinds } from "./gcp_services.ts";

const target: TargetSettings = {
  provider: "gcp",
  region: "europe-west2",
  project: "demo-project",
};

/** A fake render context: `deps` maps a kind to dependency ids; refTo answers for those ids. */
function ctx(
  deps: Partial<Record<ResourceKind, string[]>> = {},
): RenderContext {
  const all = new Set(Object.values(deps).flat());
  return {
    refTo: (id, field) =>
      all.has(id) ? `\${{ ref(${id}).${field ?? "name"} }}` : null,
    dependencies: (kind) => deps[kind] ?? [],
    targetNameOf: (id) => all.has(id) ? id : null,
  };
}

/** A hand-built canonical resource, as another provider's adapter would produce. */
function canonical(
  kind: ResourceKind,
  properties: Record<string, unknown>,
  extra: Partial<CanonicalResource> = {},
): CanonicalResource {
  return {
    id: `aws:${kind}:thing`,
    provider: "aws",
    kind,
    nativeId: "thing",
    aliases: [],
    name: "thing",
    region: "eu-west-2",
    source: { behaviorType: "@swamp/aws/x", behaviorName: "x" },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
    ...extra,
  };
}

const kinds = gcpServiceKinds as Record<
  string,
  NonNullable<typeof gcpServiceKinds[ResourceKind]>
>;

Deno.test("all service kinds are exported with their behavior types", () => {
  assertEquals(
    Object.fromEntries(
      Object.entries(kinds).map((
        [k, v],
      ) => [k, `${v.behaviorType} ${v.idField}`]),
    ),
    {
      "sql-database": "@swamp/gcp/sqladmin/instances name",
      "container-registry": "@swamp/gcp/artifactregistry/repositories name",
      "message-topic": "@swamp/gcp/pubsub/topics name",
      "message-queue": "@swamp/gcp/pubsub/subscriptions name",
      function: "@swamp/gcp/cloudfunctions/functions name",
      cache: "@swamp/gcp/redis/instances name",
      "file-share": "@swamp/gcp/file/instances name",
      "nosql-table": "@swamp/gcp/firestore/databases name",
      "kms-key": "@swamp/gcp/cloudkms/keyrings-cryptokeys name",
      secret: "@swamp/gcp/secretmanager/secrets name",
      "iam-principal": "@swamp/gcp/iam/serviceaccounts email",
    },
  );
});

// ---------------------------------------------------------------- sql-database

const sqlState = {
  name: "demo-db",
  region: "europe-west2",
  databaseVersion: "POSTGRES_15",
  connectionName: "demo-project:europe-west2:demo-db",
  rootPassword: "do-not-keep-me",
  settings: {
    tier: "db-custom-2-7680",
    availabilityType: "REGIONAL",
    dataDiskSizeGb: "50",
    userLabels: { env: "dev" },
    backupConfiguration: {
      enabled: true,
      backupRetentionSettings: { retainedBackups: 7, retentionUnit: "COUNT" },
    },
    ipConfiguration: {
      ipv4Enabled: false,
      privateNetwork: "projects/demo-project/global/networks/demo-net",
    },
  },
  diskEncryptionConfiguration: {
    kmsKeyName:
      "projects/demo-project/locations/europe-west2/keyRings/r/cryptoKeys/k",
  },
};

Deno.test("sql-database normalise", () => {
  const r = kinds["sql-database"].normalise(sqlState, "db", null);
  assertEquals(r.id, "gcp:sql-database:demo-db");
  assertEquals(r.region, "europe-west2");
  assertEquals(r.aliases, ["demo-project:europe-west2:demo-db"]);
  assertEquals(r.properties, {
    engine: "postgres",
    engineVersion: "15",
    instanceClass: "db-custom-2-7680",
    vcpus: 2,
    memoryMiB: 7680,
    storageGiB: 50,
    highAvailability: true,
    backupRetentionDays: 7,
    publicAccess: false,
    labels: { env: "dev" },
  });
  assertEquals(r.refs.map((x) => x.kind), ["network", "kms-key"]);
  assertEquals(r.unknownFields, []);
  // The password in the state is never copied into the canonical record.
  assert(!JSON.stringify(r).includes("do-not-keep-me"));
});

Deno.test("sql-database normalise reports unknown fields", () => {
  const r = kinds["sql-database"].normalise({ name: "x" }, "db", null);
  assert(r.unknownFields.includes("engine"));
  assert(r.unknownFields.includes("region"));
  assertEquals(r.properties.engine, null);
});

Deno.test("sql-database render from aws: sizing loss, version, vault decision", () => {
  const res = canonical("sql-database", {
    engine: "postgres",
    engineVersion: "15.4",
    instanceClass: "db.m5.large",
    vcpus: 2,
    memoryMiB: 8192,
    storageGiB: 100,
    highAvailability: true,
    backupRetentionDays: 7,
    publicAccess: false,
    labels: { Env: "Dev" },
  });
  const out = kinds["sql-database"].render(
    res,
    "orders-db",
    target,
    ctx({ network: ["aws:network:vpc"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.databaseVersion, "POSTGRES_15");
  assertEquals(g.name, "orders-db");
  assertEquals(g.region, "europe-west2");
  assertEquals(g.project, "demo-project");
  assertEquals(g.settings.tier, "db-custom-2-8192");
  assertEquals(g.settings.availabilityType, "REGIONAL");
  assertEquals(g.settings.dataDiskSizeGb, "100");
  assertEquals(
    g.settings.ipConfiguration.privateNetwork,
    "projects/demo-project/global/networks/aws:network:vpc",
  );
  assertEquals(g.settings.userLabels, { env: "dev" });
  assert(out.losses.some((l) => l.includes("db-custom-2-8192")));
  assert(out.losses.some((l) => l.includes('label "Env=Dev"')));
  assert(out.decisions.some((d) => d.includes("vault.get")));
  assertEquals(out.expected.instanceClass, "db-custom-2-8192");
  assertEquals(out.expected.engineVersion, "15");
  assertEquals(out.expected.labels, { env: "dev" });
});

Deno.test("sql-database render: tiny sizes use shared-core tiers", () => {
  const res = canonical("sql-database", {
    engine: "mysql",
    engineVersion: "8.0",
    vcpus: 1,
    memoryMiB: 1024,
    storageGiB: 5,
  });
  const g = kinds["sql-database"].render(res, "tiny", target, ctx())
    .globalArguments as Record<
      string,
      any
    >;
  assertEquals(g.databaseVersion, "MYSQL_8_0");
  assertEquals(g.settings.tier, "db-g1-small");
  assertEquals(g.settings.dataDiskSizeGb, "10");
});

Deno.test("sql-database render: unsupported engine and missing project need decisions", () => {
  const res = canonical("sql-database", {
    engine: "oracle",
    engineVersion: "19",
    vcpus: 4,
    memoryMiB: 16384,
    storageGiB: 100,
  });
  const out = kinds["sql-database"].render(
    res,
    "ora",
    { provider: "gcp", region: "europe-west2" },
    ctx(),
  );
  assert(out.decisions.some((d) => d.includes("does not offer oracle")));
  assert(out.decisions.some((d) => d.includes("target.project")));
  assertEquals(out.globalArguments.databaseVersion, undefined);
});

Deno.test("sql-database render never renders a password", () => {
  const res = canonical("sql-database", {
    engine: "mysql",
    engineVersion: "8.0",
    vcpus: 2,
    memoryMiB: 8192,
    storageGiB: 20,
  });
  const out = kinds["sql-database"].render(res, "db", target, ctx());
  assertNoSecrets(out.globalArguments);
});

Deno.test("sql-database validateName", () => {
  assertEquals(kinds["sql-database"].validateName("orders-db"), []);
  assert(kinds["sql-database"].validateName("Orders_DB").length > 0);
  assert(kinds["sql-database"].validateName("1db").length > 0);
  assert(kinds["sql-database"].validateName("db-").length > 0);
});

// ---------------------------------------------------------- container-registry

Deno.test("container-registry normalise and render", () => {
  const r = kinds["container-registry"].normalise(
    {
      name: "projects/demo-project/locations/europe-west2/repositories/images",
      format: "DOCKER",
      dockerConfig: { immutableTags: true },
      labels: { team: "a" },
      kmsKeyName:
        "projects/demo-project/locations/europe-west2/keyRings/r/cryptoKeys/k",
      vulnerabilityScanningConfig: { enablementState: "SCANNING_ACTIVE" },
    },
    "repo",
    null,
  );
  assertEquals(r.name, "images");
  assertEquals(r.region, "europe-west2");
  assertEquals(r.properties, {
    name: "images",
    immutableTags: true,
    scanOnPush: true,
    labels: { team: "a" },
  });
  assertEquals(r.refs, [{
    kind: "kms-key",
    nativeId:
      "projects/demo-project/locations/europe-west2/keyRings/r/cryptoKeys/k",
    via: "kmsKeyName",
  }]);

  const out = kinds["container-registry"].render(
    canonical("container-registry", {
      name: "app",
      immutableTags: true,
      scanOnPush: true,
      labels: {},
    }),
    "app",
    target,
    ctx({ "kms-key": ["aws:kms-key:k"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.format, "DOCKER");
  assertEquals(g.repositoryId, "app");
  assertEquals(g.location, "europe-west2");
  assertEquals(g.dockerConfig, { immutableTags: true });
  assertEquals(g.kmsKeyName, "${{ ref(aws:kms-key:k).name }}");
  assert(out.losses.some((l) => l.includes("images are not copied")));
  assertEquals(
    kinds["container-registry"].validateName("My_Repo").length > 0,
    true,
  );
  assertEquals(kinds["container-registry"].validateName("my-repo"), []);
});

// --------------------------------------------------------------- message-topic

Deno.test("message-topic normalise and render", () => {
  const r = kinds["message-topic"].normalise(
    {
      name: "projects/demo-project/topics/events",
      labels: { a: "b" },
      kmsKeyName:
        "projects/demo-project/locations/global/keyRings/r/cryptoKeys/k",
    },
    "topic",
    null,
  );
  assertEquals(r.nativeId, "projects/demo-project/topics/events");
  assertEquals(r.name, "events");
  assertEquals(r.region, null);
  assertEquals(r.properties, {
    name: "events",
    ordered: false,
    labels: { a: "b" },
  });
  assertEquals(r.refs[0].kind, "kms-key");

  const out = kinds["message-topic"].render(
    canonical("message-topic", { name: "events", ordered: true, labels: {} }),
    "events",
    target,
    ctx(),
  );
  assertEquals(out.globalArguments.name, "projects/demo-project/topics/events");
  assert(out.losses.some((l) => l.includes("ordering key")));
  assertEquals(out.expected.ordered, false);
  assert(kinds["message-topic"].validateName("ab").length > 0);
  assert(kinds["message-topic"].validateName("1abc").length > 0);
  assert(kinds["message-topic"].validateName("goog-x").length > 0);
  assertEquals(kinds["message-topic"].validateName("my.topic_1"), []);
});

// -------------------------------------------------------------- message-queue

Deno.test("message-queue normalise refs topic and dead-letter topic", () => {
  const r = kinds["message-queue"].normalise(
    {
      name: "projects/demo-project/subscriptions/work",
      topic: "projects/demo-project/topics/events",
      ackDeadlineSeconds: 30,
      messageRetentionDuration: "86400s",
      enableMessageOrdering: true,
      deadLetterPolicy: {
        deadLetterTopic: "projects/demo-project/topics/dlq",
        maxDeliveryAttempts: 5,
      },
    },
    "sub",
    null,
  );
  assertEquals(r.properties, {
    name: "work",
    ordered: true,
    visibilityTimeoutSeconds: 30,
    retentionSeconds: 86400,
    deadLetter: true,
    labels: {},
  });
  assertEquals(r.refs.map((x) => `${x.kind}:${x.via}`), [
    "message-topic:topic",
    "message-topic:deadLetterPolicy.deadLetterTopic",
  ]);
});

Deno.test("message-queue render with a topic dependency clamps and reports", () => {
  const res = canonical("message-queue", {
    name: "q",
    ordered: false,
    visibilityTimeoutSeconds: 900,
    retentionSeconds: 1209600,
    deadLetter: false,
    labels: {},
  });
  const out = kinds["message-queue"].render(
    res,
    "q",
    target,
    ctx({ "message-topic": ["aws:message-topic:t"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.name, "projects/demo-project/subscriptions/q");
  assertEquals(g.topic, "${{ ref(aws:message-topic:t).name }}");
  assertEquals(g.ackDeadlineSeconds, 600);
  assertEquals(g.messageRetentionDuration, "604800s");
  assertEquals(out.losses.length, 2);
  assertEquals(out.decisions, []);
});

Deno.test("message-queue render without a topic needs a decision", () => {
  const res = canonical("message-queue", {
    name: "q",
    ordered: false,
    visibilityTimeoutSeconds: 30,
    retentionSeconds: 345600,
    deadLetter: true,
    labels: {},
  });
  const out = kinds["message-queue"].render(res, "q", target, ctx());
  assertEquals(out.globalArguments.topic, undefined);
  assert(out.decisions.some((d) => d.includes("needs a topic")));
  assert(out.decisions.some((d) => d.includes("dead-letter")));
});

Deno.test("message-queue render picks the dead-letter topic apart from the main topic", () => {
  const res = canonical("message-queue", {
    name: "q",
    ordered: false,
    visibilityTimeoutSeconds: 30,
    retentionSeconds: 3600,
    deadLetter: true,
    labels: {},
  }, {
    provider: "gcp",
    refs: [{
      kind: "message-topic",
      nativeId: "dlq",
      via: "deadLetterPolicy.deadLetterTopic",
    }],
  });
  const out = kinds["message-queue"].render(
    res,
    "q",
    target,
    ctx({
      "message-topic": ["gcp:message-topic:main", "gcp:message-topic:dlq"],
    }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.topic, "${{ ref(gcp:message-topic:main).name }}");
  assertEquals(
    g.deadLetterPolicy.deadLetterTopic,
    "${{ ref(gcp:message-topic:dlq).name }}",
  );
  assertEquals(out.decisions, []);
});

// -------------------------------------------------------------------- function

Deno.test("function normalise and render", () => {
  const r = kinds.function.normalise(
    {
      name: "projects/demo-project/locations/europe-west2/functions/hello",
      buildConfig: { runtime: "python312", entryPoint: "handler" },
      serviceConfig: {
        availableMemory: "512Mi",
        timeoutSeconds: 60,
        serviceAccountEmail: "runner@demo-project.iam.gserviceaccount.com",
        vpcConnector:
          "projects/demo-project/locations/europe-west2/connectors/c",
        environmentVariables: { TOKEN: "do-not-keep-me" },
      },
      labels: { a: "b" },
    },
    "fn",
    null,
  );
  assertEquals(r.properties, {
    runtime: "python3.12",
    memoryMiB: 512,
    timeoutSeconds: 60,
    entryPoint: "handler",
    labels: { a: "b" },
  });
  assertEquals(r.refs.map((x) => x.kind), ["iam-principal"]);
  assert(!JSON.stringify(r).includes("do-not-keep-me"));

  const out = kinds.function.render(
    canonical("function", {
      runtime: "nodejs20.x",
      memoryMiB: 64,
      timeoutSeconds: 900,
      entryPoint: "index.handler",
      labels: {},
    }),
    "hello",
    target,
    ctx({ "iam-principal": ["aws:iam-principal:role"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.buildConfig.runtime, "nodejs20");
  assertEquals(g.serviceConfig.availableMemory, "128Mi");
  assertEquals(g.serviceConfig.timeoutSeconds, 900);
  assertEquals(
    g.serviceConfig.serviceAccountEmail,
    "${{ ref(aws:iam-principal:role).email }}",
  );
  assertEquals(g.environment, "GEN_2");
  assert(out.losses.some((l) => l.includes("128 MiB")));
  assert(out.decisions.some((d) => d.includes("buildConfig.source")));
  assertEquals(out.expected.runtime, "nodejs20");
});

Deno.test("function render: unsupported runtime needs a decision; network needs a connector", () => {
  const out = kinds.function.render(
    canonical("function", {
      runtime: "python3.6",
      memoryMiB: 256,
      timeoutSeconds: 30,
      entryPoint: null,
      labels: {},
    }),
    "legacy",
    target,
    ctx({ network: ["aws:network:v"] }),
  );
  assertEquals(
    (out.globalArguments.buildConfig as Record<string, unknown>).runtime,
    undefined,
  );
  assert(
    out.decisions.some((d) => d.includes("does not offer runtime python3.6")),
  );
  assert(out.decisions.some((d) => d.includes("Serverless VPC Access")));
  assert(kinds.function.validateName("abc").length > 0);
  assertEquals(kinds.function.validateName("hello-fn"), []);
});

// ----------------------------------------------------------------------- cache

Deno.test("cache normalise and render", () => {
  const r = kinds.cache.normalise(
    {
      name: "projects/demo-project/locations/europe-west2/instances/sessions",
      tier: "STANDARD_HA",
      replicaCount: 2,
      memorySizeGb: 4,
      redisVersion: "REDIS_7_2",
      authorizedNetwork: "projects/demo-project/global/networks/demo-net",
      labels: { a: "b" },
      authString: "do-not-keep-me",
    },
    "cache",
    null,
  );
  assertEquals(r.properties, {
    engine: "redis",
    engineVersion: "7.2",
    memoryGiB: 4,
    nodes: 3,
    labels: { a: "b" },
  });
  assertEquals(r.region, "europe-west2");
  assertEquals(r.refs[0].kind, "network");
  assert(!JSON.stringify(r).includes("do-not-keep-me"));

  const out = kinds.cache.render(
    canonical("cache", {
      engine: "redis",
      engineVersion: "7.1",
      memoryGiB: 1.5,
      nodes: 2,
      labels: {},
    }),
    "sessions",
    target,
    ctx({ network: ["aws:network:v"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.memorySizeGb, 2);
  assertEquals(g.tier, "STANDARD_HA");
  assertEquals(g.replicaCount, 1);
  assertEquals(
    g.authorizedNetwork,
    "projects/demo-project/global/networks/aws:network:v",
  );
  assertEquals(g.redisVersion, undefined);
  assert(out.decisions.some((d) => d.includes("does not offer version 7.1")));
  assert(out.losses.some((l) => l.includes("2 GiB")));
});

Deno.test("cache render: memcached needs a decision, 6.2 maps to REDIS_6_X", () => {
  const out = kinds.cache.render(
    canonical("cache", {
      engine: "memcached",
      engineVersion: "6.2",
      memoryGiB: 1,
      nodes: 1,
      labels: {},
    }),
    "c",
    target,
    ctx(),
  );
  assert(out.decisions.some((d) => d.includes("Redis only")));
  assertEquals(out.globalArguments.redisVersion, "REDIS_6_X");
  assertEquals(out.globalArguments.tier, "BASIC");
  assertEquals(kinds.cache.validateName("Cache").length > 0, true);
});

// ------------------------------------------------------------------ file-share

Deno.test("file-share normalise and render", () => {
  const r = kinds["file-share"].normalise(
    {
      name: "projects/demo-project/locations/europe-west2-a/instances/shared",
      tier: "BASIC_SSD",
      protocol: "NFS_V3",
      fileShares: [{ name: "vol1", capacityGb: "2560" }],
      networks: [{ network: "demo-net", modes: ["MODE_IPV4"] }],
      labels: { a: "b" },
    },
    "fs",
    null,
  );
  assertEquals(r.properties, {
    protocol: "nfs",
    capacityGiB: 2560,
    performance: "high",
    encryption: "provider-managed",
    labels: { a: "b" },
  });
  assertEquals(r.region, "europe-west2");
  assertEquals(r.refs, [{
    kind: "network",
    nativeId: "demo-net",
    via: "networks[0].network",
  }]);

  const out = kinds["file-share"].render(
    canonical("file-share", {
      protocol: "nfs",
      capacityGiB: 100,
      performance: "standard",
      encryption: "provider-managed",
      labels: {},
    }),
    "shared",
    target,
    ctx({ network: ["aws:network:v"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.tier, "BASIC_HDD");
  assertEquals(g.location, "europe-west2-a");
  assertEquals(g.fileShares, [{ name: "share1", capacityGb: "1024" }]);
  assertEquals(g.networks[0].network, "aws:network:v");
  assert(out.losses.some((l) => l.includes("1024 GiB")));
  assertEquals(out.expected.capacityGiB, 1024);
});

Deno.test("file-share render: customer key uses ENTERPRISE; smb needs a decision", () => {
  const out = kinds["file-share"].render(
    canonical("file-share", {
      protocol: "smb",
      capacityGiB: null,
      performance: "high",
      encryption: "customer-key",
      labels: {},
    }),
    "shared",
    target,
    ctx({ "kms-key": ["aws:kms-key:k"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.tier, "ENTERPRISE");
  assertEquals(g.location, "europe-west2");
  assertEquals(g.kmsKeyName, "${{ ref(aws:kms-key:k).name }}");
  assertEquals(g.protocol, undefined);
  assert(out.decisions.some((d) => d.includes("NFS only")));
  assert(out.decisions.some((d) => d.includes("VPC network")));
});

// ----------------------------------------------------------------- nosql-table

Deno.test("nosql-table normalise and render", () => {
  const r = kinds["nosql-table"].normalise(
    {
      name: "projects/demo-project/databases/orders",
      locationId: "europe-west2",
      pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_ENABLED",
      cmekConfig: {
        kmsKeyName:
          "projects/demo-project/locations/europe-west2/keyRings/r/cryptoKeys/k",
      },
    },
    "fs",
    null,
  );
  assertEquals(r.properties, {
    name: "orders",
    keys: ["__name__"],
    billing: "on-demand",
    pointInTimeRecovery: true,
    labels: {},
  });
  assertEquals(r.refs[0].kind, "kms-key");

  const out = kinds["nosql-table"].render(
    canonical("nosql-table", {
      name: "orders",
      keys: ["id"],
      billing: "provisioned",
      pointInTimeRecovery: true,
      labels: { a: "b" },
    }),
    "orders",
    target,
    ctx(),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.databaseId, "orders");
  assertEquals(g.locationId, "europe-west2");
  assertEquals(g.type, "FIRESTORE_NATIVE");
  assertEquals(
    g.pointInTimeRecoveryEnablement,
    "POINT_IN_TIME_RECOVERY_ENABLED",
  );
  assert(out.losses.some((l) => l.includes("no labels")));
  assertEquals(kinds["nosql-table"].validateName("(default)"), []);
  assert(kinds["nosql-table"].validateName("abc").length > 0);
  assert(
    kinds["nosql-table"].validateName("3f2504e0-4f89-11d3-9a0c-0305e82c3301")
      .length > 0,
  );
});

// --------------------------------------------------------------------- kms-key

Deno.test("kms-key normalise and render with a key ring decision", () => {
  const path =
    "projects/demo-project/locations/europe-west2/keyRings/ring/cryptoKeys/key1";
  const r = kinds["kms-key"].normalise(
    {
      name: path,
      purpose: "ENCRYPT_DECRYPT",
      rotationPeriod: "7776000s",
      labels: { a: "b" },
    },
    "k",
    null,
  );
  assertEquals(r.nativeId, path);
  assertEquals(r.properties, {
    purpose: "encrypt",
    rotation: true,
    labels: { a: "b" },
  });

  const out = kinds["kms-key"].render(
    canonical("kms-key", { purpose: "encrypt", rotation: true, labels: {} }),
    "key1",
    target,
    ctx(),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(
    g.parent,
    "projects/demo-project/locations/europe-west2/keyRings/key1-keyring",
  );
  assertEquals(g.cryptoKeyId, "key1");
  assertEquals(g.purpose, "ENCRYPT_DECRYPT");
  assertEquals(g.rotationPeriod, "7776000s");
  assert(out.decisions.some((d) => d.includes("key ring")));
  assert(out.decisions.some((d) => d.includes("nextRotationTime")));
  assert(out.losses.some((l) => l.includes("90 days")));

  const sign = kinds["kms-key"].render(
    canonical("kms-key", { purpose: "sign", rotation: true, labels: {} }),
    "sk",
    target,
    ctx(),
  );
  assertEquals(sign.globalArguments.purpose, "ASYMMETRIC_SIGN");
  assertEquals(sign.expected.rotation, false);
  assertEquals(kinds["kms-key"].validateName("a/b").length > 0, true);
});

Deno.test("kms-key render keeps the key ring name for a gcp source", () => {
  const res = canonical("kms-key", {
    purpose: "encrypt",
    rotation: false,
    labels: {},
  }, {
    provider: "gcp",
    nativeId: "projects/p/locations/l/keyRings/ring/cryptoKeys/k",
  });
  const out = kinds["kms-key"].render(res, "k", target, ctx());
  assertEquals(
    out.globalArguments.parent,
    "projects/demo-project/locations/europe-west2/keyRings/ring",
  );
});

// ---------------------------------------------------------------------- secret

Deno.test("secret normalise and render the container only", () => {
  const r = kinds.secret.normalise(
    {
      name: "projects/demo-project/secrets/api-key",
      labels: { a: "b" },
      rotation: {
        nextRotationTime: "2030-01-01T00:00:00Z",
        rotationPeriod: "2592000s",
      },
      replication: {
        automatic: {
          customerManagedEncryption: {
            kmsKeyName: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
          },
        },
      },
      payload: { data: "do-not-keep-me" },
    },
    "sec",
    null,
  );
  assertEquals(r.properties, {
    name: "api-key",
    rotation: true,
    labels: { a: "b" },
  });
  assertEquals(r.refs.map((x) => x.kind), ["kms-key"]);
  assert(!JSON.stringify(r).includes("do-not-keep-me"));

  const out = kinds.secret.render(
    canonical("secret", {
      name: "db/password",
      rotation: true,
      labels: { Env: "x" },
    }),
    "db-password",
    target,
    ctx({ "kms-key": ["aws:kms-key:k"] }),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.secretId, "db-password");
  assertEquals(
    g.replication.automatic.customerManagedEncryption.kmsKeyName,
    "${{ ref(aws:kms-key:k).name }}",
  );
  assertEquals(g.payload, undefined);
  assertEquals(g.rotation, undefined);
  assert(out.losses.some((l) => l.includes("rotation")));
  assertNoSecrets(g);
  assert(kinds.secret.validateName("db/password").length > 0);
  assertEquals(kinds.secret.validateName("db-password_1"), []);
});

// ---------------------------------------------------------------- iam-principal

Deno.test("iam-principal normalise and render", () => {
  const r = kinds["iam-principal"].normalise(
    {
      name:
        "projects/demo-project/serviceAccounts/runner@demo-project.iam.gserviceaccount.com",
      email: "runner@demo-project.iam.gserviceaccount.com",
      uniqueId: "100000000000000000001",
      description: "runs things",
    },
    "sa",
    null,
  );
  assertEquals(r.nativeId, "runner@demo-project.iam.gserviceaccount.com");
  assertEquals(r.name, "runner");
  assertEquals(r.properties, {
    name: "runner",
    principalType: "service-account",
    description: "runs things",
  });
  assert(r.aliases.includes("100000000000000000001"));

  const out = kinds["iam-principal"].render(
    canonical("iam-principal", {
      name: "AppRole",
      principalType: "role",
      description: "an app role",
    }),
    "app-role",
    target,
    ctx(),
  );
  const g = out.globalArguments as Record<string, any>;
  assertEquals(g.name, "projects/demo-project");
  assertEquals(g.accountId, "app-role");
  assertEquals(g.serviceAccount, {
    displayName: "app-role",
    description: "an app role",
  });
  assert(out.losses.some((l) => l.includes("trust policy")));
  assertEquals(kinds["iam-principal"].validateName("app-role"), []);
  assert(kinds["iam-principal"].validateName("abc").length > 0);
  assert(kinds["iam-principal"].validateName("Upper-case-name").length > 0);

  const user = kinds["iam-principal"].render(
    canonical("iam-principal", {
      name: "bob",
      principalType: "user",
      description: null,
    }),
    "bob-user",
    target,
    ctx(),
  );
  assert(user.decisions.some((d) => d.includes("cannot be created")));
});

// ---------------------------------------------------------------- shared checks

/** Fails when any rendered key or value looks like a credential. */
function assertNoSecrets(value: unknown, path = ""): void {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assert(
        !/password|secretvalue|payload|accesstoken|credentialsjson|authstring/i
          .test(k),
        `credential-like key ${path}${k}`,
      );
      assertNoSecrets(v, `${path}${k}.`);
    }
  } else if (typeof value === "string") {
    assert(!/do-not-keep-me/.test(value), `secret leaked at ${path}`);
  }
}

Deno.test("no kind renders credentials, whatever the input", () => {
  const poisoned = {
    password: "do-not-keep-me",
    rootPassword: "do-not-keep-me",
    secretValue: "do-not-keep-me",
    accessToken: "do-not-keep-me",
  };
  for (const [kind, adapter] of Object.entries(kinds)) {
    const res = canonical(kind as ResourceKind, { ...poisoned, labels: {} });
    const out = adapter.render(res, "thing-name", target, ctx());
    assertNoSecrets(out.globalArguments);
    assertNoSecrets(out.expected);
  }
});

Deno.test("every render names a missing project as a decision", () => {
  for (const [kind, adapter] of Object.entries(kinds)) {
    if (kind === "kms-key" || kind === "iam-principal") continue;
    const out = adapter.render(
      canonical(kind as ResourceKind, { labels: {} }),
      "thing-name",
      {
        provider: "gcp",
        region: "europe-west2",
      },
      ctx(),
    );
    assert(
      out.decisions.some((d) => d.includes("target.project")),
      `${kind} should ask for a project`,
    );
    assertStringIncludes(out.behaviorType, "@swamp/gcp/");
  }
});

Deno.test("file-share: BASIC tier uses the region's first real zone", () => {
  const out = gcpServiceKinds["file-share"]!.render(
    canonical("file-share", {
      protocol: "nfs",
      capacityGiB: 100,
      performance: "standard",
      encryption: "provider-managed",
      labels: {},
    }),
    "shared",
    { ...target, region: "us-east1" },
    ctx({ network: ["aws:network:v"] }),
  );
  assertEquals(out.globalArguments.location, "us-east1-b");
});

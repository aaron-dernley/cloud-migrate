// Run with `deno test -A`. No cloud is touched: fixtures are made-up records
// shaped like the `state` data @swamp/aws/* behaviors write.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  RenderContext,
  TargetSettings,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { awsServiceKinds } from "./aws_services.ts";

const TARGET: TargetSettings = { provider: "aws", region: "eu-west-2" };
const KMS_ARN =
  "arn:aws:kms:eu-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

/** A RenderContext whose dependencies are `deps` (kind → ids); refs render as `ref(<id>)`. */
function ctx(
  deps: Partial<Record<ResourceKind, string[]>> = {},
): RenderContext {
  return {
    refTo: (id, field) => `ref(${id}${field ? `.${field}` : ""})`,
    dependencies: (kind) => deps[kind] ?? [],
    targetNameOf: (id) => id,
  };
}

function adapter(kind: ResourceKind) {
  const a = awsServiceKinds[kind];
  assert(a, `no adapter for ${kind}`);
  return a;
}

/** A hand-built canonical resource, as another provider's adapter would produce. */
function foreign(
  kind: ResourceKind,
  properties: Record<string, unknown>,
  name = "orders",
): CanonicalResource {
  return {
    id: `gcp:${kind}:${name}`,
    provider: "gcp",
    kind,
    nativeId: name,
    aliases: [],
    name,
    region: "europe-west2",
    source: { behaviorType: "@swamp/gcp/x", behaviorName: "x" },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
  };
}

Deno.test("every requested kind is registered with its behavior type and idField", () => {
  const expected: Record<string, [string, string]> = {
    "sql-database": ["@swamp/aws/rds/dbinstance", "DBInstanceArn"],
    "container-registry": ["@swamp/aws/ecr/repository", "RepositoryName"],
    "message-topic": ["@swamp/aws/sns/topic", "TopicArn"],
    "message-queue": ["@swamp/aws/sqs/queue", "Arn"],
    function: ["@swamp/aws/lambda/function", "Arn"],
    cache: ["@swamp/aws/elasticache/replication-group", "ReplicationGroupId"],
    "file-share": ["@swamp/aws/efs/file-system", "FileSystemId"],
    "nosql-table": ["@swamp/aws/dynamodb/global-table", "TableName"],
    "kms-key": ["@swamp/aws/kms/key", "Arn"],
    secret: ["@swamp/aws/secretsmanager/secret", "Id"],
    "iam-principal": ["@swamp/aws/iam/role", "Arn"],
  };
  for (const [kind, [type, idField]] of Object.entries(expected)) {
    const a = adapter(kind as ResourceKind);
    assertEquals(a.behaviorType, type);
    assertEquals(a.idField, idField);
  }
});

// -- sql-database ----------------------------------------------------------

const RDS = {
  DBInstanceIdentifier: "orders-db",
  DBInstanceArn: "arn:aws:rds:eu-west-2:111122223333:db:orders-db",
  DbiResourceId: "db-EXAMPLE",
  Engine: "postgres",
  EngineVersion: "15.4",
  DBInstanceClass: "db.m6g.large",
  AllocatedStorage: "100",
  MultiAZ: true,
  BackupRetentionPeriod: 7,
  PubliclyAccessible: false,
  KmsKeyId: KMS_ARN,
  DBSubnetGroupName: "orders-subnets",
  VPCSecurityGroups: ["sg-0aaa"],
  MasterUsername: "admin",
  MasterUserPassword: "hunter2-secret",
  Tags: [{ Key: "Team", Value: "Data" }],
};

Deno.test("sql-database normalise", () => {
  const r = adapter("sql-database").normalise(RDS, "orders-db", null);
  assertEquals(r.id, "aws:sql-database:orders-db");
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.properties, {
    engine: "postgres",
    engineVersion: "15",
    instanceClass: "db.m6g.large",
    vcpus: 2,
    memoryMiB: 8192,
    storageGiB: 100,
    highAvailability: true,
    backupRetentionDays: 7,
    publicAccess: false,
    labels: { Team: "Data" },
  });
  assertEquals(r.refs.map((x) => `${x.kind}:${x.nativeId}`), [
    "firewall:sg-0aaa",
    `kms-key:${KMS_ARN}`,
  ]);
  assert(r.aliases.includes(RDS.DBInstanceArn));
  assertEquals(r.unknownFields, []);
  assert(
    !JSON.stringify(r).includes("hunter2"),
    "password must not reach the canonical record",
  );
});

Deno.test("sql-database normalise tracks missing fields", () => {
  const r = adapter("sql-database").normalise(
    { DBInstanceIdentifier: "x" },
    "x",
    null,
  );
  for (const f of ["engine", "storageGiB", "highAvailability", "region"]) {
    assert(r.unknownFields.includes(f), f);
  }
});

Deno.test("sql-database render from aws keeps class, wires refs, never renders the password", () => {
  const a = adapter("sql-database");
  const r = a.normalise(RDS, "orders-db", null);
  const out = a.render(
    r,
    "orders-new",
    TARGET,
    ctx({ "kms-key": ["k"], firewall: ["fw"] }),
  );
  const g = out.globalArguments;
  assertEquals(g.DBInstanceIdentifier, "orders-new");
  assertEquals(g.region, "eu-west-2");
  assertEquals(g.Engine, "postgres");
  assertEquals(g.EngineVersion, "15");
  assertEquals(g.DBInstanceClass, "db.m6g.large");
  assertEquals(g.AllocatedStorage, "100");
  assertEquals(g.KmsKeyId, "ref(k)");
  assertEquals(g.VPCSecurityGroups, ["ref(fw)"]);
  assertEquals(g.Tags, [{ Key: "Team", Value: "Data" }]);
  assert(!("MasterUserPassword" in g) && !("MasterUsername" in g));
  assert(out.decisions.some((d) => d.includes("vault.get")));
  assertEquals(out.expected.instanceClass, "db.m6g.large");
});

Deno.test("sql-database render from gcp picks the smallest fitting class and records a loss", () => {
  const out = adapter("sql-database").render(
    foreign("sql-database", {
      engine: "mysql",
      engineVersion: "8.0",
      vcpus: 2,
      memoryMiB: 7500,
      storageGiB: 10,
      highAvailability: false,
      backupRetentionDays: 365,
      publicAccess: true,
      labels: {},
    }),
    "orders",
    TARGET,
    ctx(),
  );
  assertEquals(out.globalArguments.Engine, "mysql");
  assertEquals(out.globalArguments.EngineVersion, "8.0");
  assertEquals(out.globalArguments.DBInstanceClass, "db.t4g.large");
  assertEquals(out.globalArguments.AllocatedStorage, "20");
  assertEquals(out.globalArguments.BackupRetentionPeriod, 35);
  assert(out.losses.some((l) => l.includes("db.t4g.large")));
  assert(out.losses.some((l) => l.includes("backup retention")));
  assert(out.decisions.some((d) => d.includes("internet")));
});

Deno.test("sql-database render: unsupported version, sqlserver edition and x86 class are decisions", () => {
  const a = adapter("sql-database");
  const old = a.render(
    foreign("sql-database", {
      engine: "postgres",
      engineVersion: "9",
      vcpus: 1,
      memoryMiB: 1000,
      storageGiB: 50,
    }),
    "orders",
    TARGET,
    ctx(),
  );
  assert(old.decisions.some((d) => d.includes("postgres 9")));
  assert(!("EngineVersion" in old.globalArguments));
  const ms = a.render(
    foreign("sql-database", {
      engine: "sqlserver",
      engineVersion: "15",
      vcpus: 2,
      memoryMiB: 4096,
      storageGiB: 50,
    }),
    "orders",
    TARGET,
    ctx(),
  );
  assertEquals(ms.globalArguments.Engine, "sqlserver-se");
  assert(String(ms.globalArguments.DBInstanceClass).startsWith("db.m6i"));
  assert(ms.decisions.some((d) => d.includes("edition")));
});

Deno.test("sql-database validateName", () => {
  const v = adapter("sql-database").validateName;
  assertEquals(v("orders-db"), []);
  assert(v("1orders").length > 0);
  assert(v("a--b").length > 0);
  assert(v("under_score").length > 0);
});

// -- container-registry ----------------------------------------------------

const ECR = {
  RepositoryName: "team/app",
  Arn: "arn:aws:ecr:eu-west-2:111122223333:repository/team/app",
  RepositoryUri: "111122223333.dkr.ecr.eu-west-2.amazonaws.com/team/app",
  ImageTagMutability: "IMMUTABLE",
  ImageScanningConfiguration: { ScanOnPush: true },
  EncryptionConfiguration: { EncryptionType: "KMS", KmsKey: KMS_ARN },
  Tags: [{ Key: "Team", Value: "Web" }],
};

Deno.test("container-registry normalise and render", () => {
  const a = adapter("container-registry");
  const r = a.normalise(ECR, "app", null);
  assertEquals(r.properties, {
    name: "team/app",
    immutableTags: true,
    scanOnPush: true,
    immutableExclusions: false,
    labels: { Team: "Web" },
  });
  assertEquals(r.refs[0].kind, "kms-key");
  const out = a.render(r, "app-new", TARGET, ctx({ "kms-key": ["k"] }));
  assertEquals(out.globalArguments.ImageTagMutability, "IMMUTABLE");
  assertEquals(out.globalArguments.EncryptionConfiguration, {
    EncryptionType: "KMS",
    KmsKey: "ref(k)",
  });
  assertEquals(out.globalArguments.RepositoryName, "app-new");
  const gcp = a.render(
    foreign("container-registry", {
      immutableTags: false,
      scanOnPush: null,
      labels: {},
    }),
    "app",
    TARGET,
    ctx(),
  );
  assertEquals(gcp.globalArguments.EncryptionConfiguration, {
    EncryptionType: "AES256",
  });
  assert(gcp.losses.length > 0);
});

Deno.test("container-registry validateName", () => {
  const v = adapter("container-registry").validateName;
  assertEquals(v("team/app-1"), []);
  assert(v("Team/App").length > 0);
  assert(v("a").length > 0);
  assert(v("a//b").length > 0);
});

// -- message-topic ---------------------------------------------------------

Deno.test("message-topic normalise and render (fifo suffix loss)", () => {
  const a = adapter("message-topic");
  const arn = "arn:aws:sns:eu-west-2:111122223333:alerts";
  const r = a.normalise(
    {
      TopicArn: arn,
      TopicName: "alerts",
      KmsMasterKeyId: "alias/aws/sns",
      Tags: [{ Key: "A", Value: "b" }],
    },
    "alerts",
    null,
  );
  assertEquals(r.nativeId, arn);
  assertEquals(r.properties, {
    name: "alerts",
    ordered: false,
    labels: { A: "b" },
  });
  assertEquals(r.refs, [], "AWS-managed key alias is not a dependency");
  const keyed = a.normalise(
    { TopicArn: arn, KmsMasterKeyId: KMS_ARN, FifoTopic: true },
    "alerts",
    null,
  );
  assertEquals(keyed.refs.length, 1);
  const out = a.render(
    foreign(
      "message-topic",
      { name: "alerts", ordered: true, labels: {} },
      "alerts",
    ),
    "alerts",
    TARGET,
    ctx({ "kms-key": ["k"] }),
  );
  assertEquals(out.globalArguments.TopicName, "alerts.fifo");
  assertEquals(out.globalArguments.name, "alerts");
  assertEquals(out.globalArguments.FifoTopic, true);
  assertEquals(out.globalArguments.KmsMasterKeyId, "ref(k)");
  assert(out.losses.some((l) => l.includes(".fifo")));
  assertEquals(out.expected.name, "alerts.fifo");
});

// -- message-queue ---------------------------------------------------------

const SQS = {
  QueueUrl: "https://sqs.eu-west-2.amazonaws.com/111122223333/jobs.fifo",
  Arn: "arn:aws:sqs:eu-west-2:111122223333:jobs.fifo",
  QueueName: "jobs.fifo",
  FifoQueue: true,
  VisibilityTimeout: 45,
  MessageRetentionPeriod: 345600,
  RedrivePolicy: {
    deadLetterTargetArn: "arn:aws:sqs:eu-west-2:111122223333:dlq",
    maxReceiveCount: 5,
  },
  KmsMasterKeyId: KMS_ARN,
};

Deno.test("message-queue normalise and render", () => {
  const a = adapter("message-queue");
  const r = a.normalise(SQS, "jobs", null);
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.properties, {
    name: "jobs.fifo",
    ordered: true,
    visibilityTimeoutSeconds: 45,
    retentionSeconds: 345600,
    deadLetter: true,
    labels: {},
  });
  const out = a.render(r, "jobs", TARGET, ctx({ "kms-key": ["k"] }));
  assertEquals(out.globalArguments.QueueName, "jobs.fifo");
  assertEquals(out.globalArguments.FifoQueue, true);
  assertEquals(out.globalArguments.KmsMasterKeyId, "ref(k)");
  assert(!("SqsManagedSseEnabled" in out.globalArguments));
  assert(out.decisions.some((d) => d.includes("dead-letter")));
  const gcp = a.render(
    foreign("message-queue", {
      name: "q",
      ordered: false,
      visibilityTimeoutSeconds: 600,
      retentionSeconds: 7 * 86400 * 3,
      deadLetter: false,
      labels: {},
    }, "q"),
    "q",
    TARGET,
    ctx(),
  );
  assertEquals(gcp.globalArguments.MessageRetentionPeriod, 1209600);
  assertEquals(gcp.globalArguments.SqsManagedSseEnabled, true);
  assert(gcp.losses.some((l) => l.includes("message retention")));
});

Deno.test("message-queue validateName", () => {
  const v = adapter("message-queue").validateName;
  assertEquals(v("jobs"), []);
  assertEquals(v("jobs.fifo"), []);
  assert(v("jobs.queue").length > 0);
  assert(v("a".repeat(81)).length > 0);
});

// -- function --------------------------------------------------------------

const LAMBDA = {
  FunctionName: "resize",
  Arn: "arn:aws:lambda:eu-west-2:111122223333:function:resize",
  Runtime: "python3.12",
  Handler: "app.handler",
  MemorySize: 256,
  Timeout: 30,
  Role: "arn:aws:iam::111122223333:role/resize-role",
  VpcConfig: { SubnetIds: ["subnet-0aaa"], SecurityGroupIds: ["sg-0bbb"] },
  Environment: { Variables: { API_KEY: "super-secret-value" } },
  Tags: [{ Key: "Team", Value: "Media" }],
};

Deno.test("function normalise never reads environment variables", () => {
  const r = adapter("function").normalise(LAMBDA, "resize", null);
  assertEquals(r.properties, {
    runtime: "python3.12",
    memoryMiB: 256,
    timeoutSeconds: 30,
    entryPoint: "app.handler",
    labels: { Team: "Media" },
  });
  assertEquals(r.refs.map((x) => x.kind), [
    "iam-principal",
    "subnet",
    "firewall",
  ]);
  assert(!JSON.stringify(r).includes("super-secret"));
});

Deno.test("function render wires role and subnets; unsupported runtime is a decision", () => {
  const a = adapter("function");
  const r = a.normalise(LAMBDA, "resize", null);
  const out = a.render(
    r,
    "resize2",
    TARGET,
    ctx({ "iam-principal": ["role"], subnet: ["s1"], firewall: ["fw"] }),
  );
  assertEquals(out.globalArguments.Role, "ref(role)");
  assertEquals(out.globalArguments.VpcConfig, {
    SubnetIds: ["ref(s1)"],
    SecurityGroupIds: ["ref(fw)"],
  });
  assertEquals(out.globalArguments.Runtime, "python3.12");
  assert(!JSON.stringify(out.globalArguments).includes("Environment"));
  assertEquals(out.expected.runtime, "python3.12");

  const node = a.render(
    foreign("function", {
      runtime: "nodejs20",
      memoryMiB: 64,
      timeoutSeconds: 3600,
      entryPoint: "index.handler",
      labels: {},
    }, "f"),
    "f",
    TARGET,
    ctx(),
  );
  assertEquals(node.globalArguments.Runtime, "nodejs20.x");
  assertEquals(node.globalArguments.MemorySize, 128);
  assertEquals(node.globalArguments.Timeout, 900);
  assert(node.losses.some((l) => l.includes("memory")));
  assert(node.decisions.some((d) => d.includes("execution role")));

  const go = a.render(
    foreign("function", {
      runtime: "go1.21",
      memoryMiB: 128,
      timeoutSeconds: 10,
      entryPoint: null,
      labels: {},
    }, "f"),
    "f",
    TARGET,
    ctx(),
  );
  assert(!("Runtime" in go.globalArguments));
  assert(go.decisions.some((d) => d.includes("go1.21")));
});

Deno.test("function validateName", () => {
  const v = adapter("function").validateName;
  assertEquals(v("my_func-1"), []);
  assert(v("my.func").length > 0);
  assert(v("a".repeat(65)).length > 0);
});

// -- cache -----------------------------------------------------------------

const CACHE = {
  ReplicationGroupId: "sessions",
  Engine: "valkey",
  EngineVersion: "7.2",
  CacheNodeType: "cache.r6g.large",
  NumCacheClusters: 2,
  SecurityGroupIds: ["sg-0ccc"],
  AuthToken: "do-not-copy-this-token",
  Tags: [{ Key: "Team", Value: "Web" }],
};

Deno.test("cache normalise and render", () => {
  const a = adapter("cache");
  const r = a.normalise(CACHE, "sessions", "eu-west-2");
  assertEquals(r.properties, {
    engine: "valkey",
    engineVersion: "7.2",
    memoryGiB: 13.07,
    nodes: 2,
    shards: 1,
    replicasPerShard: 1,
    nodeType: "cache.r6g.large",
    labels: { Team: "Web" },
  });
  assertEquals(r.refs[0], {
    kind: "firewall",
    nativeId: "sg-0ccc",
    via: "SecurityGroupIds",
  });
  assert(!JSON.stringify(r).includes("do-not-copy"));
  const out = a.render(r, "sessions2", TARGET, ctx({ firewall: ["fw"] }));
  assertEquals(out.globalArguments.Engine, "valkey");
  assertEquals(out.globalArguments.CacheNodeType, "cache.r6g.large");
  assertEquals(out.globalArguments.NumCacheClusters, 2);
  assertEquals(out.globalArguments.AutomaticFailoverEnabled, true);
  assertEquals(out.globalArguments.SecurityGroupIds, ["ref(fw)"]);
  assert(!("AuthToken" in out.globalArguments));
  const gcp = a.render(
    foreign(
      "cache",
      {
        engine: "redis",
        engineVersion: "7.0",
        memoryGiB: 5,
        nodes: 1,
        labels: {},
      },
      "c",
    ),
    "c",
    TARGET,
    ctx(),
  );
  assertEquals(gcp.globalArguments.CacheNodeType, "cache.m6g.large");
  assert(gcp.losses.some((l) => l.includes("cache.m6g.large")));
  assert(gcp.decisions.some((d) => d.includes("engine version 7.0")));
});

Deno.test("cache render: memcached is a decision", () => {
  const out = adapter("cache").render(
    foreign("cache", {
      engine: "memcached",
      memoryGiB: 1,
      nodes: 2,
      labels: {},
    }, "m"),
    "m",
    TARGET,
    ctx(),
  );
  assert(!("Engine" in out.globalArguments));
  assert(out.decisions.some((d) => d.includes("memcached")));
});

// -- file-share ------------------------------------------------------------

const EFS = {
  FileSystemId: "fs-0abc",
  Arn: "arn:aws:elasticfilesystem:eu-west-2:111122223333:file-system/fs-0abc",
  Encrypted: true,
  KmsKeyId: KMS_ARN,
  PerformanceMode: "generalPurpose",
  ThroughputMode: "elastic",
  FileSystemTags: [{ Key: "Name", Value: "shared" }, {
    Key: "Team",
    Value: "Web",
  }],
};

Deno.test("file-share normalise and render", () => {
  const a = adapter("file-share");
  const r = a.normalise(EFS, "shared", null);
  assertEquals(r.name, "shared");
  assertEquals(r.properties, {
    protocol: "nfs",
    capacityGiB: null,
    performance: "standard",
    encryption: "customer-key",
    labels: { Team: "Web" },
  });
  assertEquals(r.refs[0].kind, "kms-key");
  const out = a.render(r, "shared2", TARGET, ctx({ "kms-key": ["k"] }));
  assertEquals(out.globalArguments.name, "shared2");
  assertEquals(out.globalArguments.KmsKeyId, "ref(k)");
  assertEquals(out.globalArguments.FileSystemTags, [{
    Key: "Name",
    Value: "shared2",
  }, {
    Key: "Team",
    Value: "Web",
  }]);
  assertEquals(out.expected.encryption, "customer-key");
  const noKey = a.render(
    foreign("file-share", {
      protocol: "nfs",
      capacityGiB: 1024,
      performance: "high",
      encryption: "customer-key",
      labels: {},
    }, "f"),
    "f",
    TARGET,
    ctx(),
  );
  assert(noKey.decisions.some((d) => d.includes("AWS-managed")));
  assertEquals(noKey.globalArguments.PerformanceMode, "maxIO");
  const smb = a.render(
    foreign(
      "file-share",
      { protocol: "smb", encryption: "none", labels: {} },
      "f",
    ),
    "f",
    TARGET,
    ctx(),
  );
  assert(smb.decisions.some((d) => d.includes("SMB")));
  assert(smb.losses.some((l) => l.includes("encrypted")));
});

// -- nosql-table -----------------------------------------------------------

const DDB = {
  TableName: "orders",
  Arn: "arn:aws:dynamodb:eu-west-2:111122223333:table/orders",
  KeySchema: [{ AttributeName: "sk", KeyType: "RANGE" }, {
    AttributeName: "pk",
    KeyType: "HASH",
  }],
  BillingMode: "PAY_PER_REQUEST",
  Replicas: [{
    Region: "eu-west-2",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    SSESpecification: { KMSMasterKeyId: KMS_ARN },
    Tags: [{ Key: "Team", Value: "Data" }],
  }],
};

Deno.test("nosql-table normalise and render", () => {
  const a = adapter("nosql-table");
  const r = a.normalise(DDB, "orders", null);
  assertEquals(r.properties, {
    name: "orders",
    keys: ["pk", "sk"],
    billing: "on-demand",
    pointInTimeRecovery: true,
    labels: { Team: "Data" },
  });
  assertEquals(r.refs[0].kind, "kms-key");
  const out = a.render(r, "orders2", TARGET, ctx({ "kms-key": ["k"] }));
  const g = out.globalArguments;
  assertEquals(g.TableName, "orders2");
  assertEquals(g.KeySchema, [{ AttributeName: "pk", KeyType: "HASH" }, {
    AttributeName: "sk",
    KeyType: "RANGE",
  }]);
  assertEquals(g.Replicas, [{
    Region: "eu-west-2",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    SSESpecification: { KMSMasterKeyId: "ref(k)" },
    Tags: [{ Key: "Team", Value: "Data" }],
  }]);
  assert(out.decisions.some((d) => d.includes("assumed to be string")));
  const prov = a.render(
    foreign("nosql-table", {
      name: "t",
      keys: [],
      billing: "provisioned",
      pointInTimeRecovery: null,
      labels: {},
    }, "t"),
    "tbl",
    TARGET,
    ctx(),
  );
  assert(prov.decisions.some((d) => d.includes("provisioned")));
  assert(prov.decisions.some((d) => d.includes("key schema unknown")));
});

Deno.test("nosql-table validateName", () => {
  const v = adapter("nosql-table").validateName;
  assertEquals(v("orders_v2.1"), []);
  assert(v("ab").length > 0);
  assert(v("has space").length > 0);
});

// -- kms-key ---------------------------------------------------------------

Deno.test("kms-key normalise and render", () => {
  const a = adapter("kms-key");
  const r = a.normalise(
    {
      KeyId: "1111-2222",
      Arn: KMS_ARN,
      KeyUsage: "ENCRYPT_DECRYPT",
      EnableKeyRotation: true,
      Tags: [{ Key: "Name", Value: "data" }],
    },
    "data",
    null,
  );
  assertEquals(r.name, "data");
  assertEquals(r.nativeId, "1111-2222");
  assertEquals(r.properties, {
    purpose: "encrypt",
    rotation: true,
    labels: { Name: "data" },
  });
  const out = a.render(r, "data2", TARGET, ctx());
  assertEquals(out.globalArguments.KeyUsage, "ENCRYPT_DECRYPT");
  assertEquals(out.globalArguments.EnableKeyRotation, true);
  assertEquals(out.expected, {
    purpose: "encrypt",
    rotation: true,
    labels: { Name: "data" },
  });
  const sign = a.render(
    foreign("kms-key", { purpose: "sign", rotation: true, labels: {} }, "k"),
    "k",
    TARGET,
    ctx(),
  );
  assertEquals(sign.globalArguments.KeyUsage, "SIGN_VERIFY");
  assert(!("EnableKeyRotation" in sign.globalArguments));
  assert(sign.decisions.some((d) => d.includes("RSA_2048")));
  assert(sign.losses.some((l) => l.includes("rotation")));
});

Deno.test("kms-key validateName", () => {
  const v = adapter("kms-key").validateName;
  assertEquals(v("app/data-key"), []);
  assert(v("aws/s3").length > 0);
  assert(v("has space").length > 0);
});

// -- secret ----------------------------------------------------------------

const SECRET = {
  Id: "arn:aws:secretsmanager:eu-west-2:111122223333:secret:db-pass-AbCdEf",
  Name: "db-pass",
  KmsKeyId: KMS_ARN,
  SecretString: "the-real-secret-value",
  GenerateSecretString: { PasswordLength: 32 },
  Tags: [{ Key: "Team", Value: "Data" }],
};

Deno.test("secret normalise and render never touch values", () => {
  const a = adapter("secret");
  const r = a.normalise(SECRET, "db-pass", null);
  assertEquals(r.properties, {
    name: "db-pass",
    rotation: null,
    labels: { Team: "Data" },
  });
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.refs[0].kind, "kms-key");
  assert(!JSON.stringify(r).includes("the-real-secret"));
  const out = a.render(r, "db-pass2", TARGET, ctx({ "kms-key": ["k"] }));
  assertEquals(out.globalArguments.Name, "db-pass2");
  assertEquals(out.globalArguments.KmsKeyId, "ref(k)");
  assert(
    !("SecretString" in out.globalArguments) &&
      !("GenerateSecretString" in out.globalArguments),
  );
  assert(out.losses.some((l) => l.includes("empty")));
  const rot = a.render(
    foreign("secret", { name: "s", rotation: true, labels: {} }, "s"),
    "s",
    TARGET,
    ctx(),
  );
  assert(rot.losses.some((l) => l.includes("rotation")));
});

// -- iam-principal ---------------------------------------------------------

Deno.test("iam-principal normalise and render", () => {
  const a = adapter("iam-principal");
  const arn = "arn:aws:iam::111122223333:role/resize-role";
  const r = a.normalise(
    {
      RoleName: "resize-role",
      Arn: arn,
      RoleId: "AROAEXAMPLE",
      Description: "Resizer",
    },
    "resize-role",
    "eu-west-2",
  );
  assertEquals(r.properties, {
    name: "resize-role",
    principalType: "role",
    description: "Resizer",
  });
  assert(r.aliases.includes(arn));
  const out = a.render(
    foreign(
      "iam-principal",
      { name: "sa", principalType: "service-account", description: null },
      "sa",
    ),
    "sa-role",
    TARGET,
    ctx(),
  );
  assertEquals(out.globalArguments, {
    RoleName: "sa-role",
    region: "eu-west-2",
  });
  assert(out.decisions.some((d) => d.includes("trust policy")));
});

Deno.test("iam-principal validateName", () => {
  const v = adapter("iam-principal").validateName;
  assertEquals(v("my_role+x=1,.@-"), []);
  assert(v("has space").length > 0);
  assert(v("a".repeat(65)).length > 0);
});

// -- cross-cutting ---------------------------------------------------------

Deno.test("no rendered globalArguments contain a secret or password value", () => {
  const cases: [ResourceKind, Record<string, unknown>][] = [
    ["sql-database", RDS],
    ["function", LAMBDA],
    ["cache", CACHE],
    ["secret", SECRET],
    ["container-registry", ECR],
    ["message-queue", SQS],
    ["file-share", EFS],
    ["nosql-table", DDB],
  ];
  const forbidden = [
    "hunter2",
    "super-secret",
    "do-not-copy",
    "the-real-secret",
  ];
  for (const [kind, record] of cases) {
    const a = adapter(kind);
    const out = a.render(
      a.normalise(record, "x", "eu-west-2"),
      "x-new",
      TARGET,
      ctx(),
    );
    const text = JSON.stringify(out);
    for (const f of forbidden) assert(!text.includes(f), `${kind} leaked ${f}`);
    for (
      const key of [
        "MasterUserPassword",
        "SecretString",
        "AuthToken",
        "Environment",
        "GenerateSecretString",
      ]
    ) {
      assert(!(key in out.globalArguments), `${kind} rendered ${key}`);
    }
  }
});

Deno.test("every render sets region to the target region and returns the adapter's behavior type", () => {
  const sample: Partial<Record<ResourceKind, Record<string, unknown>>> = {
    "sql-database": {
      engine: "postgres",
      engineVersion: "16",
      vcpus: 2,
      memoryMiB: 4096,
      storageGiB: 20,
      labels: {},
    },
    "container-registry": { immutableTags: false, labels: {} },
    "message-topic": { ordered: false, labels: {} },
    "message-queue": { ordered: false, labels: {} },
    function: { runtime: "python3.12", labels: {} },
    cache: { engine: "redis", memoryGiB: 1, nodes: 1, labels: {} },
    "file-share": {
      protocol: "nfs",
      performance: "standard",
      encryption: "provider-managed",
      labels: {},
    },
    "nosql-table": { keys: ["id"], billing: "on-demand", labels: {} },
    "kms-key": { purpose: "encrypt", rotation: false, labels: {} },
    secret: { rotation: null, labels: {} },
    "iam-principal": { description: null },
  };
  for (const [kind, props] of Object.entries(sample)) {
    const a = adapter(kind as ResourceKind);
    const out = a.render(
      foreign(kind as ResourceKind, props!),
      "thing",
      TARGET,
      ctx(),
    );
    assertEquals(out.behaviorType, a.behaviorType);
    assertEquals(out.globalArguments.region, "eu-west-2");
  }
});

Deno.test("cache: shards and replicas are kept apart and rendered as cluster mode", () => {
  const a = adapter("cache");
  const r = a.normalise(
    {
      ReplicationGroupId: "big",
      Engine: "redis",
      EngineVersion: "7.1",
      CacheNodeType: "cache.r6g.large",
      NumNodeGroups: 3,
      ReplicasPerNodeGroup: 2,
    },
    "big",
    "eu-west-2",
  );
  assertEquals(r.properties.nodes, 9);
  assertEquals(r.properties.shards, 3);
  assertEquals(r.properties.replicasPerShard, 2);
  const out = a.render(r, "big", TARGET, ctx());
  assertEquals(out.globalArguments.NumNodeGroups, 3);
  assertEquals(out.globalArguments.ReplicasPerNodeGroup, 2);
  assertEquals("NumCacheClusters" in out.globalArguments, false);
  assertEquals(out.globalArguments.AutomaticFailoverEnabled, true);
  assertEquals(out.expected.nodes, 9);
});

Deno.test("cache: a single shard clamps NumCacheClusters to 1-6 with a loss", () => {
  const a = adapter("cache");
  const out = a.render(
    foreign("cache", { engine: "redis", memoryGiB: 2, nodes: 20, labels: {} }),
    "c",
    TARGET,
    ctx(),
  );
  assertEquals(out.globalArguments.NumCacheClusters, 6);
  assertEquals("NumNodeGroups" in out.globalArguments, false);
  assert(out.losses.some((l) => l.includes("node count 20")));
});

Deno.test("cache: aws to aws keeps a node type the table lacks; missing Engine is unknown", () => {
  const a = adapter("cache");
  const r = a.normalise(
    {
      ReplicationGroupId: "c",
      CacheNodeType: "cache.r7g.large",
      NumCacheClusters: 2,
    },
    "c",
    "eu-west-2",
  );
  assert(r.unknownFields.includes("engine"));
  assertEquals(r.properties.engine, null);
  const out = a.render(r, "c", TARGET, ctx());
  assertEquals(out.globalArguments.CacheNodeType, "cache.r7g.large");
  assert(out.decisions.some((d) => d.includes("engine unknown")));
  assert(!out.decisions.some((d) => d.includes("placeholder")));
});

Deno.test("message-queue: a string RedrivePolicy counts as a dead-letter queue", () => {
  const a = adapter("message-queue");
  const r = a.normalise(
    {
      QueueUrl: "https://sqs.eu-west-2.amazonaws.com/111122223333/q",
      QueueName: "q",
      RedrivePolicy:
        '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-2:111122223333:dlq","maxReceiveCount":5}',
    },
    "q",
    null,
  );
  assertEquals(r.properties.deadLetter, true);
});

Deno.test("tags: the reserved aws: prefix is dropped with a loss on every tagged kind", () => {
  const labels = { "aws:cloudformation:stack-id": "x", Team: "web" };
  const props: Partial<Record<ResourceKind, Record<string, unknown>>> = {
    "message-topic": { name: "t", ordered: false },
    "message-queue": { name: "q", ordered: false },
    "container-registry": { name: "r" },
    "file-share": { protocol: "nfs", encryption: "provider-managed" },
    "nosql-table": { name: "n", keys: ["id"] },
    "kms-key": { purpose: "encrypt", rotation: false },
    secret: { name: "s" },
  };
  for (const [kind, p] of Object.entries(props)) {
    const out = adapter(kind as ResourceKind).render(
      foreign(kind as ResourceKind, { ...p, labels }, "x"),
      "x",
      TARGET,
      ctx(),
    );
    const json = JSON.stringify(out.globalArguments);
    assert(!json.includes("aws:"), `${kind} still renders an aws: tag`);
    assert(json.includes("Team"), `${kind} lost its other tag`);
    assert(out.losses.some((l) => l.includes("aws:")), `${kind} no loss`);
    assertEquals(
      (out.expected.labels as Record<string, string>)[
        "aws:cloudformation:stack-id"
      ],
      undefined,
    );
  }
});

Deno.test("container-registry: IMMUTABLE_WITH_EXCLUSION becomes IMMUTABLE with a loss", () => {
  const a = adapter("container-registry");
  const r = a.normalise(
    {
      RepositoryName: "app",
      ImageTagMutability: "IMMUTABLE_WITH_EXCLUSION",
    },
    "app",
    "eu-west-2",
  );
  const out = a.render(r, "app", TARGET, ctx());
  assertEquals(out.globalArguments.ImageTagMutability, "IMMUTABLE");
  assert(out.losses.some((l) => l.includes("IMMUTABLE_WITH_EXCLUSION")));
});

Deno.test("an AWS-managed key alias is not a kms-key dependency, an ARN-form alias too", () => {
  const a = adapter("file-share");
  const r = a.normalise(
    {
      FileSystemId: "fs-1",
      Encrypted: true,
      KmsKeyId:
        "arn:aws:kms:eu-west-2:111122223333:alias/aws/elasticfilesystem",
    },
    "fs",
    "eu-west-2",
  );
  assertEquals(r.refs, []);
  assertEquals(r.properties.encryption, "provider-managed");
});

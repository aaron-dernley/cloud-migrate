// Run with `deno test -A`. No cloud is touched: fixtures are shaped like the
// state @swamp/digitalocean/* behaviors write (the raw DigitalOcean API
// object). Names and ids are made up.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  KindAdapter,
  RenderContext,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { digitalocean } from "./digitalocean.ts";

const VPC_ID = "11111111-aaaa-bbbb-cccc-000000000001";
const VOL_ID = "22222222-aaaa-bbbb-cccc-000000000002";

function adapter(kind: ResourceKind): KindAdapter {
  const a = digitalocean.kinds[kind];
  assert(a, `no ${kind} adapter`);
  return a;
}

/** A canonical resource as another provider (AWS) would normalise it. */
function foreign(
  kind: ResourceKind,
  name: string,
  properties: Record<string, unknown>,
  overrides: Partial<CanonicalResource> = {},
): CanonicalResource {
  return {
    id: `aws:${kind}:${name}`,
    provider: "aws",
    kind,
    nativeId: name,
    aliases: [],
    name,
    region: "eu-west-2",
    source: { behaviorType: "@swamp/aws/example", behaviorName: "x" },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
    ...overrides,
  };
}

/** A render context where each dependency id maps to `<id>-target` and refs print as CEL-ish text. */
function context(
  deps: Partial<Record<ResourceKind, string[]>> = {},
): RenderContext {
  return {
    refTo: (id, field) => `\${{ ref(${id}, ${field ?? "default"}) }}`,
    dependencies: (kind) => deps[kind] ?? [],
    targetNameOf: (id) => id.split(":").pop() ?? null,
  };
}

const TARGET = { provider: "digitalocean", region: "ams3" };

/** No rendered argument may be a secret field, and no string may look like a credential. */
function assertNoSecrets(globalArguments: Record<string, unknown>) {
  const text = JSON.stringify(globalArguments);
  for (
    const key of [
      "password",
      "token",
      "uri",
      "connection",
      "private_key",
      "access_key",
    ]
  ) {
    assert(
      !text.toLowerCase().includes(`"${key}"`),
      `rendered a "${key}" field`,
    );
  }
}

Deno.test("provider: id, name and the kinds it covers", () => {
  assertEquals(digitalocean.id, "digitalocean");
  assertEquals(digitalocean.displayName, "DigitalOcean");
  assertEquals(Object.keys(digitalocean.kinds).sort(), [
    "block-volume",
    "cache",
    "container-registry",
    "dns-record",
    "dns-zone",
    "file-share",
    "firewall",
    "kubernetes-cluster",
    "load-balancer",
    "network",
    "sql-database",
    "vm",
  ]);
});

// ---------------------------------------------------------------------------

Deno.test("network: normalise a VPC", () => {
  const r = adapter("network").normalise(
    {
      id: VPC_ID,
      name: "default-ams3",
      region: "ams3",
      ip_range: "10.110.0.0/20",
      urn: "do:vpc:x",
    },
    "do-vpc",
    null,
  );
  assertEquals(r.id, `digitalocean:network:${VPC_ID}`);
  assertEquals(r.region, "ams3");
  assertEquals(r.properties, { cidr: "10.110.0.0/20", labels: {} });
  assertEquals(r.aliases, ["do:vpc:x", "default-ams3"]);
  assertEquals(r.unknownFields, []);
});

Deno.test("network: render keeps an RFC1918 /16-/28 range, decides on others", () => {
  const ok = adapter("network").render(
    foreign("network", "main", {
      cidr: "10.0.0.0/16",
      labels: { env: "prod" },
    }),
    "main",
    TARGET,
    context(),
  );
  assertEquals(ok.globalArguments, {
    name: "main",
    region: "ams3",
    ip_range: "10.0.0.0/16",
  });
  assertEquals(ok.expected, { cidr: "10.0.0.0/16", labels: {} });
  assertEquals(ok.decisions, []);
  assertEquals(ok.losses.length, 1); // labels dropped

  const bad = adapter("network").render(
    foreign("network", "wide", { cidr: "10.0.0.0/8", labels: {} }),
    "wide",
    TARGET,
    context(),
  );
  assertEquals(bad.decisions.length, 1);
  assertEquals(bad.globalArguments.ip_range, undefined);
});

// ---------------------------------------------------------------------------

Deno.test("firewall: normalise rules, attachments and non-address sources", () => {
  const r = adapter("firewall").normalise(
    {
      id: "33333333-aaaa-bbbb-cccc-000000000003",
      name: "web",
      droplet_ids: [1001],
      tags: ["web"],
      inbound_rules: [
        {
          protocol: "tcp",
          ports: "22",
          sources: { addresses: ["203.0.113.7", "10.0.0.0/8"] },
        },
        {
          protocol: "tcp",
          ports: "80",
          sources: { load_balancer_uids: ["lb-1"] },
        },
        { protocol: "icmp", ports: "", sources: { addresses: ["0.0.0.0/0"] } },
      ],
      outbound_rules: [
        {
          protocol: "tcp",
          ports: "1-65535",
          destinations: { addresses: ["0.0.0.0/0", "::/0"] },
        },
      ],
    },
    "do-fw",
    null,
  );
  assertEquals(r.properties.rules, [
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "22",
      cidrs: ["203.0.113.7/32", "10.0.0.0/8"],
    },
    {
      direction: "ingress",
      protocol: "icmp",
      ports: null,
      cidrs: ["0.0.0.0/0"],
    },
    {
      direction: "egress",
      protocol: "tcp",
      ports: null,
      cidrs: ["0.0.0.0/0", "::/0"],
    },
  ]);
  assertEquals(r.properties.attachedDropletIds, [1001]);
  assertEquals(r.properties.attachedTags, ["web"]);
  assertEquals((r.properties.unrepresented as string[]).length, 1);
  assertEquals(r.refs, []); // attachments are not dependencies
});

Deno.test("firewall: render expands protocol all, notes attachment and missing egress", () => {
  const out = adapter("firewall").render(
    foreign("firewall", "sg", {
      description: "x",
      labels: {},
      rules: [
        {
          direction: "ingress",
          protocol: "tcp",
          ports: "443",
          cidrs: ["0.0.0.0/0"],
        },
        {
          direction: "ingress",
          protocol: "all",
          ports: null,
          cidrs: ["10.0.0.0/8"],
        },
        {
          direction: "ingress",
          protocol: "gre",
          ports: null,
          cidrs: ["10.0.0.0/8"],
        },
      ],
    }),
    "sg",
    TARGET,
    context(),
  );
  const inbound = out.globalArguments.inbound_rules as Record<
    string,
    unknown
  >[];
  assertEquals(inbound.length, 4); // 443 + tcp/udp/icmp
  assertEquals(inbound[1], {
    protocol: "tcp",
    ports: "1-65535",
    sources: { addresses: ["10.0.0.0/8"] },
  });
  assertEquals(inbound[3], {
    protocol: "icmp",
    ports: "",
    sources: { addresses: ["10.0.0.0/8"] },
  });
  assertEquals(out.globalArguments.outbound_rules, undefined);
  assert(out.losses.some((l) => l.includes("no egress")));
  assert(out.losses.some((l) => l.includes("droplet_ids or tag")));
  assert(out.decisions.some((d) => d.includes("gre")));
  assertEquals((out.expected.rules as unknown[]).length, 4);
});

// ---------------------------------------------------------------------------

const DROPLET = {
  id: 4242,
  name: "web-1",
  memory: 2048,
  vcpus: 2,
  disk: 60,
  size_slug: "s-2vcpu-2gb",
  image: { id: 99, slug: "ubuntu-24-04-x64", name: "24.04 (LTS) x64" },
  region: { slug: "ams3", name: "Amsterdam 3" },
  tags: ["env:prod", "web"],
  vpc_uuid: VPC_ID,
  volume_ids: [VOL_ID],
  networks: {
    v4: [
      { ip_address: "10.110.0.2", type: "private" },
      { ip_address: "198.51.100.4", type: "public" },
    ],
  },
};

Deno.test("vm: normalise a droplet with refs to its VPC and volumes", () => {
  const r = adapter("vm").normalise(DROPLET, "do-droplet", null);
  assertEquals(r.nativeId, "4242");
  assertEquals(r.region, "ams3");
  assertEquals(r.properties, {
    machineType: "s-2vcpu-2gb",
    vcpus: 2,
    memoryMiB: 2048,
    architecture: "x86_64",
    image: "ubuntu-24-04-x64",
    publicIp: true,
    bootDiskGiB: 60,
    labels: { env: "prod", web: "" },
  });
  assertEquals(r.refs, [
    { kind: "network", nativeId: VPC_ID, via: "vpc_uuid" },
    { kind: "block-volume", nativeId: VOL_ID, via: "volume_ids" },
  ]);
  assertEquals(r.unknownFields, []);
});

Deno.test("vm: render picks the smallest fit, wires refs, decides on image", () => {
  const out = adapter("vm").render(
    foreign("vm", "app", {
      machineType: "t3.medium",
      vcpus: 2,
      memoryMiB: 4096,
      architecture: "x86_64",
      image: "ami-123",
      publicIp: false,
      bootDiskGiB: 30,
      labels: { Team: "Web", "cost center": "42" },
    }),
    "app",
    TARGET,
    context({
      network: ["aws:network:vpc"],
      "block-volume": ["aws:block-volume:data"],
      firewall: ["aws:firewall:sg"],
    }),
  );
  const g = out.globalArguments;
  assertEquals(g.size, "s-2vcpu-4gb");
  assertEquals(g.region, "ams3");
  assertEquals(g.public_networking, false);
  assertEquals(g.vpc_uuid, "${{ ref(aws:network:vpc, default) }}");
  assertEquals(g.volumes, ["${{ ref(aws:block-volume:data, default) }}"]);
  assertEquals(g.tags, ["Team:Web", "cost_center:42"]);
  assertEquals(g.image, undefined);
  assert(
    out.decisions.some((d) =>
      d.includes("ami-123") && d.includes("not portable")
    ),
  );
  assert(
    out.losses.some((l) => l.includes("DigitalOcean tags are plain strings")),
  );
  assert(out.losses.some((l) => l.includes("cost center")));
  assert(out.losses.some((l) => l.includes("firewall sg")));
  assertEquals(out.expected, {
    vcpus: 2,
    memoryMiB: 4096,
    architecture: "x86_64",
    publicIp: false,
    labels: { Team: "Web", cost_center: "42" },
  });
  assertNoSecrets(g);
});

Deno.test("vm: arm64 and oversized sources become decisions, over-provision is a loss", () => {
  const arm = adapter("vm").render(
    foreign("vm", "arm", {
      vcpus: 2,
      memoryMiB: 4096,
      architecture: "arm64",
      image: "x",
      labels: {},
    }),
    "arm",
    TARGET,
    context(),
  );
  assert(arm.decisions.some((d) => d.includes("arm64")));

  const huge = adapter("vm").render(
    foreign("vm", "huge", {
      vcpus: 96,
      memoryMiB: 1024 * 1024,
      architecture: "x86_64",
      labels: {},
    }),
    "huge",
    TARGET,
    context(),
  );
  assert(
    huge.decisions.some((d) => d.includes("no DigitalOcean droplet size")),
  );
  assertEquals(huge.globalArguments.size, undefined);

  const odd = adapter("vm").render(
    foreign("vm", "odd", {
      vcpus: 1,
      memoryMiB: 3072,
      architecture: "x86_64",
      labels: {},
    }),
    "odd",
    TARGET,
    context(),
  );
  assertEquals(odd.globalArguments.size, "s-2vcpu-4gb");
  assert(odd.losses.some((l) => l.includes("s-2vcpu-4gb")));
});

Deno.test("vm: validateName follows the droplet hostname rule", () => {
  const v = adapter("vm").validateName;
  assertEquals(v("web-1"), []);
  assert(v("web_1").length > 0);
  assert(v("web-").length > 0);
});

// ---------------------------------------------------------------------------

Deno.test("block-volume: normalise and render", () => {
  const r = adapter("block-volume").normalise(
    {
      id: VOL_ID,
      name: "data",
      size_gigabytes: 100,
      region: { slug: "ams3" },
      tags: ["backup"],
      droplet_ids: [4242],
    },
    "do-vol",
    null,
  );
  assertEquals(r.properties, {
    sizeGiB: 100,
    media: "ssd",
    iops: null,
    encryption: "provider-managed",
    zone: null,
    labels: { backup: "" },
  });
  const out = adapter("block-volume").render(
    foreign("block-volume", "data", {
      sizeGiB: 200,
      media: "hdd",
      iops: 3000,
      encryption: "customer-key",
      zone: "eu-west-2a",
      labels: { app: "db" },
    }),
    "data",
    TARGET,
    context(),
  );
  assertEquals(out.globalArguments, {
    name: "data",
    region: "ams3",
    size_gigabytes: 200,
    tags: ["app:db"],
  });
  assert(out.losses.some((l) => l.includes("HDD")));
  assert(out.losses.some((l) => l.includes("3000 IOPS")));
  assert(out.decisions.some((d) => d.includes("customer-managed key")));
  assertEquals(out.expected.encryption, "provider-managed");
});

// ---------------------------------------------------------------------------

const PG_CLUSTER = {
  id: "44444444-aaaa-bbbb-cccc-000000000004",
  name: "app-db",
  engine: "pg",
  version: "16",
  num_nodes: 2,
  size: "db-s-2vcpu-4gb",
  region: "ams3",
  status: "online",
  private_network_uuid: VPC_ID,
  tags: ["env:prod"],
  storage_size_mib: 61440,
  rules: [{ type: "droplet", value: "4242" }],
  // Secrets the adapters must never copy.
  connection: {
    uri: "postgres://doadmin:SECRET-PW@host:25060/db",
    password: "SECRET-PW",
  },
  private_connection: {
    uri: "postgres://doadmin:SECRET-PW@private:25060/db",
    password: "SECRET-PW",
  },
  users: [{ name: "doadmin", password: "SECRET-PW" }],
};
const REDIS_CLUSTER = {
  ...PG_CLUSTER,
  id: "55555555-aaaa-bbbb-cccc-000000000005",
  name: "app-cache",
  engine: "valkey",
  version: "8",
  size: "db-s-1vcpu-2gb",
  num_nodes: 1,
  rules: [],
};

Deno.test("sql-database and cache: accepts splits database_cluster by engine", () => {
  const sql = adapter("sql-database");
  const cache = adapter("cache");
  assertEquals(sql.behaviorType, cache.behaviorType);
  for (
    const [engine, isSql, isCache] of [
      ["pg", true, false],
      ["mysql", true, false],
      ["advanced_pg", true, false],
      ["redis", false, true],
      ["valkey", false, true],
      ["mongodb", false, false],
      ["kafka", false, false],
      ["opensearch", false, false],
    ] as const
  ) {
    assertEquals(sql.accepts!({ engine }), isSql, `sql accepts ${engine}`);
    assertEquals(
      cache.accepts!({ engine }),
      isCache,
      `cache accepts ${engine}`,
    );
  }
  assertEquals(sql.accepts!({}), false);
  assertEquals(cache.accepts!({}), false);
});

Deno.test("sql-database: normalise never carries connection details", () => {
  const r = adapter("sql-database").normalise(PG_CLUSTER, "do-db", null);
  assertEquals(r.properties, {
    engine: "postgres",
    engineVersion: "16",
    instanceClass: "db-s-2vcpu-4gb",
    vcpus: 2,
    memoryMiB: 4096,
    storageGiB: 60,
    highAvailability: true,
    backupRetentionDays: 7,
    publicAccess: false,
    labels: { env: "prod" },
  });
  assertEquals(r.refs, [{
    kind: "network",
    nativeId: VPC_ID,
    via: "private_network_uuid",
  }]);
  assertEquals(r.unknownFields, []);
  assert(!JSON.stringify(r).includes("SECRET-PW"));
  assert(!JSON.stringify(r).includes("postgres://"));
});

Deno.test("sql-database: render maps engine, size, HA and VPC", () => {
  const out = adapter("sql-database").render(
    foreign("sql-database", "orders", {
      engine: "postgres",
      engineVersion: "15.4",
      vcpus: 2,
      memoryMiB: 8192,
      storageGiB: 100,
      highAvailability: true,
      backupRetentionDays: 14,
      publicAccess: false,
      labels: { team: "pay" },
    }),
    "orders",
    TARGET,
    context({ network: ["aws:network:vpc"] }),
  );
  assertEquals(out.globalArguments, {
    name: "orders",
    region: "ams3",
    engine: "pg",
    version: "15",
    size: "db-s-4vcpu-8gb",
    num_nodes: 2,
    storage_size_mib: 102400,
    private_network_uuid: "${{ ref(aws:network:vpc, default) }}",
    tags: ["team:pay"],
  });
  assert(out.losses.some((l) => l.includes("db-s-4vcpu-8gb")));
  assert(out.losses.some((l) => l.includes("14 days")));
  assert(
    out.decisions.some((d) =>
      d.includes("trusted sources") || d.includes("`rules`")
    ),
  );
  assertEquals(out.expected.highAvailability, true);
  assertEquals(out.expected.publicAccess, null);
  assertNoSecrets(out.globalArguments);

  const unsupported = adapter("sql-database").render(
    foreign("sql-database", "ora", {
      engine: "oracle",
      vcpus: 2,
      memoryMiB: 4096,
      labels: {},
    }),
    "ora",
    TARGET,
    context(),
  );
  assert(unsupported.decisions.some((d) => d.includes("oracle")));
  assertEquals(unsupported.globalArguments.engine, undefined);
});

Deno.test("cache: normalise and render", () => {
  const r = adapter("cache").normalise(REDIS_CLUSTER, "do-cache", null);
  assertEquals(r.properties, {
    engine: "valkey",
    engineVersion: "8",
    memoryGiB: 2,
    nodes: 1,
    labels: { env: "prod" },
  });
  assert(!JSON.stringify(r).includes("SECRET-PW"));

  const out = adapter("cache").render(
    foreign("cache", "sessions", {
      engine: "redis",
      engineVersion: "7.1",
      memoryGiB: 3,
      nodes: 5,
      labels: {},
    }),
    "sessions",
    TARGET,
    context(),
  );
  assertEquals(out.globalArguments, {
    name: "sessions",
    region: "ams3",
    engine: "redis",
    size: "db-s-2vcpu-4gb",
    num_nodes: 3,
  });
  assert(out.losses.some((l) => l.includes("1 to 3")));
  assertEquals(out.expected.memoryGiB, 4);

  const memcached = adapter("cache").render(
    foreign("cache", "mc", {
      engine: "memcached",
      memoryGiB: 1,
      nodes: 1,
      labels: {},
    }),
    "mc",
    TARGET,
    context(),
  );
  assert(memcached.decisions.some((d) => d.includes("memcached")));
});

Deno.test("cluster names: validateName", () => {
  assertEquals(adapter("sql-database").validateName("app-db"), []);
  assert(adapter("sql-database").validateName("App_DB").length > 0);
  assert(adapter("cache").validateName("ab").length > 0);
});

// ---------------------------------------------------------------------------

Deno.test("dns-zone: normalise and render", () => {
  const r = adapter("dns-zone").normalise(
    { name: "example.com", ttl: 1800 },
    "do-domain",
    null,
  );
  assertEquals(r.nativeId, "example.com");
  assertEquals(r.properties, {
    domain: "example.com",
    private: false,
    labels: {},
  });
  assertEquals(adapter("dns-zone").idField, "name");

  const out = adapter("dns-zone").render(
    foreign("dns-zone", "example.com", {
      domain: "example.com",
      private: true,
      labels: { a: "b" },
    }),
    "example.com",
    TARGET,
    context(),
  );
  assertEquals(out.globalArguments, { name: "example.com" });
  assert(out.decisions.some((d) => d.includes("private")));
  assert(out.losses.length > 0);
  assertEquals(adapter("dns-zone").validateName("example.com"), []);
  assert(adapter("dns-zone").validateName("not a domain").length > 0);
});

Deno.test("dns-record: normalise with and without a known zone", () => {
  const withZone = adapter("dns-record").normalise(
    {
      id: 777,
      type: "MX",
      name: "@",
      data: "mail.example.com.",
      priority: 10,
      ttl: 3600,
      // Not part of the real record state; a snapshot may merge it in.
      domain_name: "example.com",
    },
    "do-rec",
    null,
  );
  assertEquals(withZone.properties, {
    name: "example.com",
    type: "MX",
    ttl: 3600,
    values: ["10 mail.example.com"],
  });
  assertEquals(withZone.refs, [{
    kind: "dns-zone",
    nativeId: "example.com",
    via: "domain_name",
  }]);

  const bare = adapter("dns-record").normalise(
    { id: 778, type: "A", name: "www", data: "203.0.113.9", ttl: 300 },
    "do-rec2",
    null,
  );
  assertEquals(bare.properties.name, null);
  assertEquals(bare.refs, []);
  assertEquals(bare.unknownFields, ["zone", "name"]);
});

Deno.test("dns-record: a record with no domain is a decision, not '@.' or 'www.'", () => {
  for (const name of ["@", "www"]) {
    const out = adapter("dns-record").render(
      foreign("dns-record", name, {
        name,
        type: "A",
        ttl: 300,
        values: ["203.0.113.9"],
      }),
      "rec",
      TARGET,
      context({ "dns-zone": ["aws:dns-zone:example.com"] }),
    );
    assertEquals(out.globalArguments.name, undefined);
    assertEquals(out.globalArguments.domain_name, undefined);
    assert(out.decisions.some((d) => d.includes("full DNS name")));
    assertEquals(out.expected.name, null);
  }
});

Deno.test("firewall: rules with no CIDRs are a decision, not empty addresses", () => {
  const out = adapter("firewall").render(
    foreign("firewall", "tagged", {
      description: "x",
      labels: {},
      rules: [
        { direction: "ingress", protocol: "tcp", ports: "22", cidrs: [] },
      ],
    }),
    "tagged",
    TARGET,
    context(),
  );
  assertEquals(out.globalArguments.inbound_rules, undefined);
  assert(out.decisions.some((d) => d.includes("no CIDR")));
  assertEquals((out.expected.rules as unknown[]).length, 0);
});

Deno.test("block-volume: fractional size is rounded up with a loss", () => {
  const out = adapter("block-volume").render(
    foreign("block-volume", "v", {
      sizeGiB: 10.5,
      media: "ssd",
      iops: null,
      encryption: "provider-managed",
      zone: null,
      labels: {},
    }),
    "v",
    TARGET,
    context(),
  );
  assertEquals(out.globalArguments.size_gigabytes, 11);
  assert(out.losses.some((l) => l.includes("rounded up")));
});

Deno.test("dns-record: render relative names, record values and decisions", () => {
  const zone = "aws:dns-zone:example.com";
  const ctx = context({ "dns-zone": [zone] });

  const a = adapter("dns-record").render(
    foreign("dns-record", "www.example.com", {
      name: "www.example.com",
      type: "A",
      ttl: 10,
      values: ["203.0.113.9"],
    }),
    "www.example.com",
    TARGET,
    ctx,
  );
  assertEquals(a.globalArguments, {
    instance_name: "www.example.com",
    type: "A",
    domain_name: "${{ ref(aws:dns-zone:example.com, default) }}",
    name: "www",
    data: "203.0.113.9",
    ttl: 30,
  });
  assert(a.losses.some((l) => l.includes("30s")));
  assertEquals(a.expected, {
    name: "www.example.com",
    type: "A",
    ttl: 30,
    values: ["203.0.113.9"],
  });

  const mx = adapter("dns-record").render(
    foreign("dns-record", "example.com", {
      name: "example.com",
      type: "MX",
      ttl: 3600,
      values: ["10 mail.example.com", "20 alt.example.com"],
    }),
    "example.com",
    TARGET,
    ctx,
  );
  assertEquals(mx.globalArguments.name, "@");
  assertEquals(mx.globalArguments.priority, 10);
  assertEquals(mx.globalArguments.data, "mail.example.com.");
  assert(mx.decisions.some((d) => d.includes("one value each")));
  assertEquals(mx.expected.values, ["10 mail.example.com"]);

  const txt = adapter("dns-record").render(
    foreign("dns-record", "t.example.com", {
      name: "t.example.com",
      type: "TXT",
      ttl: 300,
      values: ['"v=spf1 -all"'],
    }),
    "t.example.com",
    TARGET,
    ctx,
  );
  assertEquals(txt.globalArguments.data, "v=spf1 -all");

  const soa = adapter("dns-record").render(
    foreign("dns-record", "example.com", {
      name: "example.com",
      type: "SOA",
      ttl: 900,
      values: ["ns1 admin 1 2 3 4 5"],
    }),
    "example.com",
    TARGET,
    ctx,
  );
  assert(soa.decisions.some((d) => d.includes("SOA")));

  const orphan = adapter("dns-record").render(
    foreign("dns-record", "x.other.org", {
      name: "x.other.org",
      type: "A",
      ttl: 300,
      values: ["1.2.3.4"],
    }),
    "x.other.org",
    TARGET,
    ctx,
  );
  assert(
    orphan.decisions.some((d) => d.includes("not inside a migrated DNS zone")),
  );
});

// ---------------------------------------------------------------------------

Deno.test("load-balancer: normalise", () => {
  const r = adapter("load-balancer").normalise(
    {
      id: "66666666-aaaa-bbbb-cccc-000000000006",
      name: "front",
      region: { slug: "ams3" },
      network: "EXTERNAL",
      type: "REGIONAL",
      vpc_uuid: VPC_ID,
      droplet_ids: [4242, 4243],
      tag: "web",
      forwarding_rules: [
        {
          entry_protocol: "http",
          entry_port: 80,
          target_protocol: "http",
          target_port: 8080,
        },
        {
          entry_protocol: "http2",
          entry_port: 443,
          target_protocol: "http",
          target_port: 8080,
          certificate_id: "c",
        },
      ],
    },
    "do-lb",
    null,
  );
  assertEquals(r.properties.scheme, "internet");
  assertEquals(r.properties.layer, "application");
  assertEquals(r.properties.listeners, [{ protocol: "http", port: 80 }, {
    protocol: "https",
    port: 443,
  }]);
  assertEquals(r.refs.map((x) => `${x.kind}:${x.nativeId}`), [
    `network:${VPC_ID}`,
    "vm:4242",
    "vm:4243",
  ]);
});

Deno.test("load-balancer: render HTTPS as passthrough and network layer as TCP", () => {
  const app = adapter("load-balancer").render(
    foreign("load-balancer", "front", {
      scheme: "internet",
      layer: "application",
      listeners: [{ protocol: "http", port: 80 }, {
        protocol: "https",
        port: 443,
      }],
      labels: {},
    }),
    "front",
    TARGET,
    context({ network: ["aws:network:vpc"], vm: ["aws:vm:a", "aws:vm:b"] }),
  );
  assertEquals(app.globalArguments.type, "REGIONAL");
  assertEquals(app.globalArguments.network, "EXTERNAL");
  assertEquals(
    (app.globalArguments.forwarding_rules as Record<string, unknown>[])[1],
    {
      entry_protocol: "https",
      entry_port: 443,
      target_protocol: "https",
      target_port: 443,
      tls_passthrough: true,
    },
  );
  assertEquals((app.globalArguments.droplet_ids as string[]).length, 2);
  assert(app.losses.some((l) => l.includes("TLS passthrough")));

  const net = adapter("load-balancer").render(
    foreign("load-balancer", "nlb", {
      scheme: "internal",
      layer: "network",
      listeners: [{ protocol: "https", port: 443 }, {
        protocol: "tcp",
        port: 5432,
      }],
      labels: {},
    }),
    "nlb",
    TARGET,
    context(),
  );
  assertEquals(net.globalArguments.type, "REGIONAL_NETWORK");
  assertEquals(net.globalArguments.network, "INTERNAL");
  assertEquals(net.expected.listeners, [{ protocol: "tcp", port: 443 }, {
    protocol: "tcp",
    port: 5432,
  }]);

  const none = adapter("load-balancer").render(
    foreign("load-balancer", "empty", {
      scheme: "internet",
      layer: "application",
      listeners: [],
      labels: {},
    }),
    "empty",
    TARGET,
    context(),
  );
  assert(none.decisions.some((d) => d.includes("forwarding_rules")));
});

// ---------------------------------------------------------------------------

Deno.test("kubernetes-cluster: normalise and render", () => {
  const r = adapter("kubernetes-cluster").normalise(
    {
      id: "77777777-aaaa-bbbb-cccc-000000000007",
      name: "prod",
      region: "ams3",
      version: "1.30.4-do.0",
      vpc_uuid: VPC_ID,
      tags: ["k8s", "k8s:77777777", "env:prod"],
      node_pools: [{ name: "a", size: "s-2vcpu-4gb", count: 2 }, {
        name: "b",
        size: "s-4vcpu-8gb",
        count: 3,
      }],
    },
    "do-k8s",
    null,
  );
  assertEquals(r.properties, {
    version: "1.30",
    nodeCount: 5,
    privateEndpoint: false,
    labels: { env: "prod" },
  });
  assertEquals(r.refs, [{
    kind: "network",
    nativeId: VPC_ID,
    via: "vpc_uuid",
  }]);

  const out = adapter("kubernetes-cluster").render(
    foreign("kubernetes-cluster", "prod", {
      version: "1.29",
      nodeCount: 4,
      privateEndpoint: true,
      labels: { env: "prod" },
    }),
    "prod",
    TARGET,
    context({ network: ["aws:network:vpc"] }),
  );
  assertEquals(out.globalArguments, {
    name: "prod",
    region: "ams3",
    version: "1.29",
    node_pools: [{ name: "default-pool", size: "s-2vcpu-4gb", count: 4 }],
    vpc_uuid: "${{ ref(aws:network:vpc, default) }}",
    tags: ["env:prod"],
  });
  assert(out.decisions.some((d) => d.includes("node pools")));
  assert(out.losses.some((l) => l.includes("always public")));
  assertEquals(out.expected.privateEndpoint, false);
});

// ---------------------------------------------------------------------------

Deno.test("container-registry: normalise and render", () => {
  const r = adapter("container-registry").normalise(
    { name: "example-reg", region: "ams3", storage_usage_bytes: 1048576 },
    "do-reg",
    null,
  );
  assertEquals(r.nativeId, "example-reg");
  assertEquals(r.dataBytes, 1048576);
  assertEquals(adapter("container-registry").idField, "name");
  assertEquals(r.properties.immutableTags, false);

  const out = adapter("container-registry").render(
    foreign("container-registry", "images", {
      name: "images",
      immutableTags: true,
      scanOnPush: true,
      labels: {},
    }),
    "images",
    TARGET,
    context(),
  );
  assertEquals(out.globalArguments, {
    name: "images",
    subscription_tier_slug: "basic",
    region: "ams3",
  });
  assert(out.losses.some((l) => l.includes("immutable")));
  assert(out.losses.some((l) => l.includes("scan-on-push")));
  assertEquals(adapter("container-registry").validateName("images"), []);
  assert(adapter("container-registry").validateName("Images_1").length > 0);
});

// ---------------------------------------------------------------------------

Deno.test("file-share: normalise and render", () => {
  const r = adapter("file-share").normalise(
    {
      id: "88888888-aaaa-bbbb-cccc-000000000008",
      name: "shared",
      size_gib: 100,
      region: "ams3",
      vpc_ids: [VPC_ID],
      performance_tier: "standard",
    },
    "do-nfs",
    null,
  );
  assertEquals(r.properties, {
    protocol: "nfs",
    capacityGiB: 100,
    performance: "standard",
    encryption: null,
    labels: {},
  });
  assertEquals(r.refs, [{ kind: "network", nativeId: VPC_ID, via: "vpc_ids" }]);

  const small = adapter("file-share").render(
    foreign("file-share", "efs", {
      protocol: "nfs",
      capacityGiB: 10,
      performance: "high",
      encryption: "customer-key",
      labels: {},
    }),
    "efs",
    TARGET,
    context({ network: ["aws:network:vpc"] }),
  );
  assertEquals(small.globalArguments, {
    name: "efs",
    region: "ams3",
    size_gib: 50,
    performance_tier: "high",
    vpc_ids: ["${{ ref(aws:network:vpc, default) }}"],
  });
  assert(small.losses.some((l) => l.includes("50 GiB minimum")));
  assert(small.decisions.some((d) => d.includes("customer-managed key")));

  const elastic = adapter("file-share").render(
    foreign("file-share", "elastic", {
      protocol: "smb",
      capacityGiB: null,
      performance: "standard",
      labels: {},
    }),
    "elastic",
    TARGET,
    context(),
  );
  assert(elastic.decisions.some((d) => d.includes("SMB")));
  assert(elastic.decisions.some((d) => d.includes("vpc_ids")));
  assert(elastic.losses.some((l) => l.includes("elastic")));
});

// ---------------------------------------------------------------------------

Deno.test("no kind ever renders secret-looking arguments", () => {
  const sources: [ResourceKind, Record<string, unknown>][] = [
    ["network", { cidr: "10.0.0.0/16", labels: {} }],
    ["firewall", { rules: [], labels: {} }],
    ["vm", { vcpus: 1, memoryMiB: 1024, architecture: "x86_64", labels: {} }],
    ["block-volume", { sizeGiB: 10, labels: {} }],
    ["sql-database", {
      engine: "mysql",
      engineVersion: "8.0",
      vcpus: 1,
      memoryMiB: 1024,
      labels: {},
    }],
    ["cache", { engine: "valkey", memoryGiB: 1, nodes: 1, labels: {} }],
    ["dns-zone", { domain: "example.com", private: false, labels: {} }],
    ["load-balancer", {
      scheme: "internet",
      layer: "network",
      listeners: [{ protocol: "tcp", port: 22 }],
      labels: {},
    }],
    ["kubernetes-cluster", { version: "1.30", nodeCount: 3, labels: {} }],
    ["container-registry", { name: "r", labels: {} }],
    ["file-share", { protocol: "nfs", capacityGiB: 100, labels: {} }],
  ];
  for (const [kind, props] of sources) {
    const out = adapter(kind).render(
      foreign(kind, "thing", props),
      "thing",
      TARGET,
      context(),
    );
    assertNoSecrets(out.globalArguments);
    assert(out.behaviorType.startsWith("@swamp/digitalocean/"), kind);
  }
});

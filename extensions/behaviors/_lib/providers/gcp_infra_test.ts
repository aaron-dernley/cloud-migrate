import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  RenderContext,
  TargetSettings,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import { firstZoneOf, gcpInfraKinds } from "./gcp_infra.ts";

const target: TargetSettings = {
  provider: "gcp",
  region: "europe-west2",
  project: "demo-project",
};
const API = "https://www.googleapis.com/compute/v1/projects/demo-project";

/** A fake context: `deps` are canonical ids; refs render as `REF(<id>[:<field>])`. */
function ctx(
  deps: string[] = [],
  names: Record<string, string> = {},
): RenderContext {
  return {
    refTo: (id, field) =>
      deps.includes(id) ? `REF(${id}${field ? `:${field}` : ""})` : null,
    dependencies: (kind: ResourceKind) =>
      deps.filter((d) => d.split(":")[1] === kind),
    targetNameOf: (id) => names[id] ?? null,
  };
}

/** A hand-built canonical resource, as another provider's adapter would produce. */
function canon(
  provider: string,
  kind: ResourceKind,
  name: string,
  properties: Record<string, unknown>,
  extra: Partial<CanonicalResource> = {},
): CanonicalResource {
  return {
    id: `${provider}:${kind}:${name}`,
    provider,
    kind,
    nativeId: name,
    aliases: [],
    name,
    region: "us-east-1",
    source: { behaviorType: "x", behaviorName: "x" },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
    ...extra,
  };
}

Deno.test("gcpInfraKinds exposes every infra kind", () => {
  assertEquals(Object.keys(gcpInfraKinds).sort(), [
    "block-volume",
    "dns-record",
    "dns-zone",
    "firewall",
    "kubernetes-cluster",
    "load-balancer",
    "network",
    "subnet",
    "vm",
  ]);
});

Deno.test("network: normalise and render", () => {
  const k = gcpInfraKinds.network!;
  const r = k.normalise(
    {
      id: "1111",
      name: "demo-net",
      selfLink: `${API}/global/networks/demo-net`,
      autoCreateSubnetworks: false,
    },
    "net",
    null,
  );
  assertEquals(r.nativeId, `${API}/global/networks/demo-net`);
  assertEquals(r.aliases, [
    "projects/demo-project/global/networks/demo-net",
    "1111",
    "demo-net",
  ]);
  assertEquals(r.properties, { cidr: null, labels: {} });
  assertEquals(k.idField, "selfLink");

  const out = k.render(
    canon("aws", "network", "vpc-1", {
      cidr: "10.0.0.0/16",
      labels: { Env: "Prod" },
    }),
    "demo-net",
    target,
    ctx(),
  );
  assertEquals(out.behaviorType, "@swamp/gcp/compute/networks");
  assertEquals(out.globalArguments, {
    name: "demo-net",
    autoCreateSubnetworks: false,
    routingConfig: { routingMode: "REGIONAL" },
    project: "demo-project",
  });
  assert(out.losses.some((l) => l.includes("10.0.0.0/16")));
  assert(out.losses.some((l) => l.includes("no labels")));
  assertEquals(out.expected, { cidr: null, labels: {} });
});

Deno.test("network: missing project is a decision", () => {
  const out = gcpInfraKinds.network!.render(
    canon("aws", "network", "v", { cidr: null, labels: {} }),
    "n",
    { provider: "gcp", region: "r" },
    ctx(),
  );
  assertEquals(out.globalArguments.project, undefined);
  assert(out.decisions.some((d) => d.includes("target.project")));
});

Deno.test("subnet: normalise and render", () => {
  const k = gcpInfraKinds.subnet!;
  const r = k.normalise(
    {
      name: "demo-sub",
      selfLink: `${API}/regions/europe-west2/subnetworks/demo-sub`,
      region: `${API}/regions/europe-west2`,
      network: `${API}/global/networks/demo-net`,
      ipCidrRange: "10.1.0.0/24",
    },
    "sub",
    null,
  );
  assertEquals(r.region, "europe-west2");
  assertEquals(r.properties.cidr, "10.1.0.0/24");
  assertEquals(r.refs, [{
    kind: "network",
    nativeId: `${API}/global/networks/demo-net`,
    via: "network",
  }]);

  const src = canon("aws", "subnet", "subnet-1", {
    cidr: "10.0.1.0/24",
    zone: "us-east-1a",
    publicIpOnLaunch: true,
    labels: {},
  });
  const out = k.render(src, "demo-sub", target, ctx(["aws:network:vpc-1"]));
  assertEquals(out.globalArguments.network, "REF(aws:network:vpc-1)");
  assertEquals(out.globalArguments.region, "europe-west2");
  assertEquals(out.globalArguments.ipCidrRange, "10.0.1.0/24");
  assert(out.losses.some((l) => l.includes("zonal")));
  assert(out.losses.some((l) => l.includes("public IPs")));

  // No network dependency: a decision.
  assert(
    k.render(src, "demo-sub", target, ctx()).decisions.some((d) =>
      d.includes("network")
    ),
  );
});

Deno.test("firewall: normalise expands allowed entries into canonical rules", () => {
  const k = gcpInfraKinds.firewall!;
  const r = k.normalise(
    {
      name: "allow-web",
      selfLink: `${API}/global/firewalls/allow-web`,
      network: `${API}/global/networks/demo-net`,
      direction: "INGRESS",
      allowed: [{ IPProtocol: "tcp", ports: ["80", "8000-8080"] }, {
        IPProtocol: "icmp",
      }],
      sourceRanges: ["0.0.0.0/0"],
      targetTags: ["web"],
      denied: [{ IPProtocol: "udp" }],
    },
    "fw",
    null,
  );
  assertEquals(r.properties.rules, [
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "80",
      cidrs: ["0.0.0.0/0"],
    },
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "8000-8080",
      cidrs: ["0.0.0.0/0"],
    },
    {
      direction: "ingress",
      protocol: "icmp",
      ports: null,
      cidrs: ["0.0.0.0/0"],
    },
  ]);
  assertEquals(r.properties.targetTags, ["web"]);
  assertEquals(r.properties.deniedEntries, 1);
  assertEquals(r.refs[0].kind, "network");
});

Deno.test("firewall: render from an aws group tags the rule and splits groups into decisions", () => {
  const k = gcpInfraKinds.firewall!;
  const src = canon("aws", "firewall", "sg-web", {
    description: "web",
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
        protocol: "tcp",
        ports: "80",
        cidrs: ["0.0.0.0/0"],
      },
      {
        direction: "ingress",
        protocol: "tcp",
        ports: "22",
        cidrs: ["10.0.0.0/8"],
      },
      // Allow-all egress is GCP's implied default: no resource, no decision.
      {
        direction: "egress",
        protocol: "all",
        ports: null,
        cidrs: ["0.0.0.0/0"],
      },
    ],
  });
  const out = k.render(src, "web-fw", target, ctx(["aws:network:vpc-1"]));
  assertEquals(out.globalArguments, {
    name: "web-fw",
    project: "demo-project",
    description: "web",
    network: "REF(aws:network:vpc-1)",
    direction: "INGRESS",
    allowed: [{ IPProtocol: "tcp", ports: ["443", "80"] }],
    sourceRanges: ["0.0.0.0/0"],
    targetTags: ["web-fw"],
  });
  assertEquals(out.expected.rules, [
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "443",
      cidrs: ["0.0.0.0/0"],
    },
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "80",
      cidrs: ["0.0.0.0/0"],
    },
  ]);
  // The 10.0.0.0/8 group needs its own firewall, and attachment by tag is explained.
  assert(
    out.decisions.some((d) =>
      d.includes("10.0.0.0/8") && d.includes("separate GCP firewall")
    ),
  );
  assert(
    out.decisions.some((d) =>
      d.includes("network tags") && d.includes('"web-fw"')
    ),
  );
});

Deno.test("firewall: group-reference rules and gcp deny entries are decisions", () => {
  const k = gcpInfraKinds.firewall!;
  const out = k.render(
    canon("aws", "firewall", "sg", {
      description: null,
      labels: {},
      rules: [{
        direction: "ingress",
        protocol: "tcp",
        ports: "5432",
        cidrs: [],
      }],
    }),
    "fw",
    target,
    ctx(),
  );
  assert(out.decisions.some((d) => d.includes("other security groups")));
  assert(out.decisions.some((d) => d.includes("no rule")));
  assertEquals(out.globalArguments.allowed, undefined);
});

Deno.test("disk: normalise and render", () => {
  const k = gcpInfraKinds["block-volume"]!;
  const r = k.normalise(
    {
      name: "data-1",
      selfLink: `${API}/zones/europe-west2-b/disks/data-1`,
      zone: `${API}/zones/europe-west2-b`,
      sizeGb: "100",
      type: `${API}/zones/europe-west2-b/diskTypes/pd-balanced`,
      provisionedIops: "3000",
      diskEncryptionKey: {
        kmsKeyName:
          "projects/demo-project/locations/europe-west2/keyRings/kr/cryptoKeys/k/cryptoKeyVersions/1",
      },
      labels: { team: "a" },
    },
    "disk",
    null,
  );
  assertEquals(r.region, "europe-west2");
  assertEquals(r.properties, {
    sizeGiB: 100,
    media: "ssd",
    iops: 3000,
    encryption: "customer-key",
    zone: "europe-west2-b",
    labels: { team: "a" },
  });
  assertEquals(
    r.refs[0].nativeId,
    "projects/demo-project/locations/europe-west2/keyRings/kr/cryptoKeys/k",
  );

  const src = canon("aws", "block-volume", "vol-1", {
    sizeGiB: 50,
    media: "hdd",
    iops: 3000,
    encryption: "customer-key",
    zone: "us-east-1a",
    labels: { Name: "Data" },
  });
  const out = k.render(src, "data-1", target, ctx(["aws:kms-key:key-1"]));
  assertEquals(out.globalArguments, {
    name: "data-1",
    zone: "europe-west2-a",
    project: "demo-project",
    sizeGb: "50",
    type: "zones/europe-west2-a/diskTypes/pd-standard",
    diskEncryptionKey: { kmsKeyName: "REF(aws:kms-key:key-1)" },
    labels: { name: "data" },
  });
  assert(out.losses.some((l) => l.includes("europe-west2-a")));
  assert(out.losses.some((l) => l.includes("IOPS")));
  assert(out.losses.some((l) => l.includes('"Name=Data"')));
  assertEquals(out.expected.zone, "europe-west2-a");

  // Customer key without a key in scope is a decision.
  assert(
    k.render(src, "data-1", target, ctx()).decisions.some((d) =>
      d.includes("customer-managed key")
    ),
  );
});

const instance = {
  name: "web-1",
  selfLink: `${API}/zones/europe-west2-a/instances/web-1`,
  zone: `${API}/zones/europe-west2-a`,
  machineType: `${API}/zones/europe-west2-a/machineTypes/e2-medium`,
  labels: { env: "dev" },
  tags: { items: ["web"] },
  disks: [
    {
      boot: true,
      diskSizeGb: "20",
      source: `${API}/zones/europe-west2-a/disks/web-1`,
    },
    { boot: false, source: `${API}/zones/europe-west2-a/disks/data-1` },
  ],
  networkInterfaces: [{
    network: `${API}/global/networks/demo-net`,
    subnetwork: `${API}/regions/europe-west2/subnetworks/demo-sub`,
    accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "203.0.113.10" }],
  }],
  serviceAccounts: [{ email: "app@demo-project.iam.gserviceaccount.com" }],
};

Deno.test("vm: normalise fills sizes from the table and collects refs", () => {
  const r = gcpInfraKinds.vm!.normalise(instance, "vm", null);
  assertEquals(r.region, "europe-west2");
  assertEquals(r.properties.machineType, "e2-medium");
  assertEquals(r.properties.vcpus, 2);
  assertEquals(r.properties.memoryMiB, 4096);
  assertEquals(r.properties.architecture, "x86_64");
  assertEquals(r.properties.publicIp, true);
  assertEquals(r.properties.bootDiskGiB, 20);
  assertEquals(r.properties.networkTags, ["web"]);
  assertEquals(r.unknownFields, ["image"]);
  const kinds = r.refs.map((x) => `${x.kind}:${x.via}`);
  assertEquals(kinds, [
    "subnet:networkInterfaces[0].subnetwork",
    "network:networkInterfaces[0].network",
    "block-volume:disks[boot].source",
    "block-volume:disks[1].source",
    "iam-principal:serviceAccounts[0].email",
  ]);
  // Custom machine types are parsed from their name.
  const custom = gcpInfraKinds.vm!.normalise(
    { ...instance, machineType: "zones/z/machineTypes/custom-6-12288" },
    "vm",
    null,
  );
  assertEquals([custom.properties.vcpus, custom.properties.memoryMiB], [
    6,
    12288,
  ]);
});

Deno.test("vm: render from aws picks the smallest fitting type and tags firewalls", () => {
  const k = gcpInfraKinds.vm!;
  const src = canon("aws", "vm", "i-1", {
    machineType: "t3.large",
    vcpus: 2,
    memoryMiB: 8192,
    architecture: "x86_64",
    image: "ami-123",
    publicIp: true,
    bootDiskGiB: 30,
    labels: { Env: "Dev" },
  });
  const deps = [
    "aws:subnet:s-1",
    "aws:network:v-1",
    "aws:firewall:sg-1",
    "aws:block-volume:vol-1",
  ];
  const out = k.render(
    src,
    "web-1",
    target,
    ctx(deps, { "aws:firewall:sg-1": "web-fw" }),
  );
  const g = out.globalArguments;
  assertEquals(
    g.machineType,
    "zones/europe-west2-a/machineTypes/e2-standard-2",
  );
  assertEquals(g.zone, "europe-west2-a");
  assertEquals(g.tags, { items: ["web-fw"] });
  assertEquals(g.labels, { env: "dev" });
  assertEquals(g.networkInterfaces, [{
    subnetwork: "REF(aws:subnet:s-1)",
    network: "REF(aws:network:v-1)",
    accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }],
  }]);
  assertEquals(g.disks, [
    { boot: true, autoDelete: true, initializeParams: { diskSizeGb: "30" } },
    { boot: false, autoDelete: false, source: "REF(aws:block-volume:vol-1)" },
  ]);
  assert(
    out.losses.some((l) =>
      l.includes("t3.large") && l.includes("e2-standard-2")
    ),
  );
  assert(out.decisions.some((d) => d.includes("sourceImage")));
  assertEquals(out.expected.vcpus, 2);
  assertEquals(out.expected.architecture, "x86_64");
});

Deno.test("vm: arm64, oversized and unknown sizes", () => {
  const k = gcpInfraKinds.vm!;
  const base = {
    machineType: "m",
    image: null,
    publicIp: false,
    bootDiskGiB: null,
    labels: {},
  };
  const arm = k.render(
    canon("aws", "vm", "a", {
      ...base,
      vcpus: 2,
      memoryMiB: 4096,
      architecture: "arm64",
    }),
    "a",
    target,
    ctx(),
  );
  assertEquals(
    arm.globalArguments.machineType,
    "zones/europe-west2-a/machineTypes/t2a-standard-2",
  );
  // europe-west2 has no t2a machines.
  assert(arm.decisions.some((d) => d.includes("t2a")));
  const big = k.render(
    canon("aws", "vm", "b", {
      ...base,
      vcpus: 96,
      memoryMiB: 400000,
      architecture: "x86_64",
    }),
    "b",
    target,
    ctx(),
  );
  assertEquals(big.globalArguments.machineType, undefined);
  assert(big.decisions.some((d) => d.includes("no x86_64 machine type")));
  const unknown = k.render(
    canon("aws", "vm", "c", {
      ...base,
      vcpus: null,
      memoryMiB: null,
      architecture: null,
    }),
    "c",
    target,
    ctx(),
  );
  assert(unknown.decisions.some((d) => d.includes("size is unknown")));
});

Deno.test("vm: gcp to gcp keeps the type, tags and boot disk ref", () => {
  const k = gcpInfraKinds.vm!;
  const src = k.normalise(instance, "vm", null);
  const boot = `gcp:block-volume:${API}/zones/europe-west2-a/disks/web-1`;
  const data = `gcp:block-volume:${API}/zones/europe-west2-a/disks/data-1`;
  const out = k.render(src, "web-2", target, ctx([boot, data]));
  assertEquals(
    out.globalArguments.machineType,
    "zones/europe-west2-a/machineTypes/e2-medium",
  );
  assertEquals(out.globalArguments.tags, { items: ["web"] });
  assertEquals(out.globalArguments.disks, [
    { boot: true, autoDelete: true, source: `REF(${boot})` },
    { boot: false, autoDelete: false, source: `REF(${data})` },
  ]);
  // The boot disk is its own resource, so no image decision.
  assert(!out.decisions.some((d) => d.includes("sourceImage")));
});

Deno.test("load balancer: normalise and render", () => {
  const k = gcpInfraKinds["load-balancer"]!;
  const r = k.normalise(
    {
      name: "demo-lb",
      selfLink: `${API}/regions/europe-west2/forwardingRules/demo-lb`,
      region: `${API}/regions/europe-west2`,
      loadBalancingScheme: "INTERNAL",
      IPProtocol: "TCP",
      ports: ["80", "443"],
      network: `${API}/global/networks/demo-net`,
      subnetwork: `${API}/regions/europe-west2/subnetworks/demo-sub`,
    },
    "lb",
    null,
  );
  assertEquals(r.properties.scheme, "internal");
  assertEquals(r.properties.layer, "network");
  assertEquals(r.properties.listeners, [{ protocol: "TCP", port: 80 }, {
    protocol: "TCP",
    port: 443,
  }]);
  assertEquals(r.refs.map((x) => x.kind), ["network", "subnet"]);

  const src = canon("aws", "load-balancer", "alb-1", {
    scheme: "internet",
    layer: "application",
    listeners: [{ protocol: "HTTP", port: 80 }, {
      protocol: "HTTPS",
      port: 443,
    }],
    labels: {},
  });
  const out = k.render(src, "demo-lb", target, ctx());
  assertEquals(out.globalArguments.loadBalancingScheme, "EXTERNAL_MANAGED");
  assertEquals(out.globalArguments.portRange, "80");
  assertEquals(out.globalArguments.IPProtocol, "TCP");
  assert(out.decisions.some((d) => d.includes("another protocol")));
  assert(out.decisions.some((d) => d.includes("URL map")));
});

Deno.test("dns zone: normalise strips the dot, render adds it", () => {
  const k = gcpInfraKinds["dns-zone"]!;
  const r = k.normalise(
    {
      name: "demo-zone",
      id: "42",
      dnsName: "example.com.",
      visibility: "private",
      privateVisibilityConfig: {
        networks: [{ networkUrl: `${API}/global/networks/demo-net` }],
      },
      labels: { a: "b" },
    },
    "z",
    null,
  );
  assertEquals(r.properties, {
    domain: "example.com",
    private: true,
    labels: { a: "b" },
  });
  assertEquals(r.refs[0].via, "privateVisibilityConfig.networks[0].networkUrl");
  assertEquals(k.idField, "name");

  const pub = k.render(
    canon("aws", "dns-zone", "Z1", {
      domain: "example.org",
      private: false,
      labels: {},
    }),
    "demo-zone",
    target,
    ctx(),
  );
  assertEquals(pub.globalArguments.dnsName, "example.org.");
  assertEquals(pub.globalArguments.visibility, "public");

  const priv = canon("aws", "dns-zone", "Z2", {
    domain: "corp.internal",
    private: true,
    labels: {},
  });
  const withNet = k.render(priv, "corp", target, ctx(["aws:network:v-1"]));
  assertEquals(withNet.globalArguments.privateVisibilityConfig, {
    networks: [{ networkUrl: "REF(aws:network:v-1)" }],
  });
  assert(
    k.render(priv, "corp", target, ctx()).decisions.some((d) =>
      d.includes("VPC network")
    ),
  );
});

Deno.test("dns record: normalise strips dots, render adds them and refs the zone", () => {
  const k = gcpInfraKinds["dns-record"]!;
  const r = k.normalise(
    {
      name: "mail.example.com.",
      type: "MX",
      ttl: 300,
      rrdatas: ["10 mx.example.com."],
      // Not in the real state; a snapshot may supply it.
      managedZone: "demo-zone",
    },
    "rec",
    null,
  );
  assertEquals(r.properties, {
    name: "mail.example.com",
    type: "MX",
    ttl: 300,
    values: ["10 mx.example.com"],
  });
  assertEquals(r.name, "mail.example.com-mx");
  assertEquals(r.refs, [{
    kind: "dns-zone",
    nativeId: "demo-zone",
    via: "managedZone",
  }]);
  // Without a zone in the state, the zone is unknown and there is no ref.
  const noZone = k.normalise(
    { name: "a.example.com.", type: "A", ttl: 60, rrdatas: ["192.0.2.1"] },
    "rec",
    null,
  );
  assertEquals(noZone.refs, []);
  assertEquals(noZone.unknownFields, ["zone"]);

  const src = canon("aws", "dns-record", "r1", {
    name: "www.example.com",
    type: "CNAME",
    ttl: 60,
    values: ["lb.example.net"],
  });
  const out = k.render(
    src,
    "www-example-com-cname",
    target,
    ctx(["aws:dns-zone:Z1"]),
  );
  assertEquals(out.globalArguments, {
    name: "www.example.com.",
    type: "CNAME",
    rrdatas: ["lb.example.net."],
    project: "demo-project",
    ttl: 60,
    managedZone: "REF(aws:dns-zone:Z1)",
  });
  assertEquals(out.expected.values, ["lb.example.net"]);

  const a = k.render(
    canon("aws", "dns-record", "r2", {
      name: "a.example.com",
      type: "A",
      ttl: 60,
      values: ["192.0.2.1"],
    }),
    "a",
    target,
    ctx(),
  );
  assertEquals(a.globalArguments.rrdatas, ["192.0.2.1"]);
  assert(a.decisions.some((d) => d.includes("managedZone")));
  const alias = k.render(
    canon("aws", "dns-record", "r3", {
      name: "x.example.com",
      type: "ALIAS",
      ttl: 60,
      values: ["d.example.net"],
    }),
    "x",
    target,
    ctx(["aws:dns-zone:Z1"]),
  );
  assert(alias.decisions.some((d) => d.includes('"ALIAS"')));
});

Deno.test("gke: normalise and render", () => {
  const k = gcpInfraKinds["kubernetes-cluster"]!;
  const r = k.normalise(
    {
      name: "demo-gke",
      location: "europe-west2-a",
      status: "RUNNING",
      network: "demo-net",
      subnetwork: "demo-sub",
      currentMasterVersion: "1.30.2-gke.1234",
      currentNodeCount: 3,
      privateClusterConfig: { enablePrivateEndpoint: true },
      resourceLabels: { team: "a" },
    },
    "gke",
    null,
  );
  assertEquals(r.region, "europe-west2");
  assertEquals(r.properties, {
    version: "1.30",
    nodeCount: 3,
    privateEndpoint: true,
    labels: { team: "a" },
  });
  assertEquals(r.refs.map((x) => `${x.kind}:${x.nativeId}`), [
    "network:demo-net",
    "subnet:demo-sub",
  ]);

  const src = canon("aws", "kubernetes-cluster", "eks-1", {
    version: "1.29",
    nodeCount: 4,
    privateEndpoint: true,
    labels: { Env: "Dev" },
  });
  const out = k.render(
    src,
    "demo-gke",
    target,
    ctx(["aws:network:v-1", "aws:subnet:s-1"]),
  );
  assertEquals(
    out.globalArguments.parent,
    "projects/demo-project/locations/europe-west2",
  );
  const cluster = out.globalArguments.cluster as Record<string, unknown>;
  assertEquals(cluster.network, "REF(aws:network:v-1:name)");
  assertEquals(cluster.subnetwork, "REF(aws:subnet:s-1:name)");
  assertEquals(cluster.initialClusterVersion, "1.29");
  assertEquals(cluster.initialNodeCount, 2);
  assertEquals(cluster.resourceLabels, { env: "dev" });
  assertEquals(out.expected.nodeCount, 6);
  assert(out.losses.some((l) => l.includes("4 nodes become 6")));
  assert(out.decisions.some((d) => d.includes("masterIpv4CidrBlock")));
});

Deno.test("validateName follows GCP rules", () => {
  const net = gcpInfraKinds.network!;
  assertEquals(net.validateName("good-name-1"), []);
  assert(net.validateName("Bad_Name").length >= 2);
  assertStringIncludes(
    net.validateName("1abc")[0],
    "start with a lowercase letter",
  );
  assert(net.validateName("a".repeat(64)).length > 0);
  assert(net.validateName("trailing-").length > 0);
  assert(
    gcpInfraKinds["kubernetes-cluster"]!.validateName("a".repeat(41)).length >
      0,
  );
  assertEquals(
    gcpInfraKinds["dns-record"]!.validateName("www.example.com-a"),
    [],
  );
  assert(gcpInfraKinds["dns-record"]!.validateName("Bad Name").length > 0);
});

Deno.test("zones: regions without an a zone start at b, others at a", () => {
  assertEquals(firstZoneOf("us-east1"), "us-east1-b");
  assertEquals(firstZoneOf("europe-west1"), "europe-west1-b");
  assertEquals(firstZoneOf("europe-west2"), "europe-west2-a");
  const east: TargetSettings = { ...target, region: "us-east1" };
  const disk = gcpInfraKinds["block-volume"]!.render(
    canon("aws", "block-volume", "v", {
      sizeGiB: 10,
      media: "ssd",
      encryption: "provider-managed",
      labels: {},
    }),
    "d",
    east,
    ctx(),
  );
  assertEquals(disk.globalArguments.zone, "us-east1-b");
  assert(disk.losses.some((l) => l.includes("us-east1-b")));
  const vm = gcpInfraKinds.vm!.render(
    canon("aws", "vm", "i", {
      vcpus: 2,
      memoryMiB: 4096,
      arch: "x86_64",
      labels: {},
    }),
    "vm",
    east,
    ctx(),
  );
  assertEquals(vm.globalArguments.zone, "us-east1-b");
});

Deno.test("disk: fractional size is rounded up with a loss", () => {
  const out = gcpInfraKinds["block-volume"]!.render(
    canon("aws", "block-volume", "v", {
      sizeGiB: 10.5,
      media: "ssd",
      encryption: "provider-managed",
      labels: {},
    }),
    "d",
    target,
    ctx(),
  );
  assertEquals(out.globalArguments.sizeGb, "11");
  assert(out.losses.some((l) => l.includes("rounded up")));
});

Deno.test("dns record: real state shape has no zone and no fake ref; bare names are a decision", () => {
  const k = gcpInfraKinds["dns-record"]!;
  const r = k.normalise(
    { name: "www.example.com.", type: "A", ttl: 60, rrdatas: ["192.0.2.1"] },
    "rec",
    null,
  );
  assertEquals(r.refs, []);
  assert(r.unknownFields.includes("zone"));
  const bare = k.render(
    canon("aws", "dns-record", "r", {
      name: "@",
      type: "A",
      ttl: 60,
      values: ["192.0.2.1"],
    }),
    "r",
    target,
    ctx(),
  );
  assertEquals(bare.globalArguments.name, undefined);
  assert(bare.decisions.some((d) => d.includes("full DNS name")));
});

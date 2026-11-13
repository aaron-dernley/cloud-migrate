import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  RenderContext,
  TargetSettings,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import {
  chooseServerType,
  hetzner,
  SERVER_TYPES,
  toHetznerLabels,
} from "./hetzner.ts";

const target: TargetSettings = { provider: "hetzner", region: "fsn1" };

/** A canonical resource from another cloud, built by hand. */
function awsResource(
  kind: ResourceKind,
  properties: Record<string, unknown>,
  name = "web",
): CanonicalResource {
  return {
    id: `aws:${kind}:${name}`,
    provider: "aws",
    kind,
    nativeId: name,
    aliases: [],
    name,
    region: "eu-west-2",
    source: { behaviorType: "@swamp/aws/test", behaviorName: name },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
  };
}

/** A fake RenderContext: `deps` maps kind → source ids; refTo yields a marker expression. */
function fakeContext(
  deps: Partial<Record<ResourceKind, string[]>>,
  unmigrated: string[] = [],
): RenderContext {
  return {
    refTo: (id) => (unmigrated.includes(id) ? null : `\${{ ref(${id}) }}`),
    dependencies: (kind) => deps[kind] ?? [],
    targetNameOf: (id) => id,
  };
}

const none = fakeContext({});
const kind = (k: ResourceKind) => hetzner.kinds[k]!;

Deno.test("provider declares the supported kinds and the real behavior types", () => {
  assertEquals(hetzner.id, "hetzner");
  assertEquals(hetzner.displayName, "Hetzner Cloud");
  assertEquals(Object.keys(hetzner.kinds).sort(), [
    "block-volume",
    "dns-zone",
    "firewall",
    "load-balancer",
    "network",
    "vm",
  ]);
  assertEquals(kind("network").behaviorType, "@swamp/hetzner-cloud/networks");
  assertEquals(
    kind("load-balancer").behaviorType,
    "@swamp/hetzner-cloud/load-balancers",
  );
  for (const k of Object.values(hetzner.kinds)) assertEquals(k!.idField, "id");
});

Deno.test("labels are rewritten to Hetzner rules with losses", () => {
  const r = toHetznerLabels({
    env: "prod",
    "aws:cloudformation:stack": "my stack!",
    "Team/Name": "a",
    "!!!": "x",
  });
  assertEquals(r.labels, {
    env: "prod",
    "aws_cloudformation_stack": "my_stack",
    "Team_Name": "a",
  });
  assertEquals(r.losses.length, 3);
  assertEquals(toHetznerLabels({ "example.com/role": "db" }).losses, []);
});

Deno.test("network: normalise and render", () => {
  const n = kind("network").normalise(
    {
      id: 4242,
      name: "private",
      ip_range: "10.0.0.0/16",
      subnets: [{
        type: "cloud",
        ip_range: "10.0.1.0/24",
        network_zone: "eu-central",
      }],
      labels: { env: "dev" },
    },
    "net-1",
    null,
  );
  assertEquals(n.id, "hetzner:network:4242");
  assertEquals(n.properties, { cidr: "10.0.0.0/16", labels: { env: "dev" } });
  assertEquals(n.region, "eu-central");
  assertEquals(n.aliases, ["private"]);

  const r = kind("network").render(
    awsResource("network", { cidr: "10.20.0.0/16", labels: { Env: "dev" } }),
    "app-net",
    target,
    none,
  );
  assertEquals(r.globalArguments, {
    name: "app-net",
    ip_range: "10.20.0.0/16",
    subnets: [{
      type: "cloud",
      ip_range: "10.20.0.0/16",
      network_zone: "eu-central",
    }],
    labels: { Env: "dev" },
  });
  assertEquals(r.decisions, []);
  assertEquals(r.expected, { cidr: "10.20.0.0/16", labels: { Env: "dev" } });
  assert(r.losses.some((l) => l.includes("subnets live inside the network")));
});

Deno.test("network: unusable ranges and unknown location are decisions", () => {
  const net = kind("network");
  const aws = net.render(
    awsResource("network", { cidr: "172.31.0.0/16", labels: {} }),
    "d",
    target,
    none,
  );
  assert(aws.decisions.some((d) => d.includes("172.31.1.1")));
  assertEquals(aws.globalArguments.ip_range, undefined);
  const pub = net.render(
    awsResource("network", { cidr: "8.8.0.0/16", labels: {} }),
    "d",
    target,
    none,
  );
  assert(pub.decisions.some((d) => d.includes("RFC 1918")));
  const auto = net.render(
    awsResource("network", { cidr: null, labels: {} }),
    "d",
    target,
    none,
  );
  assert(auto.decisions.some((d) => d.includes("no CIDR")));
  const small = net.render(
    awsResource("network", { cidr: "10.0.0.0/28", labels: {} }),
    "d",
    target,
    none,
  );
  assert(small.decisions.some((d) => d.includes("/24")));
  const badRegion = net.render(
    awsResource("network", { cidr: "10.0.0.0/16", labels: {} }),
    "d",
    {
      provider: "hetzner",
      region: "eu-west-2",
    },
    none,
  );
  assert(badRegion.decisions.some((d) => d.includes("not a Hetzner location")));
});

Deno.test("firewall: normalise Hetzner rules", () => {
  const f = kind("firewall").normalise(
    {
      id: 77,
      name: "web-fw",
      labels: { tier: "web" },
      rules: [
        {
          direction: "in",
          protocol: "tcp",
          port: "443",
          source_ips: ["0.0.0.0/0", "::/0"],
        },
        { direction: "in", protocol: "icmp", source_ips: ["10.0.0.0/8"] },
        {
          direction: "out",
          protocol: "udp",
          port: "any",
          destination_ips: ["0.0.0.0/0"],
        },
      ],
    },
    "fw-1",
    null,
  );
  assertEquals(f.properties.rules, [
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
    { direction: "egress", protocol: "udp", ports: null, cidrs: ["0.0.0.0/0"] },
  ]);
  assertEquals(f.unknownFields, []);
});

Deno.test("firewall: render expands all, drops empty rules, notes description", () => {
  const r = kind("firewall").render(
    awsResource("firewall", {
      description: "web tier",
      labels: {},
      rules: [
        {
          direction: "ingress",
          protocol: "tcp",
          ports: "22",
          cidrs: ["10.0.0.0/8"],
        },
        {
          direction: "ingress",
          protocol: "all",
          ports: null,
          cidrs: ["192.168.0.0/16"],
        },
        { direction: "egress", protocol: "tcp", ports: "443", cidrs: [] },
      ],
    }),
    "web-fw",
    target,
    none,
  );
  const rules = r.globalArguments.rules as Record<string, unknown>[];
  assertEquals(rules.length, 4);
  assertEquals(rules[0], {
    direction: "in",
    protocol: "tcp",
    source_ips: ["10.0.0.0/8"],
    port: "22",
  });
  assertEquals(rules[1].port, "1-65535");
  assertEquals(rules[3], {
    direction: "in",
    protocol: "icmp",
    source_ips: ["192.168.0.0/16"],
  });
  assert(r.losses.some((l) => l.includes("expands to tcp, udp and icmp")));
  assert(r.losses.some((l) => l.includes("no CIDRs")));
  assert(r.losses.some((l) => l.includes("no description")));
  assertEquals((r.expected.rules as unknown[]).length, 4);
  assertEquals(r.decisions, []);
});

Deno.test("server types: smallest fit, architecture and location", () => {
  assertEquals(chooseServerType(2, 2048, "x86_64", "fsn1")?.name, "cx23");
  assertEquals(chooseServerType(2, 4096, "x86_64", "fsn1")?.name, "cx23");
  // cx is EU only: in Ashburn the same need lands on cpx.
  assertEquals(chooseServerType(2, 4096, "x86_64", "ash")?.name, "cpx22");
  assertEquals(chooseServerType(4, 8192, "x86_64", "ash")?.name, "cpx32");
  assertEquals(chooseServerType(4, 8192, "arm64", "nbg1")?.name, "cax21");
  assertEquals(chooseServerType(4, 8192, "x86_64", "fsn1")?.name, "cx33");
  assertEquals(chooseServerType(32, 131072, "x86_64", "fsn1")?.name, "ccx53");
  assertEquals(chooseServerType(32, 131072, "arm64", "fsn1"), null);
});

Deno.test("vm: normalise a server", () => {
  const v = kind("vm").normalise(
    {
      id: 1001,
      name: "web-1",
      public_net: {
        ipv4: { ip: "203.0.113.5" },
        ipv6: null,
        firewalls: [{ id: 77, status: "applied" }],
      },
      private_net: [{ network: 4242, ip: "10.0.0.2" }],
      server_type: {
        name: "cx22",
        cores: 2,
        memory: 4,
        disk: 40,
        architecture: "x86",
      },
      location: { name: "fsn1", network_zone: "eu-central" },
      image: { id: 5, name: "ubuntu-24.04" },
      volumes: [9001],
      primary_disk_size: 40,
      labels: { role: "web" },
    },
    "srv",
    null,
  );
  assertEquals(v.id, "hetzner:vm:1001");
  assertEquals(v.region, "fsn1");
  assertEquals(v.properties, {
    machineType: "cx22",
    vcpus: 2,
    memoryMiB: 4096,
    architecture: "x86_64",
    image: "ubuntu-24.04",
    publicIp: true,
    bootDiskGiB: 40,
    labels: { role: "web" },
  });
  assertEquals(v.refs.map((r) => `${r.kind}:${r.nativeId}`), [
    "network:4242",
    "firewall:77",
    "block-volume:9001",
  ]);
  assertEquals(v.unknownFields, []);
  const sparse = kind("vm").normalise({ id: 2 }, "srv", null);
  assert(sparse.unknownFields.includes("vcpus"));
  assert(sparse.unknownFields.includes("region"));
});

Deno.test("vm: render sizes, wires dependencies and records decisions", () => {
  const r = kind("vm").render(
    awsResource("vm", {
      machineType: "t3.medium",
      vcpus: 2,
      memoryMiB: 4096,
      architecture: "x86_64",
      image: "ami-0abc",
      publicIp: true,
      bootDiskGiB: 100,
      labels: { "Name": "web", "aws:autoscaling:groupName": "asg" },
    }),
    "web-1",
    target,
    fakeContext({
      network: ["aws:network:v"],
      firewall: ["aws:firewall:sg"],
      "block-volume": ["aws:block-volume:d"],
    }),
  );
  assertEquals(r.behaviorType, "@swamp/hetzner-cloud/servers");
  assertEquals(r.globalArguments.name, "web-1");
  assertEquals(r.globalArguments.location, "fsn1");
  assertEquals(r.globalArguments.server_type, "cx23");
  assertEquals(r.globalArguments.image, undefined);
  assertEquals(r.globalArguments.networks, ["${{ ref(aws:network:v) }}"]);
  assertEquals(r.globalArguments.firewalls, [{
    firewall: "${{ ref(aws:firewall:sg) }}",
  }]);
  assertEquals(r.globalArguments.volumes, ["${{ ref(aws:block-volume:d) }}"]);
  assertEquals(r.globalArguments.labels, {
    Name: "web",
    aws_autoscaling_groupName: "asg",
  });
  assert(r.decisions.some((d) => d.includes("ami-0abc")));
  assert(r.losses.some((l) => l.includes("maps to Hetzner cx23")));
  assert(r.losses.some((l) => l.includes("100 GiB but cx23 has 40")));
  assertEquals(r.expected.machineType, "cx23");
  assertEquals(r.expected.memoryMiB, 4096);
  assertEquals(r.expected.bootDiskGiB, 40);
  assertEquals(r.expected.publicIp, true);
});

Deno.test("vm: private servers, subnets, unmigrated deps, no fitting type", () => {
  const priv = kind("vm").render(
    awsResource("vm", {
      vcpus: 2,
      memoryMiB: 2048,
      architecture: "arm64",
      publicIp: false,
      labels: {},
    }),
    "worker",
    target,
    fakeContext({ subnet: ["aws:subnet:s"], firewall: ["aws:firewall:sg"] }, [
      "aws:firewall:sg",
    ]),
  );
  assertEquals(priv.globalArguments.server_type, "cax11");
  assertEquals(priv.globalArguments.public_net, {
    enable_ipv4: false,
    enable_ipv6: false,
  });
  assert(priv.decisions.some((d) => d.includes("no subnet resource")));
  assert(priv.decisions.some((d) => d.includes("aws:firewall:sg")));
  assertEquals(priv.expected.publicIp, false);

  const big = kind("vm").render(
    awsResource("vm", {
      vcpus: 96,
      memoryMiB: 393216,
      architecture: "x86_64",
      labels: {},
    }),
    "huge",
    target,
    none,
  );
  assertEquals(big.globalArguments.server_type, undefined);
  assert(
    big.decisions.some((d) => d.includes("no Hetzner server type offers")),
  );

  const unsized = kind("vm").render(
    awsResource("vm", {
      vcpus: null,
      memoryMiB: null,
      architecture: null,
      labels: {},
    }),
    "x",
    { provider: "hetzner", region: "us-east-1" },
    none,
  );
  assert(
    unsized.decisions.some((d) =>
      d.includes("unknown; choose a Hetzner server type")
    ),
  );
  assert(unsized.decisions.some((d) => d.includes("not a Hetzner location")));
  assertEquals(unsized.globalArguments.location, undefined);
});

Deno.test("vm: server names follow RFC 1123", () => {
  const v = kind("vm");
  assertEquals(v.validateName("web-1.example"), []);
  assert(v.validateName("web_1").length > 0);
  assert(v.validateName("-web").length > 0);
  assert(v.validateName("a".repeat(64)).length > 0);
});

Deno.test("block-volume: normalise and render", () => {
  const v = kind("block-volume").normalise(
    {
      id: 9001,
      name: "data",
      size: 50,
      location: { name: "nbg1", network_zone: "eu-central" },
      server: 1001,
      labels: { app: "db" },
    },
    "vol",
    null,
  );
  assertEquals(v.properties, {
    sizeGiB: 50,
    media: "ssd",
    iops: null,
    encryption: "none",
    zone: "nbg1",
    labels: { app: "db" },
  });
  assertEquals(v.refs, []);
  assertEquals(v.region, "nbg1");

  const r = kind("block-volume").render(
    awsResource("block-volume", {
      sizeGiB: 4,
      media: "hdd",
      iops: 3000,
      encryption: "customer-key",
      zone: "eu-west-2a",
      labels: {},
    }),
    "data",
    target,
    none,
  );
  assertEquals(r.globalArguments, { name: "data", location: "fsn1", size: 10 });
  assert(r.losses.some((l) => l.includes("below Hetzner's minimum")));
  assert(r.losses.some((l) => l.includes("HDD")));
  assert(r.losses.some((l) => l.includes("IOPS")));
  assert(r.decisions.some((d) => d.includes("customer-managed key")));
  assertEquals(r.expected, {
    sizeGiB: 10,
    media: "ssd",
    encryption: "none",
    labels: {},
  });

  const huge = kind("block-volume").render(
    awsResource("block-volume", {
      sizeGiB: 20000,
      media: "ssd",
      encryption: "none",
      labels: {},
    }),
    "big",
    target,
    none,
  );
  assert(huge.decisions.some((d) => d.includes("maximum")));
  assertEquals(huge.globalArguments.size, undefined);
});

Deno.test("load-balancer: normalise a Hetzner load balancer", () => {
  const lb = kind("load-balancer").normalise(
    {
      id: 31,
      name: "front",
      public_net: { enabled: true },
      private_net: [{ network: 4242, ip: "10.0.0.5" }],
      location: { name: "hel1" },
      services: [
        { protocol: "http", listen_port: 80, destination_port: 8080 },
        { protocol: "tcp", listen_port: 5432, destination_port: 5432 },
      ],
      targets: [{ type: "server", server: { id: 1001 } }, {
        type: "label_selector",
      }],
      labels: {},
    },
    "lb",
    null,
  );
  assertEquals(lb.properties, {
    scheme: "internet",
    layer: "application",
    listeners: [{ protocol: "http", port: 80 }, {
      protocol: "tcp",
      port: 5432,
    }],
    labels: {},
  });
  assertEquals(lb.refs.map((r) => `${r.kind}:${r.nativeId}`), [
    "network:4242",
    "vm:1001",
  ]);
  assertEquals(lb.region, "hel1");
});

Deno.test("load-balancer: render turns L7 into TCP and drops UDP", () => {
  const r = kind("load-balancer").render(
    awsResource("load-balancer", {
      scheme: "internal",
      layer: "application",
      listeners: [
        { protocol: "https", port: 443 },
        { protocol: "udp", port: 53 },
        { protocol: "tcp", port: 5432 },
      ],
      labels: {},
    }),
    "front",
    target,
    fakeContext({ network: ["aws:network:v"], vm: ["aws:vm:a", "aws:vm:b"] }, [
      "aws:vm:b",
    ]),
  );
  const g = r.globalArguments;
  assertEquals(g.load_balancer_type, "lb11");
  assertEquals(g.location, "fsn1");
  assertEquals(g.public_interface, false);
  assertEquals(g.network, "${{ ref(aws:network:v) }}");
  assertEquals(
    (g.services as { listen_port: number }[]).map((s) => s.listen_port),
    [443, 5432],
  );
  assertEquals(g.targets, [{
    type: "server",
    server: { id: "${{ ref(aws:vm:a) }}" },
  }]);
  assert(
    r.losses.some((l) =>
      l.includes("https listener on port 443 becomes plain TCP")
    ),
  );
  assert(r.losses.some((l) => l.includes("UDP listener")));
  assert(r.decisions.some((d) => d.includes("aws:vm:b")));
  assertEquals(r.expected, {
    scheme: "internal",
    layer: "network",
    listeners: [{ protocol: "tcp", port: 443 }, {
      protocol: "tcp",
      port: 5432,
    }],
    labels: {},
  });
});

Deno.test("load-balancer: too many services is a decision", () => {
  const listeners = Array.from(
    { length: 31 },
    (_, i) => ({ protocol: "tcp", port: 1000 + i }),
  );
  const r = kind("load-balancer").render(
    awsResource("load-balancer", {
      scheme: "internet",
      layer: "network",
      listeners,
      labels: {},
    }),
    "wide",
    target,
    none,
  );
  assert(r.decisions.some((d) => d.includes("lb31")));
  assertEquals(r.globalArguments.load_balancer_type, undefined);
});

Deno.test("dns-zone: normalise both state shapes and render", () => {
  const nested = kind("dns-zone").normalise(
    {
      id: 55,
      zone: {
        id: 55,
        name: "example.com",
        mode: "primary",
        labels: { a: "b" },
      },
    },
    "zone",
    null,
  );
  const flat = kind("dns-zone").normalise(
    { id: 55, name: "example.com", labels: { a: "b" } },
    "zone",
    null,
  );
  assertEquals(nested.properties, {
    domain: "example.com",
    private: false,
    labels: { a: "b" },
  });
  assertEquals(flat.properties, nested.properties);
  assertEquals(nested.id, "hetzner:dns-zone:55");

  const r = kind("dns-zone").render(
    awsResource("dns-zone", {
      domain: "Example.org",
      private: false,
      labels: { team: "x" },
    }, "z"),
    "z-migrated",
    target,
    none,
  );
  assertEquals(r.globalArguments, {
    name: "example.org",
    mode: "primary",
    labels: { team: "x" },
  });
  assertEquals(r.decisions, []);
  assert(r.losses.some((l) => l.includes("records are not read")));
  assertEquals(r.expected, {
    domain: "example.org",
    private: false,
    labels: { team: "x" },
  });
});

Deno.test("dns-zone: private zones and subdomains are decisions", () => {
  const r = kind("dns-zone").render(
    awsResource("dns-zone", {
      domain: "internal.corp.example.com",
      private: true,
      labels: {},
    }),
    "z",
    target,
    none,
  );
  assertEquals(r.decisions.length, 2);
  assertStringIncludes(r.decisions.join(" "), "subdomain");
  assertStringIncludes(r.decisions.join(" "), "private");
  const co = kind("dns-zone").render(
    awsResource("dns-zone", {
      domain: "example.co.uk",
      private: false,
      labels: {},
    }),
    "z",
    target,
    none,
  );
  assertEquals(co.decisions, []);
});

Deno.test("names: networks, firewalls and load balancers", () => {
  assertEquals(kind("network").validateName("app-net"), []);
  assert(kind("firewall").validateName("").length > 0);
  assert(kind("load-balancer").validateName(" padded").length > 0);
  assert(kind("block-volume").validateName("bad name").length > 0);
  assertEquals(kind("dns-zone").validateName("example.com"), []);
  assert(kind("dns-zone").validateName("Example.com.").length > 0);
});

Deno.test("server types: replaced generations size source servers but are never chosen", () => {
  const old = SERVER_TYPES.filter((t) => t.deprecated).map((t) => t.name);
  assert(old.includes("cx22") && old.includes("cpx11"));
  for (const [v, m] of [[1, 1024], [2, 2048], [3, 4096], [16, 32768]]) {
    const pick = chooseServerType(v, m, "x86_64", "fsn1");
    assert(
      pick && !pick.deprecated,
      `${v} vCPU / ${m} MiB chose ${pick?.name}`,
    );
  }
  assertEquals(chooseServerType(1, 2048, "x86_64", "ash")?.name, "cpx12");
});

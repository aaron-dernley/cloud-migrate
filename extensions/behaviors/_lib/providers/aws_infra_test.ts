// Run with `deno test -A`. No cloud is touched: fixtures are shaped like the
// `state` data @swamp/aws/{ec2,elasticloadbalancingv2,route53,eks}/* write.
// Ids, names and addresses are made up.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type {
  CanonicalResource,
  RenderContext,
  TargetSettings,
} from "../adapter.ts";
import type { ResourceKind } from "../kinds.ts";
import {
  awsInfraKinds,
  INSTANCE_TYPES,
  smallestInstanceType,
} from "./aws_infra.ts";

const TARGET: TargetSettings = { provider: "aws", region: "eu-west-2" };

/** A fake RenderContext: `deps` lists dependency ids by kind; refTo echoes a recognisable CEL string. */
function ctx(
  deps: Partial<Record<ResourceKind, string[]>> = {},
): RenderContext {
  const known = new Set(Object.values(deps).flat());
  return {
    refTo: (id, field) =>
      known.has(id) ? `\${{ ref("${id}", "${field ?? "default"}") }}` : null,
    dependencies: (kind) => deps[kind] ?? [],
    targetNameOf: (id) => known.has(id) ? `t-${id}` : null,
  };
}

/** A canonical resource built by hand, as another provider's adapter would produce. */
function foreign(
  kind: ResourceKind,
  provider: string,
  properties: Record<string, unknown>,
  name = "thing",
): CanonicalResource {
  return {
    id: `${provider}:${kind}:${name}`,
    provider,
    kind,
    nativeId: name,
    aliases: [],
    name,
    region: "europe-west2",
    source: { behaviorType: "x", behaviorName: "x" },
    properties,
    refs: [],
    dependsOn: [],
    dataBytes: null,
    unknownFields: [],
  };
}

const k = awsInfraKinds;

Deno.test("every infra kind is registered with its behavior type and id field", () => {
  const expected: Record<string, [string, string]> = {
    network: ["@swamp/aws/ec2/vpc", "VpcId"],
    subnet: ["@swamp/aws/ec2/subnet", "SubnetId"],
    firewall: ["@swamp/aws/ec2/security-group", "GroupId"],
    vm: ["@swamp/aws/ec2/instance", "InstanceId"],
    "block-volume": ["@swamp/aws/ec2/volume", "VolumeId"],
    "load-balancer": [
      "@swamp/aws/elasticloadbalancingv2/load-balancer",
      "LoadBalancerArn",
    ],
    "dns-zone": ["@swamp/aws/route53/hosted-zone", "Id"],
    "dns-record": ["@swamp/aws/route53/record-set", "Name"],
    "kubernetes-cluster": ["@swamp/aws/eks/cluster", "Name"],
  };
  for (const [kind, [type, id]] of Object.entries(expected)) {
    assertEquals(k[kind as ResourceKind]?.behaviorType, type);
    assertEquals(k[kind as ResourceKind]?.idField, id);
  }
});

Deno.test("network: normalise and render", () => {
  const r = k.network!.normalise(
    {
      VpcId: "vpc-0aaa",
      CidrBlock: "10.0.0.0/16",
      Tags: [{ Key: "Name", Value: "main" }, { Key: "Team", Value: "web" }],
    },
    "vpcs",
    "eu-west-2",
  );
  assertEquals(r.id, "aws:network:vpc-0aaa");
  assertEquals(r.name, "main");
  assertEquals(r.properties, {
    cidr: "10.0.0.0/16",
    labels: { Name: "main", Team: "web" },
  });
  assertEquals(r.unknownFields, []);

  const out = k.network!.render(r, "main-copy", TARGET, ctx());
  assertEquals(out.globalArguments.CidrBlock, "10.0.0.0/16");
  assertEquals(out.globalArguments.region, "eu-west-2");
  assertEquals(out.globalArguments.Tags, [{ Key: "Name", Value: "main" }, {
    Key: "Team",
    Value: "web",
  }]);
  assertEquals(out.decisions, []);

  // GCP custom-mode network: no CIDR to carry, and aws: tags are reserved.
  const gcp = foreign("network", "gcp", {
    cidr: null,
    labels: { "aws:x": "1", env: "dev" },
  });
  const g = k.network!.render(gcp, "n", TARGET, ctx());
  assertEquals(g.decisions.length, 1);
  assertEquals(g.globalArguments.CidrBlock, undefined);
  assertEquals(g.globalArguments.Tags, [{ Key: "env", Value: "dev" }]);
  assert(g.losses.some((l) => l.includes("aws:")));
  assertEquals(g.expected.labels, { env: "dev" });
});

Deno.test("subnet: refs the vpc, wires VpcId, picks a zone with a loss", () => {
  const r = k.subnet!.normalise(
    {
      SubnetId: "subnet-0bbb",
      VpcId: "vpc-0aaa",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "eu-west-2b",
      MapPublicIpOnLaunch: true,
    },
    "subnets",
    null,
  );
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.refs, [{
    kind: "network",
    nativeId: "vpc-0aaa",
    via: "VpcId",
  }]);
  assertEquals(r.properties.zone, "eu-west-2b");

  // Same region keeps the zone.
  const same = k.subnet!.render(
    r,
    "s",
    TARGET,
    ctx({ network: ["aws:network:vpc-0aaa"] }),
  );
  assertEquals(same.globalArguments.AvailabilityZone, "eu-west-2b");
  assertEquals(
    same.globalArguments.VpcId,
    '${{ ref("aws:network:vpc-0aaa", "default") }}',
  );
  assertEquals(same.losses, []);

  // A regional GCP subnet has no zone: eu-west-2a plus a loss; and no network is a decision.
  const gcp = foreign("subnet", "gcp", {
    cidr: "10.1.0.0/24",
    zone: null,
    publicIpOnLaunch: null,
    labels: {},
  });
  const out = k.subnet!.render(gcp, "s", TARGET, ctx());
  assertEquals(out.globalArguments.AvailabilityZone, "eu-west-2a");
  assert(out.losses.some((l) => l.includes("eu-west-2a")));
  assertEquals(out.decisions.length, 1);
  assertEquals(out.expected.zone, "eu-west-2a");
});

Deno.test("firewall: cidr rules become canonical, group rules are noted", () => {
  const r = k.firewall!.normalise(
    {
      GroupId: "sg-0ccc",
      GroupName: "web",
      GroupDescription: "web tier",
      VpcId: "vpc-0aaa",
      SecurityGroupIngress: [
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIpv6: "::/0" },
        {
          IpProtocol: "tcp",
          FromPort: 8000,
          ToPort: 8080,
          CidrIp: "10.0.0.0/8",
        },
        {
          IpProtocol: "tcp",
          FromPort: 5432,
          ToPort: 5432,
          SourceSecurityGroupId: "sg-0ddd",
        },
      ],
      SecurityGroupEgress: [{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }],
    },
    "sgs",
    "eu-west-2",
  );
  assertEquals(r.nativeId, "sg-0ccc");
  assertEquals(r.properties.rules, [
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "443",
      cidrs: ["0.0.0.0/0", "::/0"],
    },
    {
      direction: "ingress",
      protocol: "tcp",
      ports: "8000-8080",
      cidrs: ["10.0.0.0/8"],
    },
    { direction: "egress", protocol: "all", ports: null, cidrs: ["0.0.0.0/0"] },
  ]);
  assertEquals(r.properties.otherRules, [
    "ingress tcp 5432 from security group sg-0ddd",
  ]);

  const out = k.firewall!.render(
    r,
    "web-copy",
    TARGET,
    ctx({ network: ["aws:network:vpc-0aaa"] }),
  );
  const g = out.globalArguments;
  assertEquals(g.GroupName, "web-copy");
  assertEquals(g.GroupDescription, "web tier");
  assertEquals(g.SecurityGroupIngress, [
    { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
    { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIpv6: "::/0" },
    { IpProtocol: "tcp", FromPort: 8000, ToPort: 8080, CidrIp: "10.0.0.0/8" },
  ]);
  assertEquals(g.SecurityGroupEgress, [{
    IpProtocol: "-1",
    CidrIp: "0.0.0.0/0",
  }]);
  assertEquals(out.decisions.length, 1);
  assert(out.decisions[0].includes("sg-0ddd"));
});

Deno.test("firewall: render from a foreign provider drops what AWS lacks", () => {
  const src = foreign("firewall", "gcp", {
    description: null,
    rules: [
      {
        direction: "ingress",
        protocol: "icmp",
        ports: null,
        cidrs: ["10.0.0.0/8"],
      },
      {
        direction: "ingress",
        protocol: "sctp",
        ports: "9",
        cidrs: ["10.0.0.0/8"],
      },
      {
        direction: "ingress",
        protocol: "udp",
        ports: null,
        cidrs: ["10.0.0.0/8"],
      },
    ],
    labels: {},
  });
  const out = k.firewall!.render(src, "fw", TARGET, ctx());
  assertEquals(out.globalArguments.GroupDescription, "fw");
  assertEquals(out.globalArguments.SecurityGroupIngress, [
    { IpProtocol: "icmp", FromPort: -1, ToPort: -1, CidrIp: "10.0.0.0/8" },
    { IpProtocol: "udp", FromPort: 0, ToPort: 65535, CidrIp: "10.0.0.0/8" },
  ]);
  assert(out.losses.some((l) => l.includes("sctp")));
  assert(out.losses.some((l) => l.includes("allow-all egress")));
  assert(out.decisions.some((d) => d.includes("VpcId")));
  // The target will show the default egress rule.
  assertEquals((out.expected.rules as unknown[]).length, 3);
  assertEquals(k.firewall!.validateName("sg-abc").length, 1);
  assertEquals(k.firewall!.validateName("web-tier"), []);
});

Deno.test("vm: normalise fills sizing from the table and refs dependencies", () => {
  const r = k.vm!.normalise(
    {
      InstanceId: "i-0eee",
      InstanceType: "m7g.xlarge",
      ImageId: "ami-0fff",
      SubnetId: "subnet-0bbb",
      SecurityGroupIds: ["sg-0ccc"],
      IamInstanceProfile: "app-profile",
      AvailabilityZone: "eu-west-2a",
      PublicIp: "203.0.113.7",
      PrivateIpAddress: "10.0.1.5",
      Volumes: [{ VolumeId: "vol-0123", Device: "/dev/sdf" }],
      BlockDeviceMappings: [{
        DeviceName: "/dev/xvda",
        Ebs: { VolumeSize: 30 },
      }],
      Tags: [{ Key: "Name", Value: "app-1" }],
    },
    "instances",
    null,
  );
  assertEquals(r.name, "app-1");
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.properties.vcpus, 4);
  assertEquals(r.properties.memoryMiB, 16384);
  assertEquals(r.properties.architecture, "arm64");
  assertEquals(r.properties.publicIp, true);
  assertEquals(r.properties.bootDiskGiB, 30);
  assertEquals(r.refs.map((x) => `${x.kind}:${x.nativeId}`).sort(), [
    "block-volume:vol-0123",
    "firewall:sg-0ccc",
    "iam-principal:app-profile",
    "subnet:subnet-0bbb",
  ]);

  // Unknown type: sizing unknown and tracked; architecture guessed from the family.
  const odd = k.vm!.normalise(
    { InstanceId: "i-1", InstanceType: "x2gd.large" },
    "i",
    "eu-west-2",
  );
  assertEquals(odd.properties.architecture, "arm64");
  assert(odd.unknownFields.includes("vcpus"));
  assert(odd.unknownFields.includes("image"));
});

Deno.test("vm: render from aws keeps the type and wires refs", () => {
  const r = k.vm!.normalise(
    {
      InstanceId: "i-0eee",
      InstanceType: "t3.small",
      ImageId: "ami-0fff",
      PublicIp: "203.0.113.7",
      AvailabilityZone: "eu-west-2a",
    },
    "instances",
    null,
  );
  const out = k.vm!.render(
    r,
    "app",
    TARGET,
    ctx({ subnet: ["s1"], firewall: ["f1", "f2"], "block-volume": ["v1"] }),
  );
  const g = out.globalArguments;
  assertEquals(g.InstanceType, "t3.small");
  assertEquals(g.ImageId, "ami-0fff");
  assertEquals(g.NetworkInterfaces, [{
    DeviceIndex: "0",
    AssociatePublicIpAddress: true,
    SubnetId: '${{ ref("s1", "default") }}',
    GroupSet: ['${{ ref("f1", "default") }}', '${{ ref("f2", "default") }}'],
  }]);
  assertEquals(g.Volumes, [{
    VolumeId: '${{ ref("v1", "default") }}',
    Device: "/dev/sdf",
  }]);
  assertEquals(out.decisions, []);
  assertEquals(out.expected.publicIp, true);
});

Deno.test("vm: render from another cloud picks the smallest fit and asks for an image", () => {
  const src = foreign("vm", "gcp", {
    machineType: "e2-standard-4",
    vcpus: 3,
    memoryMiB: 12288,
    architecture: "x86_64",
    image: "debian-12",
    publicIp: false,
    bootDiskGiB: 20,
    labels: { env: "prod" },
  });
  const out = k.vm!.render(src, "vm", TARGET, ctx({ subnet: ["s1"] }));
  // 4 vCPU / 16 GiB: t3.xlarge and m6i.xlarge tie; steady-performance wins.
  assertEquals(out.globalArguments.InstanceType, "m6i.xlarge");
  assert(out.losses.some((l) => l.includes("m6i.xlarge")));
  assertEquals(out.globalArguments.ImageId, "<choose-an-ami-in-eu-west-2>");
  assert(out.decisions.some((d) => d.includes("debian-12")));
  assert(out.decisions.some((d) => d.includes("BlockDeviceMappings")));
  assertEquals(out.expected.vcpus, 4);
  assertEquals(out.expected.memoryMiB, 16384);
  assertEquals(out.expected.publicIp, false);
  assertEquals(
    (out.globalArguments.NetworkInterfaces as {
      AssociatePublicIpAddress: boolean;
    }[])[0]
      .AssociatePublicIpAddress,
    false,
  );

  // Nothing is big enough: a decision, no InstanceType.
  const huge = foreign("vm", "gcp", {
    vcpus: 96,
    memoryMiB: 1_000_000,
    architecture: "arm64",
  });
  const h = k.vm!.render(huge, "vm", TARGET, ctx());
  assertEquals(h.globalArguments.InstanceType, undefined);
  assert(h.decisions.some((d) => d.includes("no common arm64")));
});

Deno.test("instance type table: sizing is consistent", () => {
  assertEquals(INSTANCE_TYPES["c6i.large"], {
    vcpus: 2,
    memoryMiB: 4096,
    architecture: "x86_64",
  });
  assertEquals(INSTANCE_TYPES["r7g.2xlarge"], {
    vcpus: 8,
    memoryMiB: 65536,
    architecture: "arm64",
  });
  assertEquals(smallestInstanceType(2, 1024, "arm64"), "t4g.micro");
  assertEquals(smallestInstanceType(2, 12000, "x86_64"), "r6i.large");
});

Deno.test("block-volume: normalise and render, with kms and zone handling", () => {
  const r = k["block-volume"]!.normalise(
    {
      VolumeId: "vol-0123",
      Size: 100,
      VolumeType: "io2",
      Iops: 20000,
      Encrypted: true,
      KmsKeyId: "arn:aws:kms:eu-west-2:111122223333:key/abcd",
      AvailabilityZone: "eu-west-2c",
    },
    "vols",
    null,
  );
  assertEquals(r.properties.media, "ssd");
  assertEquals(r.properties.encryption, "customer-key");
  assertEquals(r.refs, [{
    kind: "kms-key",
    nativeId: "arn:aws:kms:eu-west-2:111122223333:key/abcd",
    via: "KmsKeyId",
  }]);

  const out = k["block-volume"]!.render(
    r,
    "data",
    TARGET,
    ctx({ "kms-key": ["k1"] }),
  );
  assertEquals(out.globalArguments.VolumeType, "io2");
  assertEquals(out.globalArguments.Iops, 20000);
  assertEquals(out.globalArguments.KmsKeyId, '${{ ref("k1", "default") }}');
  assertEquals(out.globalArguments.AvailabilityZone, "eu-west-2c");

  // From a foreign cloud: small hdd, customer key but no migrated key.
  const src = foreign("block-volume", "gcp", {
    sizeGiB: 50,
    media: "hdd",
    iops: null,
    encryption: "customer-key",
    zone: "europe-west2-a",
    labels: {},
  });
  const f = k["block-volume"]!.render(src, "data", TARGET, ctx());
  assertEquals(f.globalArguments.VolumeType, "standard");
  assertEquals(f.globalArguments.AvailabilityZone, "eu-west-2a");
  assert(f.losses.some((l) => l.includes("eu-west-2a")));
  assert(f.decisions.some((d) => d.includes("KmsKeyId")));
  assertEquals(f.expected.encryption, null);
});

Deno.test("load-balancer: normalise and render", () => {
  const arn =
    "arn:aws:elasticloadbalancing:eu-west-2:111122223333:loadbalancer/app/web/50dc6c495c0c9188";
  const r = k["load-balancer"]!.normalise(
    {
      LoadBalancerArn: arn,
      Name: "web",
      Type: "application",
      Scheme: "internet-facing",
      Subnets: ["subnet-0bbb", "subnet-0ccc"],
      SecurityGroups: ["sg-0ccc"],
    },
    "lbs",
    null,
  );
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.aliases, ["web"]);
  assertEquals(r.properties.scheme, "internet");
  assertEquals(r.properties.layer, "application");
  assertEquals(r.refs.length, 3);

  const out = k["load-balancer"]!.render(
    r,
    "web2",
    TARGET,
    ctx({ subnet: ["s1", "s2"], firewall: ["f1"] }),
  );
  assertEquals(out.globalArguments.Scheme, "internet-facing");
  assertEquals(out.globalArguments.Type, "application");
  assertEquals((out.globalArguments.Subnets as string[]).length, 2);
  assertEquals(out.globalArguments.SecurityGroups, [
    '${{ ref("f1", "default") }}',
  ]);
  assertEquals(out.decisions, []);

  // Foreign network LB with one subnet and no groups; layer and name rules.
  const f = k["load-balancer"]!.render(
    foreign("load-balancer", "gcp", {
      scheme: "internal",
      layer: "application",
      listeners: [{ protocol: "HTTP", port: 80 }],
      labels: {},
    }),
    "lb",
    TARGET,
    ctx({ subnet: ["s1"] }),
  );
  assertEquals(f.globalArguments.Scheme, "internal");
  assert(f.decisions.some((d) => d.includes("two availability zones")));
  assert(f.decisions.some((d) => d.includes("SecurityGroups")));
  assert(f.losses.some((l) => l.includes("HTTP:80")));
  assertEquals(k["load-balancer"]!.validateName("internal-x").length, 1);
  assertEquals(k["load-balancer"]!.validateName("a".repeat(33)).length, 1);
  assertEquals(k["load-balancer"]!.validateName("web-1"), []);
});

Deno.test("dns-zone: domain without dot, private zones wire VPCs", () => {
  const pub = k["dns-zone"]!.normalise(
    {
      Id: "Z0EXAMPLE",
      Name: "example.com.",
      HostedZoneTags: [{ Key: "Team", Value: "web" }],
    },
    "zones",
    "us-east-1",
  );
  // No VPCs listed: public or just left out of the record, so unknown.
  assertEquals(pub.properties, {
    domain: "example.com",
    private: null,
    labels: { Team: "web" },
  });
  assertEquals(pub.unknownFields, ["private"]);
  assertEquals(pub.aliases, ["/hostedzone/Z0EXAMPLE", "example.com"]);
  const out = k["dns-zone"]!.render(pub, "ignored", TARGET, ctx());
  assertEquals(out.globalArguments.Name, "example.com.");
  assertEquals(out.globalArguments.HostedZoneTags, [{
    Key: "Team",
    Value: "web",
  }]);
  assert(out.decisions.some((d) => d.includes("name servers")));

  const priv = foreign("dns-zone", "gcp", {
    domain: "corp.internal",
    private: true,
    labels: {},
  });
  const none = k["dns-zone"]!.render(priv, "z", TARGET, ctx());
  assert(none.decisions.some((d) => d.includes("VPCs")));
  const wired = k["dns-zone"]!.render(
    priv,
    "z",
    TARGET,
    ctx({ network: ["n1"] }),
  );
  assertEquals(wired.globalArguments.VPCs, [{
    VPCId: '${{ ref("n1", "default") }}',
    VPCRegion: "eu-west-2",
  }]);
  assertEquals(wired.decisions, []);
});

Deno.test("dns-record: dots are normalised both ways", () => {
  const r = k["dns-record"]!.normalise(
    {
      HostedZoneId: "Z0EXAMPLE",
      Name: "www.example.com.",
      Type: "CNAME",
      TTL: "300",
      ResourceRecords: ["lb.example.net."],
    },
    "records",
    "us-east-1",
  );
  assertEquals(r.properties.name, "www.example.com");
  assertEquals(r.properties.ttl, 300);
  assertEquals(r.properties.values, ["lb.example.net"]);
  assertEquals(r.refs, [{
    kind: "dns-zone",
    nativeId: "Z0EXAMPLE",
    via: "HostedZoneId",
  }]);

  const out = k["dns-record"]!.render(
    r,
    "r",
    TARGET,
    ctx({ "dns-zone": ["z1"] }),
  );
  assertEquals(out.globalArguments.Name, "www.example.com.");
  assertEquals(out.globalArguments.HostedZoneId, '${{ ref("z1", "default") }}');
  assertEquals(out.globalArguments.ResourceRecords, ["lb.example.net."]);
  assertEquals(out.globalArguments.TTL, "300");
  assertEquals(out.decisions, []);

  // MX targets the last field; a foreign record with no TTL gets 300 plus a loss.
  const mx = foreign("dns-record", "gcp", {
    name: "example.com",
    type: "MX",
    ttl: null,
    values: ["10 mail.example.com"],
  });
  const m = k["dns-record"]!.render(mx, "r", TARGET, ctx());
  assertEquals(m.globalArguments.ResourceRecords, ["10 mail.example.com."]);
  assert(m.losses.some((l) => l.includes("300")));
  assert(m.decisions.some((d) => d.includes("HostedZoneId")));
});

Deno.test("dns-record: alias and routing policies are not silently dropped", () => {
  const r = k["dns-record"]!.normalise(
    {
      HostedZoneId: "Z0EXAMPLE",
      Name: "app.example.com.",
      Type: "A",
      SetIdentifier: "blue",
      Weight: 10,
      AliasTarget: {
        HostedZoneId: "Z2",
        DNSName: "lb.eu-west-2.elb.amazonaws.com.",
        EvaluateTargetHealth: false,
      },
    },
    "records",
    null,
  );
  assertEquals(r.properties.alias, true);
  assertEquals(r.properties.routingPolicy, "weighted");
  assertEquals(r.properties.values, ["lb.eu-west-2.elb.amazonaws.com"]);
  const out = k["dns-record"]!.render(
    r,
    "r",
    TARGET,
    ctx({ "dns-zone": ["z1"] }),
  );
  assert(out.decisions.some((d) => d.includes("alias record")));
  assert(out.losses.some((l) => l.includes("weighted")));
  assertEquals(out.globalArguments.ResourceRecords, undefined);
});

Deno.test("kubernetes-cluster: normalise and render", () => {
  const r = k["kubernetes-cluster"]!.normalise(
    {
      Name: "prod",
      Arn: "arn:aws:eks:eu-west-2:111122223333:cluster/prod",
      Version: "1.30",
      RoleArn: "arn:aws:iam::111122223333:role/eks-cluster",
      ResourcesVpcConfig: {
        SubnetIds: ["subnet-0bbb", "subnet-0ccc"],
        EndpointPrivateAccess: true,
        EndpointPublicAccess: false,
      },
      EncryptionConfig: [{
        Provider: { KeyArn: "arn:aws:kms:eu-west-2:111122223333:key/abcd" },
        Resources: ["secrets"],
      }],
    },
    "clusters",
    null,
  );
  assertEquals(r.region, "eu-west-2");
  assertEquals(r.aliases, ["arn:aws:eks:eu-west-2:111122223333:cluster/prod"]);
  assertEquals(r.properties.privateEndpoint, true);
  assertEquals(r.refs.map((x) => x.kind).sort(), [
    "iam-principal",
    "subnet",
    "subnet",
  ]);

  const out = k["kubernetes-cluster"]!.render(
    r,
    "prod2",
    TARGET,
    ctx({ subnet: ["s1", "s2"], "iam-principal": ["role1"] }),
  );
  const g = out.globalArguments;
  assertEquals(g.Name, "prod2");
  assertEquals(g.Version, "1.30");
  assertEquals(g.RoleArn, '${{ ref("role1", "Arn") }}');
  assertEquals(
    (g.ResourcesVpcConfig as Record<string, unknown>).EndpointPublicAccess,
    false,
  );
  assertEquals(
    (g.ResourcesVpcConfig as { SubnetIds: string[] }).SubnetIds.length,
    2,
  );
  assert(out.losses.some((l) => l.includes("EncryptionConfig")));
  assertEquals(out.decisions, []);
  assertEquals(out.expected.privateEndpoint, true);

  // From GKE: patch version trimmed with a loss; missing subnets and role are decisions.
  const gke = foreign("kubernetes-cluster", "gcp", {
    version: "1.29.4-gke.1000",
    nodeCount: 3,
    privateEndpoint: null,
    labels: {},
  });
  const f = k["kubernetes-cluster"]!.render(gke, "c", TARGET, ctx());
  assertEquals(f.globalArguments.Version, "1.29");
  assert(f.losses.some((l) => l.includes("1.29.4-gke.1000")));
  assert(f.decisions.some((d) => d.includes("SubnetIds")));
  assert(f.decisions.some((d) => d.includes("RoleArn")));
  const bad = k["kubernetes-cluster"]!.render(
    foreign("kubernetes-cluster", "do", { version: "2.0", labels: {} }),
    "c",
    TARGET,
    ctx(),
  );
  assert(bad.decisions.some((d) => d.includes("EKS")));
  assertEquals(k["kubernetes-cluster"]!.validateName("-bad").length, 1);
  assertEquals(k["kubernetes-cluster"]!.validateName("prod_1"), []);
});

Deno.test("rendered global arguments never carry credentials or read-only outputs", () => {
  const forbidden = [
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "Arn",
    "VpcId_out",
    "DNSName",
  ];
  const samples = [
    k.network!.render(
      foreign("network", "gcp", { cidr: "10.0.0.0/16", labels: {} }),
      "n",
      TARGET,
      ctx(),
    ),
    k.vm!.render(
      foreign("vm", "gcp", {
        vcpus: 2,
        memoryMiB: 2048,
        architecture: "x86_64",
        labels: {},
      }),
      "v",
      TARGET,
      ctx(),
    ),
    k["kubernetes-cluster"]!.render(
      foreign("kubernetes-cluster", "gcp", { version: "1.30", labels: {} }),
      "c",
      TARGET,
      ctx(),
    ),
  ];
  for (const s of samples) {
    for (const key of forbidden) assertEquals(key in s.globalArguments, false);
  }
});

Deno.test("every render sets the required `name` global argument", () => {
  for (const [kind, adapter] of Object.entries(awsInfraKinds)) {
    // The EKS schema has no `name`; its cluster name is `Name`.
    if (kind === "kubernetes-cluster") continue;
    const out = adapter!.render(
      foreign(kind as ResourceKind, "gcp", {}),
      "tgt-name",
      TARGET,
      ctx(),
    );
    assertEquals(out.globalArguments.name, "tgt-name", kind);
  }
});

Deno.test("firewall: a type/code-specific ICMP rule is widened with a loss", () => {
  const r = k.firewall!.normalise(
    {
      GroupId: "sg-0a",
      GroupDescription: "d",
      SecurityGroupIngress: [
        { IpProtocol: "icmp", FromPort: 8, ToPort: 0, CidrIp: "10.0.0.0/8" },
        { IpProtocol: "icmp", FromPort: -1, ToPort: -1, CidrIp: "10.1.0.0/16" },
      ],
    },
    "fw",
    "eu-west-2",
  );
  const out = k.firewall!.render(r, "fw", TARGET, ctx());
  const widened = out.losses.filter((l) => l.includes("widened"));
  assertEquals(widened.length, 1);
  assert(widened[0].includes("type 8 code 0"));
});

Deno.test("firewall: render survives non-string ports and drops them with a loss", () => {
  const src = foreign("firewall", "gcp", {
    rules: [
      {
        direction: "ingress",
        protocol: "tcp",
        ports: 22,
        cidrs: ["0.0.0.0/0"],
      },
      {
        direction: "ingress",
        protocol: "tcp",
        ports: {},
        cidrs: ["0.0.0.0/0"],
      },
    ],
    labels: {},
  });
  const out = k.firewall!.render(src, "fw", TARGET, ctx());
  assertEquals(
    (out.globalArguments.SecurityGroupIngress as { FromPort: number }[]).map(
      (e) => e.FromPort,
    ),
    [22],
  );
  assert(out.losses.some((l) => l.includes("not a port or range")));
});

Deno.test("load-balancer: null listeners entries do not crash render", () => {
  const src = foreign("load-balancer", "gcp", {
    scheme: "internet",
    layer: "application",
    listeners: [null, { protocol: "HTTP", port: 80 }],
    labels: {},
  });
  const out = k["load-balancer"]!.render(src, "lb", TARGET, ctx());
  assert(out.losses.some((l) => l.includes("HTTP:80")));
});

Deno.test("dns-record: SOA and apex NS records are left to Route 53", () => {
  const rec = (a: Record<string, unknown>) =>
    k["dns-record"]!.normalise(
      {
        HostedZoneId: "Z1",
        HostedZoneName: "example.com.",
        TTL: 300,
        ...a,
      },
      "r",
      "eu-west-2",
    );
  const managed = "Route 53 manages this record; leave it out of the migration";
  const soa = rec({
    Name: "example.com.",
    Type: "SOA",
    ResourceRecords: [
      "ns-1.awsdns-01.org. hostmaster. 1 7200 900 1209600 86400",
    ],
  });
  assert(
    k["dns-record"]!.render(soa, "r", TARGET, ctx()).decisions.includes(
      managed,
    ),
  );
  const apexNs = rec({
    Name: "example.com.",
    Type: "NS",
    ResourceRecords: ["ns-1.awsdns-01.org."],
  });
  assert(
    k["dns-record"]!.render(apexNs, "r", TARGET, ctx()).decisions.includes(
      managed,
    ),
  );
  // A delegation below the apex is an ordinary record.
  const sub = rec({
    Name: "dev.example.com.",
    Type: "NS",
    ResourceRecords: ["ns-9.example.net."],
  });
  assert(
    !k["dns-record"]!.render(sub, "r", TARGET, ctx()).decisions.includes(
      managed,
    ),
  );
});

Deno.test("kubernetes-cluster: no subnets means no ResourcesVpcConfig", () => {
  const src = foreign("kubernetes-cluster", "gcp", {
    version: "1.30",
    privateEndpoint: true,
    labels: {},
  });
  const out = k["kubernetes-cluster"]!.render(src, "c", TARGET, ctx());
  assertEquals("ResourcesVpcConfig" in out.globalArguments, false);
  assert(out.decisions.some((d) => d.includes("SubnetIds")));
});

Deno.test("block-volume: an AWS-managed key alias is provider-managed, not a ref", () => {
  const r = k["block-volume"]!.normalise(
    {
      VolumeId: "vol-1",
      Size: 8,
      VolumeType: "gp3",
      Encrypted: true,
      KmsKeyId: "arn:aws:kms:eu-west-2:111122223333:alias/aws/ebs",
      AvailabilityZone: "eu-west-2a",
    },
    "v",
    null,
  );
  assertEquals(r.properties.encryption, "provider-managed");
  assertEquals(r.refs, []);
  // A key ARN cannot be told from a customer key: kept, with a wording that says so.
  const keyed = k["block-volume"]!.normalise(
    {
      VolumeId: "vol-2",
      Size: 8,
      Encrypted: true,
      KmsKeyId: "arn:aws:kms:eu-west-2:111122223333:key/abc",
    },
    "v",
    null,
  );
  assertEquals(keyed.refs.length, 1);
  const out = k["block-volume"]!.render(keyed, "v", TARGET, ctx());
  assert(out.decisions.some((d) => d.includes("AWS-managed")));
});

Deno.test("tags: the reserved aws: prefix is dropped with a loss", () => {
  const out = k.network!.render(
    foreign("network", "gcp", {
      cidr: "10.0.0.0/16",
      labels: { "aws:cloudformation:stack-name": "x", team: "web" },
    }),
    "n",
    TARGET,
    ctx(),
  );
  assertEquals(out.globalArguments.Tags, [{ Key: "team", Value: "web" }]);
  assert(out.losses.some((l) => l.includes("aws:")));
});

Deno.test("vm: sizing prefers a steady family over a burstable one of equal size", () => {
  // t3.large and m6i.large are both 2 vCPU / 8 GiB.
  assertEquals(smallestInstanceType(2, 8192, "x86_64"), "m6i.large");
  // A smaller burstable type still wins when it is genuinely smaller.
  assertEquals(smallestInstanceType(2, 1024, "x86_64"), "t3.micro");
});

Deno.test("dns-zone privacy: name servers mean public, VPCs mean private, neither is unknown", () => {
  const z = k["dns-zone"]!;
  const pub = z.normalise(
    { Id: "Z1", Name: "example.com.", NameServers: ["ns-1.awsdns-01.org"] },
    "z",
    "us-east-1",
  );
  assertEquals(pub.properties.private, false);
  assert(!pub.unknownFields.includes("private"));
  const priv = z.normalise(
    {
      Id: "Z2",
      Name: "corp.internal.",
      VPCs: [{ VPCId: "vpc-1", VPCRegion: "eu-west-2" }],
    },
    "z",
    null,
  );
  assertEquals(priv.properties.private, true);
  const bare = z.normalise({ Id: "Z3", Name: "x.example." }, "z", "us-east-1");
  assertEquals(bare.properties.private, null);
  assert(bare.unknownFields.includes("private"));
});

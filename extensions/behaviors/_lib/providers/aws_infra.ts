/**
 * AWS networking, compute, DNS, load balancing and Kubernetes adapters.
 * See ../kinds.ts for the canonical shapes and ../adapter.ts for the contract.
 *
 * The state attributes are Cloud Control property names of the official
 * `@swamp/aws/*` behaviors (EC2, Route 53, Elastic Load Balancing v2, EKS).
 * Render emits only schema properties that are writable at create time:
 * read-only outputs (ARNs, DNS names, states) and credentials never appear.
 *
 * @module
 */
import {
  arr,
  bool,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  labelsToTags,
  num,
  obj,
  type ProviderAdapter,
  type RenderContext,
  type ResourceRef,
  str,
  tagsToLabels,
  type TargetSettings,
  track,
} from "../adapter.ts";

// ---------------------------------------------------------------------------
// Shared helpers

/** `eu-west-2a` → `eu-west-2`; null when it does not look like an AWS zone. */
function regionFromZone(zone: string | null): string | null {
  return zone && /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/.test(zone)
    ? zone.slice(0, -1)
    : null;
}

/** The region field of an ARN (`arn:aws:eks:eu-west-2:...`), or null. */
function regionFromArn(arn: string | null): string | null {
  return str(arn?.split(":")[3]);
}

/** Resources are named by their `Name` tag when they have one, else by id. */
function nameFrom(labels: Record<string, string>, fallback: string): string {
  return labels.Name || fallback;
}

/** The ARN or id, as an alias list without nulls. */
function aliasesOf(...values: (string | null)[]): string[] {
  return values.filter((x): x is string => x !== null);
}

/**
 * A customer-managed KMS key reference, or null. An AWS-managed alias
 * (`alias/aws/ebs`, bare or inside an ARN) is not one. A bare key id or key
 * ARN cannot be told from a customer key by the record alone (AWS-managed
 * keys also read back as `key/<uuid>`), so those are kept as customer keys
 * and every render says the key may be AWS-managed.
 */
export function customKeyOf(value: unknown): string | null {
  const key = str(value);
  return key && !/(^|[:/])alias\/aws\//.test(key) ? key : null;
}

/** Labels as AWS tags, dropping the reserved `aws:` prefix (with a loss). */
export function awsTags(
  labels: Record<string, string>,
): { tags: { Key: string; Value: string }[]; losses: string[] } {
  const losses: string[] = [];
  const usable: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (k.toLowerCase().startsWith("aws:")) {
      losses.push(
        `label "${k}" is dropped (AWS reserves the "aws:" tag prefix)`,
      );
    } else usable[k] = v;
  }
  return { tags: labelsToTags(usable), losses };
}

/** The canonical labels of any provider's resource, as a string map. */
function labelsOf(p: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(p.labels) ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * The availability zone a zonal target resource lands in: the source zone
 * when it already is a zone of the target region, else `<region>a` with a
 * loss saying so.
 */
function chooseZone(
  sourceZone: unknown,
  target: TargetSettings,
  what: string,
): { zone: string; losses: string[] } {
  const z = str(sourceZone);
  if (z && regionFromZone(z) === target.region) return { zone: z, losses: [] };
  const zone = `${target.region}a`;
  const from = z
    ? `source zone "${z}" does not exist in ${target.region}`
    : "source has no zone";
  return {
    zone,
    losses: [
      `${what} is placed in availability zone ${zone} (${from}); spread across zones by hand if needed`,
    ],
  };
}

/** Swamp CEL expressions for every migrated dependency of `kind`. */
function refsOf(
  context: RenderContext,
  kind: Parameters<RenderContext["dependencies"]>[0],
  field?: string,
): string[] {
  return context.dependencies(kind)
    .map((id) => context.refTo(id, field))
    .filter((x): x is string => x !== null);
}

/** Subnets in an ALB/NLB or EKS cluster must span at least two zones. */
const TWO_ZONES =
  "subnets must span at least two availability zones; check the migrated subnets (each lands in one zone) before creating this";

// ---------------------------------------------------------------------------
// network (VPC)

const network: KindAdapter = {
  behaviorType: "@swamp/aws/ec2/vpc",
  idField: "VpcId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = str(a.VpcId) ?? str(a._identifier) ?? "";
    const labels = tagsToLabels(a.Tags);
    const cidr = track(unknownFields, "cidr", str(a.CidrBlock));
    return {
      id: canonicalId("aws", "network", id),
      provider: "aws",
      kind: "network",
      nativeId: id,
      aliases: [],
      name: nameFrom(labels, id),
      region: regionFallback,
      source: { behaviorType: network.behaviorType, behaviorName },
      properties: { cidr, labels },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
    };
    const cidr = str(p.cidr);
    if (cidr) globalArguments.CidrBlock = cidr;
    else {
      decisions.push(
        "source network has no single CIDR block; choose the VPC CIDR (it must contain every subnet you migrate)",
      );
    }
    // Subnets and DNS inside the VPC need these; AWS defaults support on, hostnames off.
    globalArguments.EnableDnsSupport = true;
    globalArguments.EnableDnsHostnames = true;
    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: network.behaviorType,
      globalArguments,
      expected: { cidr, labels: withoutReserved(labels) },
      losses,
      decisions,
    };
  },
  validateName: () => [],
};

/** Labels as they will read back after awsTags dropped the reserved ones. */
export function withoutReserved(
  labels: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).filter(([k]) => !k.toLowerCase().startsWith("aws:")),
  );
}

// ---------------------------------------------------------------------------
// subnet

const subnet: KindAdapter = {
  behaviorType: "@swamp/aws/ec2/subnet",
  idField: "SubnetId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = str(a.SubnetId) ?? str(a._identifier) ?? "";
    const labels = tagsToLabels(a.Tags);
    const zone = str(a.AvailabilityZone);
    const vpc = str(a.VpcId);
    if (vpc === null) unknownFields.push("network");
    return {
      id: canonicalId("aws", "subnet", id),
      provider: "aws",
      kind: "subnet",
      nativeId: id,
      aliases: [],
      name: nameFrom(labels, id),
      region: regionFromZone(zone) ?? regionFallback,
      source: { behaviorType: subnet.behaviorType, behaviorName },
      properties: {
        cidr: track(unknownFields, "cidr", str(a.CidrBlock)),
        zone: track(unknownFields, "zone", zone),
        publicIpOnLaunch: track(
          unknownFields,
          "publicIpOnLaunch",
          bool(a.MapPublicIpOnLaunch),
        ),
        labels,
      },
      refs: vpc ? [{ kind: "network", nativeId: vpc, via: "VpcId" }] : [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
    };
    const vpc = refsOf(context, "network")[0];
    if (vpc) globalArguments.VpcId = vpc;
    else {decisions.push(
        "no migrated network for this subnet; set VpcId to the target VPC",
      );}
    const cidr = str(p.cidr);
    if (cidr) globalArguments.CidrBlock = cidr;
    else {decisions.push(
        "source subnet has no CIDR block; choose one inside the target VPC",
      );}
    const { zone, losses: zoneLosses } = chooseZone(p.zone, target, "subnet");
    losses.push(...zoneLosses);
    globalArguments.AvailabilityZone = zone;
    if (typeof p.publicIpOnLaunch === "boolean") {
      globalArguments.MapPublicIpOnLaunch = p.publicIpOnLaunch;
    }
    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: subnet.behaviorType,
      globalArguments,
      expected: {
        cidr,
        zone,
        publicIpOnLaunch: typeof p.publicIpOnLaunch === "boolean"
          ? p.publicIpOnLaunch
          : null,
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName: () => [],
};

// ---------------------------------------------------------------------------
// firewall (security group)

type Rule = {
  direction: "ingress" | "egress";
  protocol: string;
  ports: string | null;
  cidrs: string[];
};

/** AWS protocol ("-1", "6", "tcp", ...) → canonical `tcp`/`udp`/`icmp`/`all` (others lowercased). */
function canonicalProtocol(protocol: unknown): string {
  const p = String(protocol ?? "-1").toLowerCase();
  if (p === "-1" || p === "all") return "all";
  if (p === "6") return "tcp";
  if (p === "17") return "udp";
  if (p === "1" || p === "58" || p === "icmpv6") return "icmp";
  return p;
}

/** FromPort/ToPort → `"22"`, `"8000-8080"` or null for all ports (and for ICMP, where they are type/code). */
function portsOf(protocol: string, from: unknown, to: unknown): string | null {
  const f = num(from);
  const t = num(to);
  if (
    protocol === "all" || protocol === "icmp" || f === null || t === null ||
    f === -1
  ) {
    return null;
  }
  return f === t ? String(f) : `${f}-${t}`;
}

/** Rules with the same direction/protocol/ports merged into one with all their CIDRs. */
function mergeRules(rules: Rule[]): Rule[] {
  const out: Rule[] = [];
  for (const r of rules) {
    const hit = out.find((o) =>
      o.direction === r.direction && o.protocol === r.protocol &&
      o.ports === r.ports
    );
    if (hit) {
      for (const c of r.cidrs) if (!hit.cidrs.includes(c)) hit.cidrs.push(c);
    } else out.push({ ...r, cidrs: [...r.cidrs] });
  }
  return out;
}

/** CIDR-based rules, plus a note for every rule that names a group or prefix list instead. */
function readRules(
  direction: "ingress" | "egress",
  entries: unknown[],
): { rules: Rule[]; notes: string[]; icmpTyped: string[] } {
  const rules: Rule[] = [];
  const notes: string[] = [];
  const icmpTyped: string[] = [];
  for (const entry of entries) {
    const e = obj(entry);
    if (!e) continue;
    const protocol = canonicalProtocol(e.IpProtocol);
    const ports = portsOf(protocol, e.FromPort, e.ToPort);
    const cidrs = [str(e.CidrIp), str(e.CidrIpv6)].filter((x): x is string =>
      x !== null
    );
    if (cidrs.length > 0) rules.push({ direction, protocol, ports, cidrs });
    // ICMP FromPort/ToPort are type/code; the canonical rule has no field for
    // them, so a specific one is remembered here for render to report.
    const icmpType = num(e.FromPort);
    const icmpCode = num(e.ToPort);
    if (
      protocol === "icmp" && cidrs.length > 0 && icmpType !== null &&
      icmpCode !== null && (icmpType !== -1 || icmpCode !== -1)
    ) {
      icmpTyped.push(
        `${direction} ICMP type ${icmpType} code ${icmpCode} from ${
          cidrs.join(", ")
        }`,
      );
    }
    const other = str(e.SourceSecurityGroupId) ??
      str(e.SourceSecurityGroupName) ??
      str(e.DestinationSecurityGroupId) ?? str(e.SourcePrefixListId) ??
      str(e.DestinationPrefixListId);
    if (cidrs.length === 0) {
      const kind = other?.startsWith("pl-") ? "prefix list" : "security group";
      notes.push(
        `${direction} ${protocol}${ports ? ` ${ports}` : ""} ${
          direction === "ingress" ? "from" : "to"
        } ${kind} ${other ?? "(unspecified)"}`,
      );
    }
  }
  return { rules: mergeRules(rules), notes, icmpTyped };
}

const firewall: KindAdapter = {
  behaviorType: "@swamp/aws/ec2/security-group",
  idField: "GroupId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = str(a.GroupId) ?? str(a.Id) ?? str(a._identifier) ?? "";
    const labels = tagsToLabels(a.Tags);
    const ingress = readRules("ingress", arr(a.SecurityGroupIngress));
    const egress = readRules("egress", arr(a.SecurityGroupEgress));
    if (a.SecurityGroupIngress === undefined) unknownFields.push("rules");
    const vpc = str(a.VpcId);
    return {
      id: canonicalId("aws", "firewall", id),
      provider: "aws",
      kind: "firewall",
      nativeId: id,
      aliases: aliasesOf(str(a.Id) !== id ? str(a.Id) : null),
      name: str(a.GroupName) ?? nameFrom(labels, id),
      region: regionFallback,
      source: { behaviorType: firewall.behaviorType, behaviorName },
      properties: {
        description: track(
          unknownFields,
          "description",
          str(a.GroupDescription),
        ),
        rules: [...ingress.rules, ...egress.rules],
        // Rules naming another security group or a prefix list have no
        // canonical form; render turns each into a decision.
        otherRules: [...ingress.notes, ...egress.notes],
        icmpTyped: [...ingress.icmpTyped, ...egress.icmpTyped],
        labels,
      },
      refs: vpc ? [{ kind: "network", nativeId: vpc, via: "VpcId" }] : [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const rules = mergeRules(
      (arr(p.rules) as Rule[]).filter((r) => obj(r) !== null).map((r) => ({
        ...r,
        // A foreign provider may carry a number; a non-port string is
        // dropped below with a loss rather than read as "all ports".
        ports: r.ports === null || r.ports === undefined
          ? null
          : String(r.ports),
        cidrs: arr(r.cidrs).filter((c): c is string => typeof c === "string"),
      })),
    );
    const emitted: Rule[] = [];
    const ingress: Record<string, unknown>[] = [];
    const egress: Record<string, unknown>[] = [];
    for (const r of rules) {
      const proto = ["tcp", "udp", "icmp", "all"].includes(r.protocol)
        ? r.protocol
        : null;
      if (proto === null) {
        losses.push(
          `${r.direction} rule for protocol "${r.protocol}" has no AWS equivalent and is dropped`,
        );
        continue;
      }
      let range: [number, number] | null = null;
      if (r.ports !== null && proto !== "all") {
        const m = r.ports.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) {
          losses.push(
            `${r.direction} rule ports "${r.ports}" are not a port or range and the rule is dropped`,
          );
          continue;
        }
        range = [Number(m[1]), Number(m[2] ?? m[1])];
      }
      for (const cidr of r.cidrs) {
        const v6 = cidr.includes(":");
        const entry: Record<string, unknown> = {
          IpProtocol: proto === "all"
            ? "-1"
            : proto === "icmp" && v6
            ? "icmpv6"
            : proto,
        };
        if (proto === "icmp") {
          entry.FromPort = -1;
          entry.ToPort = -1;
        } else if (proto !== "all") {
          entry.FromPort = range ? range[0] : 0;
          entry.ToPort = range ? range[1] : 65535;
        }
        entry[v6 ? "CidrIpv6" : "CidrIp"] = cidr;
        (r.direction === "ingress" ? ingress : egress).push(entry);
      }
      emitted.push(r);
    }
    const hasEgress = emitted.some((r) => r.direction === "egress");
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
      GroupName: targetName,
      GroupDescription: str(p.description) ?? targetName,
    };
    const vpc = refsOf(context, "network")[0];
    if (vpc) globalArguments.VpcId = vpc;
    else {decisions.push(
        "no migrated network for this firewall; set VpcId to the target VPC",
      );}
    if (ingress.length > 0) globalArguments.SecurityGroupIngress = ingress;
    if (hasEgress) globalArguments.SecurityGroupEgress = egress;
    else {
      // AWS adds an allow-all egress rule when none is given.
      losses.push(
        "source lists no egress rules; the security group gets AWS's default allow-all egress",
      );
    }
    for (const note of arr(p.icmpTyped)) {
      losses.push(
        `${
          String(note)
        } is widened to all ICMP types and codes (the canonical rule carries no type/code)`,
      );
    }
    for (const note of arr(p.otherRules)) {
      decisions.push(
        `rule not carried: ${
          String(note)
        }; recreate it against the migrated group or prefix list, or as a CIDR rule`,
      );
    }
    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: firewall.behaviorType,
      globalArguments,
      expected: {
        description: globalArguments.GroupDescription,
        rules: hasEgress ? emitted : mergeRules([
          ...emitted,
          {
            direction: "egress",
            protocol: "all",
            ports: null,
            cidrs: ["0.0.0.0/0"],
          },
        ]),
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 255) {
      problems.push(`"${name}" must be 1-255 characters`);
    }
    if (name.toLowerCase().startsWith("sg-")) {
      problems.push(`"${name}" must not start with "sg-" (reserved for ids)`);
    }
    if (!/^[a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]*$/.test(name)) {
      problems.push(
        `"${name}" has characters a security group name does not allow`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// vm (EC2 instance)

interface InstanceSpec {
  vcpus: number;
  memoryMiB: number;
  architecture: "x86_64" | "arm64";
}

/** [suffix, vcpus, memory GiB] for the burstable family. */
const BURSTABLE: [string, number, number][] = [
  ["nano", 2, 0.5],
  ["micro", 2, 1],
  ["small", 2, 2],
  ["medium", 2, 4],
  ["large", 2, 8],
  ["xlarge", 4, 16],
  ["2xlarge", 8, 32],
];

/** General purpose, compute and memory optimised share one shape; only GiB per vCPU differs. */
const SCALED: [string, number][] = [
  ["large", 2],
  ["xlarge", 4],
  ["2xlarge", 8],
  ["4xlarge", 16],
  [
    "8xlarge",
    32,
  ],
];

/**
 * Common current instance types (insertion order = preference among equal
 * sizes). Not exhaustive: a type missing here keeps whatever the record says.
 */
export const INSTANCE_TYPES: Record<string, InstanceSpec> = (() => {
  const t: Record<string, InstanceSpec> = {};
  for (
    const [family, architecture] of [["t3", "x86_64"], [
      "t4g",
      "arm64",
    ]] as const
  ) {
    for (const [size, vcpus, gib] of BURSTABLE) {
      t[`${family}.${size}`] = { vcpus, memoryMiB: gib * 1024, architecture };
    }
  }
  // GiB per vCPU: general purpose 4, compute 2, memory 8.
  for (
    const [family, architecture, gibPerVcpu] of [
      ["m6i", "x86_64", 4],
      ["m7g", "arm64", 4],
      ["c6i", "x86_64", 2],
      ["c7g", "arm64", 2],
      ["r6i", "x86_64", 8],
      ["r7g", "arm64", 8],
    ] as const
  ) {
    for (const [size, vcpus] of SCALED) {
      t[`${family}.${size}`] = {
        vcpus,
        memoryMiB: vcpus * gibPerVcpu * 1024,
        architecture,
      };
    }
  }
  return t;
})();

/** Graviton families end their generation number with `g` (`t4g`, `m7g`, `c6gd`). */
function architectureOf(instanceType: string): "x86_64" | "arm64" {
  return /^[a-z]+\d+g[a-z]*\./.test(instanceType) ? "arm64" : "x86_64";
}

/** The smallest known type with at least `vcpus` and `memoryMiB` on `architecture`, or null. */
export function smallestInstanceType(
  vcpus: number,
  memoryMiB: number,
  architecture: string,
): string | null {
  const fits = Object.entries(INSTANCE_TYPES)
    .filter(([, s]) =>
      s.architecture === architecture && s.vcpus >= vcpus &&
      s.memoryMiB >= memoryMiB
    );
  // Array.sort is stable, so equal sizes keep the table's family order. A
  // burstable (t*) type only wins when no steady-performance type is as small,
  // since a migrated server is assumed to run at a steady load.
  const burst = (name: string) => name.startsWith("t") ? 1 : 0;
  fits.sort(([na, a], [nb, b]) =>
    a.vcpus - b.vcpus || a.memoryMiB - b.memoryMiB || burst(na) - burst(nb)
  );
  return fits[0]?.[0] ?? null;
}

const vm: KindAdapter = {
  behaviorType: "@swamp/aws/ec2/instance",
  idField: "InstanceId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = str(a.InstanceId) ?? str(a._identifier) ?? "";
    const labels = tagsToLabels(a.Tags);
    const instanceType = track(
      unknownFields,
      "machineType",
      str(a.InstanceType),
    );
    const spec = instanceType ? INSTANCE_TYPES[instanceType] : undefined;
    const cpu = obj(a.CpuOptions);
    const cores = num(cpu?.CoreCount);
    const threads = num(cpu?.ThreadsPerCore);
    const vcpus = cores !== null && threads !== null
      ? cores * threads
      : spec?.vcpus ?? null;
    const nis = arr(a.NetworkInterfaces).map(obj).filter((n) => n !== null);

    let publicIp: boolean | null = null;
    if (
      str(a.PublicIp) || nis.some((n) => n.AssociatePublicIpAddress === true)
    ) publicIp = true;
    else if (str(a.PrivateIp) || str(a.PrivateIpAddress)) publicIp = false;

    // Only mappings that set a size say anything about the boot disk.
    const sizes = arr(a.BlockDeviceMappings).map((m) =>
      num(obj(obj(m)?.Ebs)?.VolumeSize)
    );
    const bootDisk = sizes.find((s) => s !== null) ?? null;

    const subnetId = str(a.SubnetId) ?? str(nis[0]?.SubnetId);
    const groups = new Set<string>(
      arr(a.SecurityGroupIds).map(str).filter((x) => x !== null),
    );
    for (const ni of nis) {
      for (const g of arr(ni.GroupSet)) if (str(g)) groups.add(str(g)!);
    }
    const profile = str(a.IamInstanceProfile);
    const zone = str(a.AvailabilityZone);

    const refs: ResourceRef[] = [];
    if (subnetId) {
      refs.push({ kind: "subnet", nativeId: subnetId, via: "SubnetId" });
    }
    for (const g of groups) {
      refs.push({ kind: "firewall", nativeId: g, via: "SecurityGroupIds" });
    }
    if (profile) {
      refs.push({
        kind: "iam-principal",
        nativeId: profile,
        via: "IamInstanceProfile",
      });
    }
    for (const v of arr(a.Volumes)) {
      const vid = str(obj(v)?.VolumeId);
      if (vid) {
        refs.push({ kind: "block-volume", nativeId: vid, via: "Volumes" });
      }
    }
    return {
      id: canonicalId("aws", "vm", id),
      provider: "aws",
      kind: "vm",
      nativeId: id,
      aliases: [],
      name: nameFrom(labels, id),
      region: regionFromZone(zone) ?? regionFallback,
      source: { behaviorType: vm.behaviorType, behaviorName },
      properties: {
        machineType: instanceType,
        vcpus: track(unknownFields, "vcpus", vcpus),
        memoryMiB: track(unknownFields, "memoryMiB", spec?.memoryMiB ?? null),
        architecture: track(
          unknownFields,
          "architecture",
          spec?.architecture ??
            (instanceType ? architectureOf(instanceType) : null),
        ),
        image: track(unknownFields, "image", str(a.ImageId)),
        publicIp: track(unknownFields, "publicIp", publicIp),
        bootDiskGiB: track(unknownFields, "bootDiskGiB", bootDisk),
        labels,
      },
      refs,
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
    };

    // Size: keep an AWS type as is, otherwise the smallest type that fits.
    let instanceType: string | null = null;
    const sameCloud = resource.provider === "aws" &&
      str(p.machineType) !== null;
    if (sameCloud) instanceType = str(p.machineType);
    else {
      const vcpus = num(p.vcpus);
      const memoryMiB = num(p.memoryMiB);
      let arch = str(p.architecture);
      if (arch === null) {
        arch = "x86_64";
        losses.push("source architecture is unknown; assuming x86_64");
      }
      if (vcpus === null || memoryMiB === null) {
        decisions.push(
          "source vCPU/memory are unknown; choose the EC2 instance type",
        );
      } else {
        instanceType = smallestInstanceType(vcpus, memoryMiB, arch);
        if (instanceType) {
          const s = INSTANCE_TYPES[instanceType];
          losses.push(
            `sized to ${instanceType} (${s.vcpus} vCPU, ${s.memoryMiB} MiB, ${arch}) as the smallest common type with at least ${vcpus} vCPU and ${memoryMiB} MiB`,
          );
        } else {
          decisions.push(
            `no common ${arch} instance type has ${vcpus} vCPU and ${memoryMiB} MiB; choose one from the full EC2 catalogue`,
          );
        }
      }
    }
    if (instanceType) globalArguments.InstanceType = instanceType;
    const spec = instanceType ? INSTANCE_TYPES[instanceType] : undefined;

    // Images do not move between clouds, or between regions.
    if (sameCloud && resource.region === target.region && str(p.image)) {
      globalArguments.ImageId = str(p.image);
    } else {
      globalArguments.ImageId = `<choose-an-ami-in-${target.region}>`;
      decisions.push(
        `choose an AMI in ${target.region} equivalent to source image ${
          str(p.image) ?? "(unknown)"
        }; ImageId is a placeholder until then`,
      );
    }

    const subnet = refsOf(context, "subnet")[0];
    const groups = refsOf(context, "firewall");
    const publicIp = typeof p.publicIp === "boolean" ? p.publicIp : null;
    if (subnet) {
      if (publicIp !== null) {
        // Public address control lives on the network interface, which then owns subnet and groups.
        globalArguments.NetworkInterfaces = [{
          DeviceIndex: "0",
          AssociatePublicIpAddress: publicIp,
          SubnetId: subnet,
          ...(groups.length > 0 ? { GroupSet: groups } : {}),
        }];
      } else {
        globalArguments.SubnetId = subnet;
        if (groups.length > 0) globalArguments.SecurityGroupIds = groups;
      }
    } else {
      decisions.push(
        "no migrated subnet for this instance; set SubnetId (and the public address behaviour) for the target network",
      );
      if (groups.length > 0) globalArguments.SecurityGroupIds = groups;
      const zone = chooseZone(null, target, "instance");
      globalArguments.AvailabilityZone = zone.zone;
      losses.push(...zone.losses);
    }

    // Data volumes: attach the migrated ones; device names are assigned afresh.
    const volumes = refsOf(context, "block-volume");
    if (volumes.length > 0) {
      globalArguments.Volumes = volumes.map((VolumeId, i) => ({
        VolumeId,
        Device: `/dev/sd${String.fromCharCode(102 + (i % 15))}`,
      }));
      losses.push(
        "data volumes are attached as /dev/sdf onwards; source device names are not carried",
      );
    }
    if (context.dependencies("iam-principal").length > 0) {
      decisions.push(
        "source uses an instance profile; create an instance profile for the migrated role and set IamInstanceProfile",
      );
    }
    const bootDisk = num(p.bootDiskGiB);
    if (bootDisk !== null) {
      decisions.push(
        `source boot disk is ${bootDisk} GiB; set BlockDeviceMappings once the AMI (and its root device name) is chosen`,
      );
    }

    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: vm.behaviorType,
      globalArguments,
      expected: {
        vcpus: spec?.vcpus ?? num(p.vcpus),
        memoryMiB: spec?.memoryMiB ?? num(p.memoryMiB),
        architecture: spec?.architecture ?? str(p.architecture),
        publicIp: subnet ? publicIp : null,
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName: () => [],
};

// ---------------------------------------------------------------------------
// block-volume (EBS)

const volume: KindAdapter = {
  behaviorType: "@swamp/aws/ec2/volume",
  idField: "VolumeId",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = str(a.VolumeId) ?? str(a._identifier) ?? "";
    const labels = tagsToLabels(a.Tags);
    const type = track(unknownFields, "media", str(a.VolumeType));
    const kms = customKeyOf(a.KmsKeyId);
    let encryption: string | null = null;
    if (kms) encryption = "customer-key";
    else if (a.Encrypted === true || str(a.KmsKeyId)) {
      encryption = "provider-managed";
    } else if (a.Encrypted === false) encryption = "none";
    else unknownFields.push("encryption");
    const zone = str(a.AvailabilityZone);
    return {
      id: canonicalId("aws", "block-volume", id),
      provider: "aws",
      kind: "block-volume",
      nativeId: id,
      aliases: [],
      name: nameFrom(labels, id),
      region: regionFromZone(zone) ?? regionFallback,
      source: { behaviorType: volume.behaviorType, behaviorName },
      properties: {
        sizeGiB: track(unknownFields, "sizeGiB", num(a.Size)),
        media: type === null
          ? null
          : ["standard", "sc1", "st1"].includes(type)
          ? "hdd"
          : "ssd",
        // Only io1/io2 (and gp3 above baseline) have provisioned IOPS worth carrying.
        iops: num(a.Iops),
        encryption,
        zone: track(unknownFields, "zone", zone),
        labels,
        volumeType: type,
      },
      refs: kms ? [{ kind: "kms-key", nativeId: kms, via: "KmsKeyId" }] : [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
    };
    const size = num(p.sizeGiB);
    if (size !== null) globalArguments.Size = size;
    else decisions.push("source volume size is unknown; set Size");

    // Volume type: keep an AWS type; otherwise gp3 (or io2 above gp3's IOPS cap) for ssd, st1/standard for hdd.
    const iops = num(p.iops);
    let type: string | null;
    if (resource.provider === "aws" && str(p.volumeType)) {
      type = str(p.volumeType);
    } else if (p.media === "hdd") {
      type = size !== null && size >= 125 ? "st1" : "standard";
      if (type === "standard") {
        losses.push(
          "hdd volumes under 125 GiB use previous-generation magnetic (standard); st1 needs 125 GiB or more",
        );
      }
    } else if (p.media === "ssd") {
      type = iops !== null && iops > 16000 ? "io2" : "gp3";
    } else type = null;
    if (type) globalArguments.VolumeType = type;
    else {decisions.push(
        "source volume media is unknown; choose the EBS volume type",
      );}
    if (iops !== null && type !== null) {
      if (type === "gp3" && iops < 3000) {
        losses.push(
          `gp3 has a baseline of 3000 IOPS; source provisioned ${iops}`,
        );
      } else if (["gp3", "io1", "io2"].includes(type)) {
        globalArguments.Iops = iops;
      } else {losses.push(
          `${type} volumes cannot provision IOPS; the ${iops} IOPS setting is dropped`,
        );}
    } else if (type === "io1" || type === "io2") {
      decisions.push(`${type} volumes need provisioned IOPS; set Iops`);
    }

    let encryption: string | null = str(p.encryption);
    if (encryption === "none") globalArguments.Encrypted = false;
    else if (encryption === "provider-managed") {
      globalArguments.Encrypted = true;
    } else if (encryption === "customer-key") {
      globalArguments.Encrypted = true;
      const key = refsOf(context, "kms-key")[0];
      if (key) globalArguments.KmsKeyId = key;
      else {
        decisions.push(
          "source encryption key is not part of the migration (it may be the AWS-managed aws/ebs key, which needs no KmsKeyId; otherwise it is customer-managed): set KmsKeyId to a key in the target KMS, or leave it unset for the AWS-managed key",
        );
        encryption = null;
      }
    }

    const zone = chooseZone(p.zone, target, "volume");
    losses.push(...zone.losses);
    globalArguments.AvailabilityZone = zone.zone;
    losses.push(
      "the volume is created empty; copy the data separately (snapshot export or file-level copy)",
    );

    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: volume.behaviorType,
      globalArguments,
      expected: {
        sizeGiB: size,
        media: p.media ?? null,
        iops: typeof globalArguments.Iops === "number"
          ? globalArguments.Iops
          : null,
        encryption,
        zone: zone.zone,
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName: () => [],
};

// ---------------------------------------------------------------------------
// load-balancer (ELBv2)

const loadBalancer: KindAdapter = {
  behaviorType: "@swamp/aws/elasticloadbalancingv2/load-balancer",
  idField: "LoadBalancerArn",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const arn = str(a.LoadBalancerArn) ?? str(a._identifier) ?? "";
    const name = str(a.Name) ?? str(a.LoadBalancerName) ?? arn.split("/")[2] ??
      arn;
    const scheme = track(unknownFields, "scheme", str(a.Scheme));
    const type = track(unknownFields, "layer", str(a.Type));
    const subnets = new Set<string>(
      arr(a.Subnets).map(str).filter((x) => x !== null),
    );
    for (const m of arr(a.SubnetMappings)) {
      const s = str(obj(m)?.SubnetId);
      if (s) subnets.add(s);
    }
    const refs: ResourceRef[] = [];
    for (const s of subnets) {
      refs.push({ kind: "subnet", nativeId: s, via: "Subnets" });
    }
    for (const g of arr(a.SecurityGroups)) {
      if (str(g)) {
        refs.push({
          kind: "firewall",
          nativeId: str(g)!,
          via: "SecurityGroups",
        });
      }
    }
    return {
      id: canonicalId("aws", "load-balancer", arn),
      provider: "aws",
      kind: "load-balancer",
      nativeId: arn,
      aliases: aliasesOf(name !== arn ? name : null),
      name,
      region: regionFromArn(arn) ?? regionFallback,
      source: { behaviorType: loadBalancer.behaviorType, behaviorName },
      properties: {
        scheme: scheme === null
          ? null
          : scheme === "internal"
          ? "internal"
          : "internet",
        layer: type === "application"
          ? "application"
          : type === "network"
          ? "network"
          : null,
        // Listeners are separate @swamp/aws/elasticloadbalancingv2/listener
        // resources, not part of this record, so they are unknown but not a
        // missing field to refresh.
        listeners: null,
        labels: tagsToLabels(a.Tags),
      },
      refs,
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
      Name: targetName,
    };
    if (p.layer === "application" || p.layer === "network") {
      globalArguments.Type = p.layer;
    } else {decisions.push(
        'source load balancer layer is unknown; choose "application" or "network"',
      );}
    if (p.scheme === "internal" || p.scheme === "internet") {
      globalArguments.Scheme = p.scheme === "internal"
        ? "internal"
        : "internet-facing";
    } else {decisions.push(
        "source load balancer scheme is unknown; choose internal or internet-facing",
      );}

    const subnets = refsOf(context, "subnet");
    if (subnets.length > 0) {
      globalArguments.Subnets = subnets;
      if (subnets.length < 2 && p.layer !== "network") {
        decisions.push(
          "an application load balancer needs subnets in at least two availability zones; migrate or choose another subnet",
        );
      } else losses.push(TWO_ZONES);
    } else {decisions.push(
        "no migrated subnets for this load balancer; set Subnets in the target VPC",
      );}
    const groups = refsOf(context, "firewall");
    if (groups.length > 0) globalArguments.SecurityGroups = groups;
    else if (p.layer === "application") {
      decisions.push(
        "no migrated security groups; an application load balancer needs SecurityGroups in the target VPC",
      );
    }
    const listeners = arr(p.listeners).map(obj).filter((x) => x !== null);
    if (listeners.length > 0) {
      const l = listeners.map((x) => `${x.protocol}:${x.port}`).join(", ");
      losses.push(
        `listeners (${l}) are not created here; add listener resources with target groups`,
      );
    }
    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: loadBalancer.behaviorType,
      globalArguments,
      expected: {
        scheme: p.scheme ?? null,
        layer: p.layer ?? null,
        listeners: null,
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 32) {
      problems.push(`"${name}" must be 1-32 characters`);
    }
    if (!/^[a-zA-Z0-9-]*$/.test(name)) {
      problems.push(`"${name}" may only use letters, digits and hyphens`);
    }
    if (name.startsWith("-") || name.endsWith("-")) {
      problems.push(`"${name}" must not start or end with a hyphen`);
    }
    if (name.startsWith("internal-")) {
      problems.push(`"${name}" must not start with "internal-"`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// DNS (Route 53)

/** A DNS name without its trailing dot. */
function undot(name: string): string {
  return name.replace(/\.$/, "");
}

/** A DNS name with exactly one trailing dot. */
function dot(name: string): string {
  return `${undot(name)}.`;
}

/** Record types whose values are (or end in) host names, which Route 53 wants dotted. */
const NAME_VALUED = new Set(["CNAME", "NS", "PTR", "MX", "SRV"]);

/** Apply `fn` to the host name part of a record value (the whole value, or the last field of MX/SRV). */
function mapHost(
  type: string,
  value: string,
  fn: (name: string) => string,
): string {
  if (!NAME_VALUED.has(type)) return value;
  if (type === "MX" || type === "SRV") {
    const parts = value.trim().split(/\s+/);
    parts[parts.length - 1] = fn(parts[parts.length - 1]);
    return parts.join(" ");
  }
  return fn(value);
}

const dnsZone: KindAdapter = {
  behaviorType: "@swamp/aws/route53/hosted-zone",
  idField: "Id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    // Cloud Control gives the bare id; the API form is "/hostedzone/<id>".
    const id = (str(a.Id) ?? str(a._identifier) ?? "").replace(
      /^\/hostedzone\//,
      "",
    );
    const name = str(a.Name);
    const domain = track(unknownFields, "domain", name ? undot(name) : null);
    const vpcs = arr(a.VPCs).map(obj).filter((v) => v !== null);
    // Route 53 returns NameServers only for public zones and VPCs only for
    // private ones. A record with neither is a bare list result, so its
    // privacy is unknown rather than assumed public.
    const hasNameServers = arr(a.NameServers).length > 0;
    const isPrivate = a.VPCs !== undefined
      ? vpcs.length > 0
      : hasNameServers
      ? false
      : null;
    if (isPrivate === null) unknownFields.push("private");
    const refs: ResourceRef[] = [];
    for (const v of vpcs) {
      const vid = str(v.VPCId);
      if (vid) refs.push({ kind: "network", nativeId: vid, via: "VPCs" });
    }
    return {
      id: canonicalId("aws", "dns-zone", id),
      provider: "aws",
      kind: "dns-zone",
      nativeId: id,
      aliases: aliasesOf(`/hostedzone/${id}`, domain),
      name: domain ?? id,
      region: str(vpcs[0]?.VPCRegion) ?? regionFallback,
      source: { behaviorType: dnsZone.behaviorType, behaviorName },
      properties: {
        domain,
        private: isPrivate,
        labels: tagsToLabels(a.HostedZoneTags),
      },
      refs,
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const domain = str(p.domain) ?? resource.name;
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
      Name: dot(domain),
    };
    if (p.private === true) {
      const vpcs = refsOf(context, "network");
      if (vpcs.length > 0) {
        globalArguments.VPCs = vpcs.map((VPCId) => ({
          VPCId,
          VPCRegion: target.region,
        }));
      } else {
        decisions.push(
          "private zone has no migrated network; set VPCs to the target VPC(s) it serves",
        );
      }
    }
    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.HostedZoneTags = tags;
    if (p.private !== true && p.private !== false) {
      decisions.push(
        "source zone privacy is unknown (the record lists no VPCs); confirm whether it is public or private: the target is created as a public zone",
      );
    }
    if (p.private !== true) {
      decisions.push(
        `the new public zone gets new name servers; update the registrar's NS records for ${domain} at cutover`,
      );
    }
    return {
      behaviorType: dnsZone.behaviorType,
      globalArguments,
      expected: {
        domain,
        private: typeof p.private === "boolean" ? p.private : null,
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName: () => [],
};

/** The routing policy a record set uses, or null for a simple record. */
function routingPolicy(a: Record<string, unknown>): string | null {
  if (a.Weight !== undefined) return "weighted";
  if (a.Failover !== undefined) return "failover";
  if (obj(a.GeoLocation)) return "geolocation";
  if (obj(a.CidrRoutingConfig)) return "ip-based";
  if (str(a.Region)) return "latency";
  if (a.MultiValueAnswer === true) return "multivalue";
  return null;
}

const dnsRecord: KindAdapter = {
  behaviorType: "@swamp/aws/route53/record-set",
  idField: "Name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const rawName = str(a.Name);
    const name = track(unknownFields, "name", rawName ? undot(rawName) : null);
    const type = track(unknownFields, "type", str(a.Type));
    const alias = obj(a.AliasTarget);
    const records = arr(a.ResourceRecords).filter((x): x is string =>
      typeof x === "string"
    );
    const values = alias
      ? [undot(str(alias.DNSName) ?? "")].filter((x) => x)
      : records.map((v) => mapHost(type ?? "", v, undot));
    if (!alias && records.length === 0) unknownFields.push("values");
    const zoneId = (str(a.HostedZoneId) ?? "").replace(/^\/hostedzone\//, "");
    const zoneName = str(a.HostedZoneName);
    const refs: ResourceRef[] = zoneId
      ? [{ kind: "dns-zone", nativeId: zoneId, via: "HostedZoneId" }]
      : zoneName
      ? [{ kind: "dns-zone", nativeId: undot(zoneName), via: "HostedZoneName" }]
      : [];
    const setId = str(a.SetIdentifier);
    const nativeId = [zoneId || zoneName, name, type, setId].filter((x) => x)
      .join("/");
    return {
      id: canonicalId("aws", "dns-record", nativeId),
      provider: "aws",
      kind: "dns-record",
      nativeId,
      aliases: [],
      name: name ?? nativeId,
      region: regionFallback,
      source: { behaviorType: dnsRecord.behaviorType, behaviorName },
      properties: {
        name,
        type,
        // Alias records have no TTL of their own.
        ttl: alias ? null : track(unknownFields, "ttl", num(a.TTL)),
        values,
        alias: alias !== null,
        routingPolicy: routingPolicy(a),
        // The zone's own name, to tell apex records (which Route 53 creates
        // itself) from the rest. Absent when the record does not carry it.
        zoneName: zoneName ? undot(zoneName) : null,
      },
      refs,
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const name = str(p.name) ?? resource.name;
    const type = str(p.type) ?? "A";
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      name: targetName,
      Name: dot(name),
      Type: type,
    };
    // Route 53 creates the SOA and the apex NS records with every zone, so
    // copying them would collide with (or overwrite) the new zone's own.
    const zoneId = context.dependencies("dns-zone")[0];
    const zoneName = (str(p.zoneName) ??
      (zoneId ? context.targetNameOf(zoneId) : null))?.toLowerCase();
    const atApex = zoneName !== undefined &&
      undot(name).toLowerCase() === undot(zoneName);
    const managed = type.toUpperCase() === "SOA" ||
      (type.toUpperCase() === "NS" && atApex);
    if (managed) {
      decisions.push(
        "Route 53 manages this record; leave it out of the migration",
      );
    }
    const zone = refsOf(context, "dns-zone")[0];
    if (zone) globalArguments.HostedZoneId = zone;
    else {decisions.push(
        "no migrated zone for this record; set HostedZoneId to the target hosted zone",
      );}

    const values = arr(p.values).filter((x): x is string =>
      typeof x === "string"
    );
    if (p.alias === true) {
      decisions.push(
        `source is an alias record pointing at ${
          values[0] ?? "(unknown)"
        }; recreate it as a CNAME or as an alias to the migrated target`,
      );
    } else {
      globalArguments.ResourceRecords = values.map((v) =>
        mapHost(type, v, dot)
      );
      let ttl = num(p.ttl);
      if (ttl === null) {
        ttl = 300;
        losses.push("source TTL is unknown; using 300 seconds");
      }
      globalArguments.TTL = String(ttl);
      if (type === "CNAME" && values.length > 1) {
        losses.push(
          "a CNAME record can have only one value; extra values will be rejected",
        );
      }
    }
    if (typeof p.routingPolicy === "string") {
      losses.push(
        `${p.routingPolicy} routing policy is not translated; the record is created as a simple record`,
      );
    }
    return {
      behaviorType: dnsRecord.behaviorType,
      globalArguments,
      expected: {
        name,
        type,
        ttl: p.alias === true
          ? null
          : typeof globalArguments.TTL === "string"
          ? Number(globalArguments.TTL)
          : null,
        values: p.alias === true ? null : values,
      },
      losses,
      decisions,
    };
  },
  validateName: () => [],
};

// ---------------------------------------------------------------------------
// kubernetes-cluster (EKS)

const cluster: KindAdapter = {
  behaviorType: "@swamp/aws/eks/cluster",
  idField: "Name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.Name) ?? str(a._identifier) ?? "";
    const arn = str(a.Arn);
    const vpc = obj(a.ResourcesVpcConfig);
    let privateEndpoint: boolean | null = null;
    if (vpc) {
      // EKS defaults: public access on, private access off.
      privateEndpoint = vpc.EndpointPrivateAccess === true &&
        vpc.EndpointPublicAccess === false;
    } else unknownFields.push("privateEndpoint");
    const refs: ResourceRef[] = [];
    for (const s of arr(vpc?.SubnetIds)) {
      if (str(s)) {
        refs.push({ kind: "subnet", nativeId: str(s)!, via: "SubnetIds" });
      }
    }
    const role = str(a.RoleArn);
    if (role) {
      refs.push({ kind: "iam-principal", nativeId: role, via: "RoleArn" });
    }
    const encrypts = arr(a.EncryptionConfig).some((e) =>
      str(obj(obj(e)?.Provider)?.KeyArn)
    );
    return {
      id: canonicalId("aws", "kubernetes-cluster", name),
      provider: "aws",
      kind: "kubernetes-cluster",
      nativeId: name,
      aliases: aliasesOf(arn),
      name,
      region: regionFromArn(arn) ?? regionFallback,
      source: { behaviorType: cluster.behaviorType, behaviorName },
      properties: {
        version: track(unknownFields, "version", str(a.Version)),
        // Node groups are separate resources; the control plane record has no count.
        nodeCount: null,
        privateEndpoint,
        labels: tagsToLabels(a.Tags),
        secretsEncryption: encrypts,
      },
      refs,
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      region: target.region,
      Name: targetName,
    };

    // Version: the minor version only ("1.30.2-gke.100" → "1.30").
    const m = str(p.version)?.match(/^(\d+)\.(\d+)/);
    let version: string | null = null;
    if (m && m[1] === "1" && m[2].length === 2) {
      version = `${m[1]}.${m[2]}`;
      globalArguments.Version = version;
      if (resource.provider !== "aws" || str(p.version) !== version) {
        losses.push(
          `Kubernetes version ${version} is taken from "${p.version}"; confirm EKS still offers it`,
        );
      }
    } else {
      decisions.push(
        `source Kubernetes version "${
          p.version ?? "(unknown)"
        }" is not an EKS "1.NN" version; choose the EKS version`,
      );
    }

    const subnets = refsOf(context, "subnet");
    const privateEndpoint = typeof p.privateEndpoint === "boolean"
      ? p.privateEndpoint
      : null;
    const vpcConfig: Record<string, unknown> = {};
    if (subnets.length > 0) {
      vpcConfig.SubnetIds = subnets;
      losses.push(TWO_ZONES);
    } else {decisions.push(
        "no migrated subnets for this cluster; set ResourcesVpcConfig.SubnetIds in the target VPC",
      );}
    if (privateEndpoint !== null && subnets.length === 0) {
      decisions.push(
        `the ${
          privateEndpoint ? "private" : "public"
        } API endpoint setting is not applied until ResourcesVpcConfig (with SubnetIds) is set`,
      );
    }
    if (privateEndpoint !== null) {
      vpcConfig.EndpointPrivateAccess = privateEndpoint;
      vpcConfig.EndpointPublicAccess = !privateEndpoint;
    }
    // The schema requires SubnetIds inside ResourcesVpcConfig, so without
    // subnets the whole block is left for the person to supply.
    if (subnets.length > 0) globalArguments.ResourcesVpcConfig = vpcConfig;

    const role = refsOf(context, "iam-principal", "Arn")[0];
    if (role) globalArguments.RoleArn = role;
    else {decisions.push(
        "no migrated IAM role for the control plane; set RoleArn to an EKS cluster role",
      );}
    if (p.secretsEncryption === true) {
      losses.push(
        "envelope encryption of Kubernetes secrets is not carried; configure EncryptionConfig with a target KMS key",
      );
    }
    const labels = labelsOf(p);
    const { tags, losses: tagLosses } = awsTags(labels);
    losses.push(...tagLosses);
    if (tags.length > 0) globalArguments.Tags = tags;
    return {
      behaviorType: cluster.behaviorType,
      globalArguments,
      expected: {
        version,
        nodeCount: null,
        privateEndpoint: subnets.length > 0 ? privateEndpoint : null,
        labels: withoutReserved(labels),
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 100) {
      problems.push(`"${name}" must be 1-100 characters`);
    }
    if (!/^[0-9A-Za-z][A-Za-z0-9\-_]*$/.test(name)) {
      problems.push(
        `"${name}" must start with a letter or digit and use only letters, digits, "-" and "_"`,
      );
    }
    return problems;
  },
};

/** Kind adapters merged into the provider in its main file. */
export const awsInfraKinds: ProviderAdapter["kinds"] = {
  network,
  subnet,
  firewall,
  vm,
  "block-volume": volume,
  "load-balancer": loadBalancer,
  "dns-zone": dnsZone,
  "dns-record": dnsRecord,
  "kubernetes-cluster": cluster,
};

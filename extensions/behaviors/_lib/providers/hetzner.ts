/**
 * Hetzner Cloud adapters, over the official `@swamp/hetzner-cloud/*`
 * behaviors. Their `state` attributes are the Hetzner Cloud API's JSON
 * field names (the create/get/list calls write the API object itself), so
 * that is what these adapters read and render.
 *
 * Not covered, because the package has no fitting behavior (or its state
 * does not carry the data): `subnet` (Hetzner subnets are a list inside the
 * network, not a resource), `dns-record` (the zones state holds no RRSets and
 * there is no RRSet behavior), `sql-database`, `object-bucket`,
 * `kubernetes-cluster`, `container-registry`, `message-*`, `function`,
 * `cache`, `file-share`, `nosql-table`, `kms-key`, `secret` and
 * `iam-principal`. Those map to "unsupported" in a plan.
 *
 * @module
 */
import {
  arr,
  bool,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  num,
  obj,
  type ProviderAdapter,
  type ResourceRef,
  str,
  stringMap,
  track,
} from "../adapter.ts";
import type { FirewallRule, ResourceKind } from "../kinds.ts";

// ---------------------------------------------------------------------------
// Shared helpers

/** Hetzner location code → network zone. Networks and load balancers are zone-bound. */
const LOCATION_ZONES: Record<string, string> = {
  fsn1: "eu-central",
  nbg1: "eu-central",
  hel1: "eu-central",
  ash: "us-east",
  hil: "us-west",
  sin: "ap-southeast",
};

/** Locations that sell the EU-only server lines (cx, cax). */
const EU_LOCATIONS = new Set(["fsn1", "nbg1", "hel1"]);

/** The location code `region` names, or null when it is not a Hetzner location. */
function knownLocation(region: string | null | undefined): string | null {
  const r = (region ?? "").toLowerCase();
  return r in LOCATION_ZONES ? r : null;
}

/** The decision to record when `target.region` is not a Hetzner location. */
function unknownLocationDecision(region: string): string {
  return `target region "${region}" is not a Hetzner location (${
    Object.keys(LOCATION_ZONES).join(", ")
  }); pick one`;
}

/** Stringify a numeric Hetzner id, or null. */
function idOf(value: unknown): string | null {
  const n = num(value);
  return n === null ? null : String(n);
}

/** The location name (`fsn1`) from a state record's `location` object. */
function locationName(a: Record<string, unknown>): string | null {
  return str(obj(a.location)?.name);
}

const LABEL_CHARS = /[^A-Za-z0-9._-]/g;
const LABEL_PREFIX = /^[a-z0-9]([a-z0-9.-]{0,250}[a-z0-9])?$/;

/** Trim a label part to 63 chars, starting and ending alphanumeric. */
function trimLabelPart(s: string): string {
  return s.slice(0, 63).replace(/^[^A-Za-z0-9]+/, "").replace(
    /[^A-Za-z0-9]+$/,
    "",
  );
}

/**
 * Labels rewritten to Hetzner's rules, with a loss for every label that
 * changed or was dropped. A key is `[prefix/]name`: the name is at most 63
 * chars of `[A-Za-z0-9._-]` starting and ending alphanumeric, the optional
 * prefix is a lowercase DNS subdomain (`hetzner.cloud` is reserved). A value
 * follows the name rule but may be empty.
 */
export function toHetznerLabels(
  labels: Record<string, string>,
): { labels: Record<string, string>; losses: string[] } {
  const out: Record<string, string> = {};
  const losses: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    let prefix = "";
    let name = k;
    const slash = k.indexOf("/");
    if (slash > 0 && k.indexOf("/", slash + 1) === -1) {
      const candidate = k.slice(0, slash);
      if (LABEL_PREFIX.test(candidate) && candidate !== "hetzner.cloud") {
        prefix = `${candidate}/`;
        name = k.slice(slash + 1);
      }
    }
    const key = prefix + trimLabelPart(name.replace(LABEL_CHARS, "_"));
    const value = trimLabelPart(v.replace(LABEL_CHARS, "_"));
    if (key === prefix) {
      losses.push(
        `label "${k}=${v}" has no usable key under Hetzner's label rules and is dropped`,
      );
      continue;
    }
    if (key in out) {
      losses.push(
        `label "${k}" collides with another label as "${key}" and is dropped`,
      );
      continue;
    }
    if (key !== k || value !== v) {
      losses.push(
        `label "${k}=${v}" becomes "${key}=${value}" (Hetzner label rules)`,
      );
    }
    out[key] = value;
  }
  return { labels: out, losses };
}

/** `labels` property of a canonical resource as a string map. */
function labelsOf(p: Record<string, unknown>): Record<string, string> {
  return stringMap(p.labels);
}

/** Add `labels` to the global arguments when there are any; returns the sanitised map + losses. */
function renderLabels(
  p: Record<string, unknown>,
  globalArguments: Record<string, unknown>,
): { labels: Record<string, string>; losses: string[] } {
  const r = toHetznerLabels(labelsOf(p));
  if (Object.keys(r.labels).length > 0) globalArguments.labels = r.labels;
  return r;
}

/** Name rule shared by networks, firewalls and load balancers: 1-128 chars, no edge whitespace. */
function plainNameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length < 1 || name.length > 128) {
    problems.push(`"${name}" must be 1-128 characters`);
  }
  if (name !== name.trim()) {
    problems.push(`"${name}" must not start or end with whitespace`);
  }
  return problems;
}

/** A canonical reference to a numeric Hetzner id. */
function ref(kind: ResourceKind, id: unknown, via: string): ResourceRef[] {
  const nativeId = idOf(id);
  return nativeId ? [{ kind, nativeId, via }] : [];
}

/** The CEL expressions for every dependency of `kind`; ids whose dependency is not migrated are returned apart. */
function dependencyRefs(
  context: {
    refTo(id: string, field?: string): string | null;
    dependencies(k: ResourceKind): string[];
  },
  kind: ResourceKind,
): { exprs: string[]; missing: string[] } {
  const exprs: string[] = [];
  const missing: string[] = [];
  for (const id of context.dependencies(kind)) {
    const expr = context.refTo(id);
    if (expr) exprs.push(expr);
    else missing.push(id);
  }
  return { exprs, missing };
}

/** Parse `a.b.c.d/n` into [address as uint32, prefix], or null. */
function parseCidr(cidr: string): [number, number] | null {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  return [
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
    0,
    prefix,
  ];
}

/** Whether `addr` falls inside `block` (a parsed CIDR). */
function inBlock(addr: number, block: [number, number]): boolean {
  const mask = block[1] === 0 ? 0 : (0xffffffff << (32 - block[1])) >>> 0;
  return ((addr & mask) >>> 0) === ((block[0] & mask) >>> 0);
}

// ---------------------------------------------------------------------------
// network (@swamp/hetzner-cloud/networks)

const RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map((c) =>
  parseCidr(c)!
);

const network: KindAdapter = {
  behaviorType: "@swamp/hetzner-cloud/networks",
  idField: "id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = idOf(a.id) ?? "";
    const name = str(a.name) ?? id;
    const cidr = track(unknownFields, "cidr", str(a.ip_range));
    // A network has no location, only the network zones of its subnets.
    const zone =
      arr(a.subnets).map((s) => str(obj(s)?.network_zone)).find((z) =>
        z !== null
      ) ??
        null;
    const region = zone ?? regionFallback;
    if (region === null) unknownFields.push("region");
    return {
      id: canonicalId("hetzner", "network", id),
      provider: "hetzner",
      kind: "network",
      nativeId: id,
      aliases: [name].filter((x) => x && x !== id),
      name,
      region,
      source: { behaviorType: network.behaviorType, behaviorName },
      properties: { cidr, labels: stringMap(a.labels) },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const globalArguments: Record<string, unknown> = { name: targetName };
    const losses: string[] = [];
    const decisions: string[] = [];
    let cidr: string | null = typeof p.cidr === "string" ? p.cidr : null;

    if (cidr === null) {
      decisions.push(
        "source network has no CIDR (auto/custom mode); choose a private IPv4 range of at least /24, e.g. 10.0.0.0/16",
      );
    } else {
      const parsed = parseCidr(cidr);
      if (!parsed) {
        decisions.push(
          `source CIDR "${cidr}" is not an IPv4 block Hetzner networks accept; choose an RFC 1918 range`,
        );
        cidr = null;
      } else {
        if (!RFC1918.some((b) => inBlock(parsed[0], b) && parsed[1] >= b[1])) {
          decisions.push(
            `CIDR ${cidr} is not inside an RFC 1918 private range, which Hetzner requires; choose a new range and re-address`,
          );
          cidr = null;
        } else if (parsed[1] > 24) {
          decisions.push(
            `CIDR ${cidr} is smaller than Hetzner's minimum network size of /24; choose a larger range`,
          );
          cidr = null;
        } else if (inBlock(parseCidr("172.31.1.1/32")![0], parsed)) {
          decisions.push(
            `CIDR ${cidr} contains 172.31.1.1, which Hetzner reserves for its own routing; choose a different range (AWS default VPCs use 172.31.0.0/16)`,
          );
          cidr = null;
        }
      }
    }
    if (cidr) globalArguments.ip_range = cidr;

    // Hetzner subnets are a list inside the network. Subnet resources from
    // other clouds are not mapped one by one: a single cloud subnet covering
    // the whole network range stands in for all of them.
    const location = knownLocation(target.region);
    if (location && cidr) {
      globalArguments.subnets = [{
        type: "cloud",
        ip_range: cidr,
        network_zone: LOCATION_ZONES[location],
      }];
      losses.push(
        "Hetzner subnets live inside the network: one cloud subnet covering the whole network range is created, and source subnets are not mapped individually",
      );
    } else if (!location) {
      decisions.push(unknownLocationDecision(target.region));
    }

    const lab = renderLabels(p, globalArguments);
    losses.push(...lab.losses);
    return {
      behaviorType: network.behaviorType,
      globalArguments,
      expected: { cidr, labels: lab.labels },
      losses,
      decisions,
    };
  },
  validateName: plainNameProblems,
};

// ---------------------------------------------------------------------------
// firewall (@swamp/hetzner-cloud/firewalls)

/** Hetzner allows 50 rules per firewall. */
const MAX_FIREWALL_RULES = 50;
const ALL_PORTS = "1-65535";

/** Hetzner state rules → canonical rules. */
function firewallRulesFrom(rules: unknown): FirewallRule[] {
  const out: FirewallRule[] = [];
  for (const raw of arr(rules)) {
    const r = obj(raw);
    if (!r) continue;
    const ingress = r.direction !== "out";
    const port = str(r.port);
    const protocol = str(r.protocol) ?? "all";
    out.push({
      direction: ingress ? "ingress" : "egress",
      protocol,
      ports: protocol === "tcp" || protocol === "udp"
        ? (port === null || port === "any" || port === ALL_PORTS ? null : port)
        : null,
      cidrs: arr(ingress ? r.source_ips : r.destination_ips).filter((
        x,
      ): x is string => typeof x === "string"),
    });
  }
  return out;
}

const firewall: KindAdapter = {
  behaviorType: "@swamp/hetzner-cloud/firewalls",
  idField: "id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = idOf(a.id) ?? "";
    const name = str(a.name) ?? id;
    if (!Array.isArray(a.rules)) unknownFields.push("rules");
    return {
      id: canonicalId("hetzner", "firewall", id),
      provider: "hetzner",
      kind: "firewall",
      nativeId: id,
      aliases: [name].filter((x) => x && x !== id),
      name,
      // Firewalls are project-wide, not tied to a location.
      region: regionFallback,
      source: { behaviorType: firewall.behaviorType, behaviorName },
      properties: {
        // Hetzner firewalls have no description field.
        description: null,
        rules: firewallRulesFrom(a.rules),
        labels: stringMap(a.labels),
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const rules: Record<string, unknown>[] = [];
    const expectedRules: FirewallRule[] = [];

    for (const raw of arr(p.rules)) {
      const r = obj(raw);
      if (!r) continue;
      const ingress = r.direction !== "egress";
      const cidrs = arr(r.cidrs).filter((x): x is string =>
        typeof x === "string"
      );
      const protocol = String(r.protocol ?? "all");
      const label = `${r.direction} ${protocol}${r.ports ? ` ${r.ports}` : ""}`;
      if (cidrs.length === 0) {
        losses.push(
          `rule "${label}" has no CIDRs (Hetzner needs at least one) and is dropped`,
        );
        continue;
      }
      // "all" has no Hetzner equivalent; esp and gre are not covered by it here.
      const protocols = protocol === "all"
        ? ["tcp", "udp", "icmp"]
        : [protocol];
      if (protocol === "all") {
        losses.push(
          `rule "${label}" expands to tcp, udp and icmp rules (Hetzner has no "all"); esp and gre are not included`,
        );
      }
      for (const proto of protocols) {
        if (!["tcp", "udp", "icmp", "esp", "gre"].includes(proto)) {
          losses.push(
            `rule "${label}" uses protocol "${proto}", which Hetzner does not support; dropped`,
          );
          continue;
        }
        const portful = proto === "tcp" || proto === "udp";
        const ports = portful
          ? (typeof r.ports === "string" ? r.ports : null)
          : null;
        const rule: Record<string, unknown> = {
          direction: ingress ? "in" : "out",
          protocol: proto,
          [ingress ? "source_ips" : "destination_ips"]: cidrs,
        };
        if (portful) rule.port = ports ?? ALL_PORTS;
        rules.push(rule);
        expectedRules.push({
          direction: ingress ? "ingress" : "egress",
          protocol: proto,
          ports,
          cidrs,
        });
      }
    }
    if (rules.length > MAX_FIREWALL_RULES) {
      decisions.push(
        `${rules.length} rules exceed Hetzner's limit of ${MAX_FIREWALL_RULES} per firewall; merge or split them`,
      );
    }
    if (rules.some((r) => r.direction === "out")) {
      losses.push(
        "once a Hetzner firewall has any outbound rule, all other outbound traffic is blocked; check the source's egress rules are complete",
      );
    }
    if (typeof p.description === "string" && p.description) {
      losses.push("Hetzner firewalls have no description field; it is dropped");
    }
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      rules,
    };
    const lab = renderLabels(p, globalArguments);
    losses.push(...lab.losses);
    return {
      behaviorType: firewall.behaviorType,
      globalArguments,
      expected: { rules: expectedRules, labels: lab.labels },
      losses,
      decisions,
    };
  },
  validateName: plainNameProblems,
};

// ---------------------------------------------------------------------------
// vm (@swamp/hetzner-cloud/servers)

interface ServerType {
  name: string;
  family: "cx" | "cpx" | "cax" | "ccx";
  architecture: "x86_64" | "arm64";
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  /** No longer orderable: kept to size existing source servers, never chosen as a target. */
  deprecated: boolean;
}

const row = (
  name: string,
  family: ServerType["family"],
  vcpus: number,
  memoryGiB: number,
  diskGiB: number,
  deprecated = false,
): ServerType => ({
  name,
  family,
  architecture: family === "cax" ? "arm64" : "x86_64",
  vcpus,
  memoryMiB: memoryGiB * 1024,
  diskGiB,
  deprecated,
});

/**
 * Server types. The pulled @swamp/hetzner-cloud schema lists no type names,
 * so this follows Hetzner's catalogue as of November 2026: CX Gen3 (cx23-cx53)
 * and CPX Gen2 (cpx12-cpx62) replaced CX Gen2 and CPX Gen1 in October 2025,
 * and CAX (Arm) and CCX (dedicated) are unchanged. The replaced types can no
 * longer be created in the Console; they stay here, marked deprecated, so
 * existing source servers still size correctly, and are never chosen as a
 * target. cx and cax are sold in the EU locations only; cpx and ccx
 * everywhere. Sizing reads this table rather than calling the API (the
 * server-types behavior is not a dependency of a migration).
 */
export const SERVER_TYPES: ServerType[] = [
  row("cx23", "cx", 2, 4, 40),
  row("cx33", "cx", 4, 8, 80),
  row("cx43", "cx", 8, 16, 160),
  row("cx53", "cx", 16, 32, 320),
  row("cpx12", "cpx", 1, 2, 40),
  row("cpx22", "cpx", 2, 4, 80),
  row("cpx32", "cpx", 4, 8, 160),
  row("cpx42", "cpx", 8, 16, 320),
  row("cpx52", "cpx", 12, 24, 480),
  row("cpx62", "cpx", 16, 32, 640),
  row("cax11", "cax", 2, 4, 40),
  row("cax21", "cax", 4, 8, 80),
  row("cax31", "cax", 8, 16, 160),
  row("cax41", "cax", 16, 32, 320),
  row("ccx13", "ccx", 2, 8, 80),
  row("ccx23", "ccx", 4, 16, 160),
  row("ccx33", "ccx", 8, 32, 240),
  row("ccx43", "ccx", 16, 64, 360),
  row("ccx53", "ccx", 32, 128, 600),
  row("ccx63", "ccx", 48, 192, 960),
  // Replaced in October 2025; sizing existing servers only.
  row("cx22", "cx", 2, 4, 40, true),
  row("cx32", "cx", 4, 8, 80, true),
  row("cx42", "cx", 8, 16, 160, true),
  row("cx52", "cx", 16, 32, 320, true),
  row("cpx11", "cpx", 2, 2, 40, true),
  row("cpx21", "cpx", 3, 4, 80, true),
  row("cpx31", "cpx", 4, 8, 160, true),
  row("cpx41", "cpx", 8, 16, 240, true),
  row("cpx51", "cpx", 16, 32, 360, true),
];

const FAMILY_ORDER = { cx: 0, cpx: 1, cax: 2, ccx: 3 };

/**
 * The smallest server type with at least the wanted vCPUs and memory, for
 * the architecture and location. Smallest means least memory, then fewest
 * vCPUs, then the cheaper line (cx, cpx, cax, ccx). Null when none fits.
 */
export function chooseServerType(
  vcpus: number,
  memoryMiB: number,
  architecture: string,
  location: string | null,
): ServerType | null {
  const eu = location === null || EU_LOCATIONS.has(location);
  return SERVER_TYPES
    .filter((t) =>
      !t.deprecated &&
      t.architecture === architecture && t.vcpus >= vcpus &&
      t.memoryMiB >= memoryMiB &&
      (eu || (t.family !== "cx" && t.family !== "cax"))
    )
    .sort((a, b) =>
      a.memoryMiB - b.memoryMiB || a.vcpus - b.vcpus ||
      FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family]
    )[0] ?? null;
}

/** RFC 1123 hostname labels, joined by dots. */
function hostnameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length < 1 || name.length > 253) {
    problems.push(`"${name}" must be 1-253 characters`);
  }
  for (const label of name.split(".")) {
    if (label.length < 1 || label.length > 63) {
      problems.push(
        `"${name}": each dot-separated label must be 1-63 characters`,
      );
      break;
    }
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      problems.push(
        `"${name}": labels may only use letters, digits and "-", and must start and end with a letter or digit (RFC 1123)`,
      );
      break;
    }
  }
  return problems;
}

const vm: KindAdapter = {
  behaviorType: "@swamp/hetzner-cloud/servers",
  idField: "id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = idOf(a.id) ?? "";
    const name = str(a.name) ?? id;
    const type = obj(a.server_type);
    const machineType = track(unknownFields, "machineType", str(type?.name));
    const vcpus = track(unknownFields, "vcpus", num(type?.cores));
    const memoryGiB = num(type?.memory);
    const memoryMiB = track(
      unknownFields,
      "memoryMiB",
      memoryGiB === null ? null : Math.round(memoryGiB * 1024),
    );
    const arch = str(type?.architecture);
    const architecture = track(
      unknownFields,
      "architecture",
      arch === "x86" ? "x86_64" : arch === "arm" ? "arm64" : null,
    );
    const image = obj(a.image);
    const imageName = track(
      unknownFields,
      "image",
      str(image?.name) ?? str(image?.description) ?? idOf(image?.id),
    );
    const net = obj(a.public_net);
    const publicIp = net === null
      ? track(unknownFields, "publicIp", null)
      : obj(net.ipv4) !== null || obj(net.ipv6) !== null;
    const bootDiskGiB = track(
      unknownFields,
      "bootDiskGiB",
      num(a.primary_disk_size),
    );
    const region = locationName(a) ?? regionFallback;
    if (region === null) unknownFields.push("region");

    const refs: ResourceRef[] = [];
    for (const n of arr(a.private_net)) {
      refs.push(...ref("network", obj(n)?.network, "private_net"));
    }
    for (const f of arr(net?.firewalls)) {
      refs.push(...ref("firewall", obj(f)?.id, "public_net.firewalls"));
    }
    // A volume is attached to a server; the server lists it, so the server
    // depends on the volume and the volume record does not point back.
    for (const v of arr(a.volumes)) {
      refs.push(...ref("block-volume", v, "volumes"));
    }

    return {
      id: canonicalId("hetzner", "vm", id),
      provider: "hetzner",
      kind: "vm",
      nativeId: id,
      aliases: [name].filter((x) => x && x !== id),
      name,
      region,
      source: { behaviorType: vm.behaviorType, behaviorName },
      properties: {
        machineType,
        vcpus,
        memoryMiB,
        architecture,
        image: imageName,
        publicIp,
        bootDiskGiB,
        labels: stringMap(a.labels),
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
    const globalArguments: Record<string, unknown> = { name: targetName };

    const location = knownLocation(target.region);
    if (location) globalArguments.location = location;
    else decisions.push(unknownLocationDecision(target.region));

    // Size: smallest server type that fits the source's vCPUs and memory.
    let architecture = typeof p.architecture === "string"
      ? p.architecture
      : null;
    if (architecture === null) {
      architecture = "x86_64";
      losses.push(
        "source architecture is unknown; x86_64 is assumed for the server type",
      );
    }
    const vcpus = num(p.vcpus);
    const memoryMiB = num(p.memoryMiB);
    let chosen: ServerType | null = null;
    if (vcpus === null || memoryMiB === null) {
      decisions.push(
        "source vCPUs or memory are unknown; choose a Hetzner server type",
      );
    } else {
      chosen = chooseServerType(vcpus, memoryMiB, architecture, location);
      if (chosen) {
        globalArguments.server_type = chosen.name;
        losses.push(
          `source size (${vcpus} vCPU, ${memoryMiB} MiB, ${architecture}) maps to Hetzner ${chosen.name} (${chosen.vcpus} vCPU, ${chosen.memoryMiB} MiB, ${chosen.diskGiB} GiB disk), the smallest that fits`,
        );
      } else {
        decisions.push(
          `no Hetzner server type offers ${vcpus} vCPU and ${memoryMiB} MiB on ${architecture}${
            location && !EU_LOCATIONS.has(location) ? ` in ${location}` : ""
          }; split the workload or choose a type by hand`,
        );
      }
    }
    // Hetzner's disk is fixed by the server type.
    const wantDisk = num(p.bootDiskGiB);
    if (chosen && wantDisk !== null && wantDisk > chosen.diskGiB) {
      losses.push(
        `source boot disk is ${wantDisk} GiB but ${chosen.name} has ${chosen.diskGiB} GiB; attach a volume for the rest`,
      );
    }

    // Image: names and ids are per provider, and `image` is required to create.
    decisions.push(
      `choose a Hetzner image (e.g. ubuntu-24.04) for this server${
        typeof p.image === "string" ? `; the source image is "${p.image}"` : ""
      }; \`image\` is required and not set here`,
    );

    // Public networking: both families are on by default.
    if (p.publicIp === false) {
      globalArguments.public_net = { enable_ipv4: false, enable_ipv6: false };
      losses.push(
        "source has no public IP; the Hetzner server is created without public IPv4/IPv6 and has no internet egress unless the network has a NAT gateway",
      );
    }

    // Dependencies.
    const networks = dependencyRefs(context, "network");
    if (networks.exprs.length > 0) globalArguments.networks = networks.exprs;
    if (networks.missing.length > 0) {
      decisions.push(
        `network(s) ${
          networks.missing.join(", ")
        } are not part of the migration; attach the server to a Hetzner network by hand`,
      );
    }
    if (
      networks.exprs.length === 0 && context.dependencies("subnet").length > 0
    ) {
      decisions.push(
        "the source sits in a subnet; Hetzner has no subnet resource, so attach the server to a Hetzner network (the one holding the migrated subnet range)",
      );
    }
    const firewalls = dependencyRefs(context, "firewall");
    if (firewalls.exprs.length > 0) {
      globalArguments.firewalls = firewalls.exprs.map((f) => ({ firewall: f }));
    }
    if (firewalls.missing.length > 0) {
      decisions.push(
        `firewall(s) ${
          firewalls.missing.join(", ")
        } are not part of the migration; apply a Hetzner firewall by hand`,
      );
    }
    const volumes = dependencyRefs(context, "block-volume");
    if (volumes.exprs.length > 0) {
      globalArguments.volumes = volumes.exprs;
      losses.push(
        "volumes attach at server creation and must be in the same Hetzner location as the server",
      );
    }
    if (volumes.missing.length > 0) {
      decisions.push(
        `volume(s) ${
          volumes.missing.join(", ")
        } are not part of the migration; attach volumes by hand`,
      );
    }
    if (context.dependencies("iam-principal").length > 0) {
      losses.push(
        "workload identities (IAM roles / service accounts) have no Hetzner equivalent and are dropped",
      );
    }

    const lab = renderLabels(p, globalArguments);
    losses.push(...lab.losses);
    return {
      behaviorType: vm.behaviorType,
      globalArguments,
      expected: {
        machineType: chosen?.name ?? null,
        vcpus: chosen?.vcpus ?? null,
        memoryMiB: chosen?.memoryMiB ?? null,
        architecture: chosen ? chosen.architecture : architecture,
        publicIp: typeof p.publicIp === "boolean" ? p.publicIp : null,
        bootDiskGiB: chosen?.diskGiB ?? null,
        labels: lab.labels,
      },
      losses,
      decisions,
    };
  },
  validateName: hostnameProblems,
};

// ---------------------------------------------------------------------------
// block-volume (@swamp/hetzner-cloud/volumes)

const MIN_VOLUME_GIB = 10;
const MAX_VOLUME_GIB = 10240;

const blockVolume: KindAdapter = {
  behaviorType: "@swamp/hetzner-cloud/volumes",
  idField: "id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = idOf(a.id) ?? "";
    const name = str(a.name) ?? id;
    const sizeGiB = track(unknownFields, "sizeGiB", num(a.size));
    const zone = track(unknownFields, "zone", locationName(a));
    return {
      id: canonicalId("hetzner", "block-volume", id),
      provider: "hetzner",
      kind: "block-volume",
      nativeId: id,
      aliases: [name].filter((x) => x && x !== id),
      name,
      region: zone ?? regionFallback,
      source: { behaviorType: blockVolume.behaviorType, behaviorName },
      properties: {
        sizeGiB,
        // Hetzner volumes are NVMe SSD, with no IOPS setting and no
        // platform encryption option.
        media: "ssd",
        iops: null,
        encryption: "none",
        zone,
        labels: stringMap(a.labels),
      },
      // The attached server is an attachment owned by the server record
      // (see the vm adapter), not a dependency of the volume.
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
    const globalArguments: Record<string, unknown> = { name: targetName };

    const location = knownLocation(target.region);
    if (location) globalArguments.location = location;
    else decisions.push(unknownLocationDecision(target.region));

    let size = num(p.sizeGiB);
    if (size === null) {
      decisions.push("source volume size is unknown; choose a size");
    } else {
      if (size < MIN_VOLUME_GIB) {
        losses.push(
          `source size ${size} GiB is below Hetzner's minimum; the volume is created at ${MIN_VOLUME_GIB} GB`,
        );
        size = MIN_VOLUME_GIB;
      } else if (size > MAX_VOLUME_GIB) {
        decisions.push(
          `source size ${size} GiB exceeds Hetzner's maximum of ${MAX_VOLUME_GIB} GB; split the data across volumes`,
        );
      }
      if (size <= MAX_VOLUME_GIB) globalArguments.size = Math.ceil(size);
    }
    if (p.media === "hdd") {
      losses.push(
        "all Hetzner volumes are SSD; the HDD media type is not available",
      );
    }
    if (typeof p.iops === "number") {
      losses.push(
        `provisioned IOPS (${p.iops}) cannot be set on Hetzner volumes`,
      );
    }
    if (p.encryption === "customer-key") {
      decisions.push(
        "source volume uses a customer-managed key; Hetzner has no platform encryption, so plan guest-side encryption (LUKS) when restoring data",
      );
    } else if (p.encryption === "provider-managed") {
      losses.push(
        "source volume is encrypted at rest by the provider; Hetzner volumes are not, so use guest-side encryption (LUKS) if needed",
      );
    }
    // Attach with the vm (its `volumes` argument), so no assignee is set.
    const lab = renderLabels(p, globalArguments);
    losses.push(...lab.losses);
    return {
      behaviorType: blockVolume.behaviorType,
      globalArguments,
      expected: {
        sizeGiB: typeof globalArguments.size === "number"
          ? globalArguments.size
          : null,
        media: "ssd",
        encryption: "none",
        labels: lab.labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    // Volume names are used as device paths; keep to a hostname-safe set.
    const problems: string[] = [];
    if (name.length < 1 || name.length > 64) {
      problems.push(`"${name}" must be 1-64 characters`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      problems.push(
        `"${name}" may only use letters, digits, ".", "_" and "-", starting with a letter or digit`,
      );
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// load-balancer (@swamp/hetzner-cloud/load-balancers)

interface LoadBalancerType {
  name: string;
  maxServices: number;
  maxTargets: number;
}

/** Hetzner's load balancer sizes and their service / target limits. */
const LOAD_BALANCER_TYPES: LoadBalancerType[] = [
  { name: "lb11", maxServices: 5, maxTargets: 25 },
  { name: "lb21", maxServices: 15, maxTargets: 75 },
  { name: "lb31", maxServices: 30, maxTargets: 150 },
];

const L7_PROTOCOLS = new Set(["http", "https"]);

const loadBalancer: KindAdapter = {
  behaviorType: "@swamp/hetzner-cloud/load-balancers",
  idField: "id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const id = idOf(a.id) ?? "";
    const name = str(a.name) ?? id;
    const enabled = bool(obj(a.public_net)?.enabled);
    const scheme = enabled === null
      ? track(unknownFields, "scheme", null)
      : enabled
      ? "internet"
      : "internal";
    const services = Array.isArray(a.services)
      ? a.services.map((s) => obj(s)).filter((s) => s !== null)
      : null;
    if (services === null) unknownFields.push("layer", "listeners");
    const listeners = (services ?? []).map((s) => ({
      protocol: str(s.protocol) ?? "tcp",
      port: num(s.listen_port),
    }));
    const layer = services === null
      ? null
      : listeners.some((l) => L7_PROTOCOLS.has(l.protocol))
      ? "application"
      : "network";
    const region = locationName(a) ?? regionFallback;
    if (region === null) unknownFields.push("region");

    const refs: ResourceRef[] = [];
    for (const n of arr(a.private_net)) {
      refs.push(...ref("network", obj(n)?.network, "private_net"));
    }
    for (const t of arr(a.targets)) {
      const target = obj(t);
      if (target?.type === "server") {
        refs.push(...ref("vm", obj(target.server)?.id, "targets"));
      }
    }
    return {
      id: canonicalId("hetzner", "load-balancer", id),
      provider: "hetzner",
      kind: "load-balancer",
      nativeId: id,
      aliases: [name].filter((x) => x && x !== id),
      name,
      region,
      source: { behaviorType: loadBalancer.behaviorType, behaviorName },
      properties: {
        scheme,
        layer,
        listeners: services === null ? null : listeners,
        labels: stringMap(a.labels),
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
    const globalArguments: Record<string, unknown> = { name: targetName };

    const location = knownLocation(target.region);
    if (location) globalArguments.location = location;
    else decisions.push(unknownLocationDecision(target.region));

    // Services: the behavior only accepts TCP, so HTTP(S) listeners become
    // plain TCP forwarding and UDP cannot be carried.
    const services: Record<string, unknown>[] = [];
    const listeners: { protocol: string; port: number }[] = [];
    for (const raw of arr(p.listeners)) {
      const l = obj(raw);
      const port = num(l?.port);
      const protocol = String(l?.protocol ?? "tcp").toLowerCase();
      if (port === null) continue;
      if (protocol === "udp") {
        losses.push(
          `UDP listener on port ${port} is dropped; Hetzner load balancers carry TCP only`,
        );
        continue;
      }
      if (services.some((s) => s.listen_port === port)) continue;
      if (protocol !== "tcp") {
        losses.push(
          `${protocol} listener on port ${port} becomes plain TCP forwarding; TLS termination, certificates and HTTP routing are not translated`,
        );
      }
      services.push({
        protocol: "tcp",
        listen_port: port,
        destination_port: port,
        proxyprotocol: false,
        health_check: {
          protocol: "tcp",
          port,
          interval: 15,
          timeout: 10,
          retries: 3,
        },
      });
      listeners.push({ protocol: "tcp", port });
    }
    if (services.length > 0) globalArguments.services = services;

    // Targets: servers in the migration, by id.
    const vms = dependencyRefs(context, "vm");
    if (vms.exprs.length > 0) {
      globalArguments.targets = vms.exprs.map((id) => ({
        type: "server",
        server: { id },
      }));
    }
    if (vms.missing.length > 0) {
      decisions.push(
        `target server(s) ${
          vms.missing.join(", ")
        } are not part of the migration; add targets by hand`,
      );
    }

    // Size: smallest type that holds the services and targets.
    const lbType = LOAD_BALANCER_TYPES.find((t) =>
      t.maxServices >= services.length && t.maxTargets >= vms.exprs.length
    );
    if (lbType) {
      globalArguments.load_balancer_type = lbType.name;
      losses.push(
        `Hetzner type ${lbType.name} is chosen for ${services.length} service(s) and ${vms.exprs.length} target(s); source capacity is not compared`,
      );
    } else {
      decisions.push(
        "more services or targets than the largest Hetzner load balancer (lb31) holds; split it",
      );
    }

    // Network and scheme.
    const networks = dependencyRefs(context, "network");
    if (networks.exprs.length > 0) {
      globalArguments.network = networks.exprs[0];
      if (networks.exprs.length > 1) {
        losses.push(
          "a Hetzner load balancer is attached to one network at creation; only the first network is attached",
        );
      }
    }
    if (networks.missing.length > 0) {
      decisions.push(
        `network(s) ${
          networks.missing.join(", ")
        } are not part of the migration; attach the load balancer to a Hetzner network by hand`,
      );
    }
    if (p.scheme === "internal") {
      globalArguments.public_interface = false;
      if (networks.exprs.length === 0) {
        decisions.push(
          "an internal load balancer needs a Hetzner network to attach to; add one to the migration",
        );
      }
    }
    if (context.dependencies("firewall").length > 0) {
      losses.push(
        "Hetzner load balancers do not take firewalls; apply the rules on the target servers instead",
      );
    }
    if (
      context.dependencies("subnet").length > 0 && networks.exprs.length === 0
    ) {
      decisions.push(
        "the source sits in a subnet; Hetzner has no subnet resource, so attach the load balancer to a Hetzner network",
      );
    }
    globalArguments.algorithm = { type: "round_robin" };

    const lab = renderLabels(p, globalArguments);
    losses.push(...lab.losses);
    return {
      behaviorType: loadBalancer.behaviorType,
      globalArguments,
      expected: {
        scheme: p.scheme === "internal" ? "internal" : "internet",
        layer: "network",
        listeners,
        labels: lab.labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems = plainNameProblems(name);
    return problems;
  },
};

// ---------------------------------------------------------------------------
// dns-zone (@swamp/hetzner-cloud/zones)

/** Second-level labels under which a registrable domain has three labels. */
const SECOND_LEVELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

const dnsZone: KindAdapter = {
  behaviorType: "@swamp/hetzner-cloud/zones",
  idField: "id",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    // The state is the zone object, or {id, zone: {...}} in the schema's nesting.
    const z = obj(a.zone) ?? a;
    const id = idOf(a.id) ?? idOf(z.id) ?? "";
    const domain = track(
      unknownFields,
      "domain",
      str(z.name)?.replace(/\.$/, "") ?? null,
    );
    return {
      id: canonicalId("hetzner", "dns-zone", id),
      provider: "hetzner",
      kind: "dns-zone",
      nativeId: id,
      aliases: [domain].filter((x): x is string => x !== null && x !== id),
      name: domain ?? id,
      // DNS zones are global.
      region: regionFallback,
      source: { behaviorType: dnsZone.behaviorType, behaviorName },
      properties: {
        domain,
        // Hetzner DNS has no private (VPC-only) zones.
        private: false,
        labels: stringMap(z.labels),
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    // The zone is named by the domain it serves, not the generated target name.
    const domain = typeof p.domain === "string"
      ? p.domain.toLowerCase()
      : targetName;
    if (typeof p.domain !== "string") {
      decisions.push(
        "source domain is unknown; the target name is used as the zone name",
      );
    }
    const parts = domain.split(".");
    if (
      parts.length >= 3 && !(parts.length === 3 && SECOND_LEVELS.has(parts[1]))
    ) {
      decisions.push(
        `"${domain}" looks like a subdomain; Hetzner zones must be registrable domains (a public suffix plus one label), so host it in the parent zone instead`,
      );
    }
    if (p.private === true) {
      decisions.push(
        "source is a private (VPC-only) zone; Hetzner DNS only has public zones, so this would be published to the internet",
      );
    }
    losses.push(
      "records are not read from the source zone's state; create them in the target zone separately",
    );
    const globalArguments: Record<string, unknown> = {
      name: domain,
      mode: "primary",
    };
    const lab = renderLabels(p, globalArguments);
    losses.push(...lab.losses);
    return {
      behaviorType: dnsZone.behaviorType,
      globalArguments,
      expected: { domain, private: false, labels: lab.labels },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length > 255) {
      problems.push(`"${name}" must be at most 255 characters`);
    }
    if (name !== name.toLowerCase()) {
      problems.push(`"${name}" must be lower case`);
    }
    if (name.endsWith(".")) problems.push(`"${name}" must not end with a dot`);
    return problems;
  },
};

/** The Hetzner Cloud provider adapter. */
export const hetzner: ProviderAdapter = {
  id: "hetzner",
  displayName: "Hetzner Cloud",
  kinds: {
    network,
    firewall,
    vm,
    "block-volume": blockVolume,
    "load-balancer": loadBalancer,
    "dns-zone": dnsZone,
  },
};

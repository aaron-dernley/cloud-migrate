/**
 * Google Cloud networking, compute, DNS, load balancing and Kubernetes adapters.
 * See ../kinds.ts for the canonical shapes and ../adapter.ts for the contract.
 *
 * The state attributes are the Compute / Cloud DNS / GKE REST JSON. Compute
 * resources reference each other by `selfLink` URL, so those kinds use
 * `selfLink` as their `idField` and as their `nativeId` (the short name and
 * numeric id are kept as aliases). Cloud DNS and GKE take plain names.
 *
 * @module
 */
import {
  arr,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  lastSegment,
  num,
  obj,
  type ProviderAdapter,
  type RenderContext,
  type ResourceRef,
  str,
  stringMap,
  type TargetSettings,
  toGcpLabels,
  track,
} from "../adapter.ts";
import type { FirewallRule, ResourceKind } from "../kinds.ts";

// ---------------------------------------------------------------------------
// Shared helpers

/** RFC1035 label rules used by networks, subnets, firewalls, instances, disks and zones. */
function rfc1035Problems(name: string): string[] {
  const problems: string[] = [];
  if (name.length < 1 || name.length > 63) {
    problems.push(`"${name}" must be 1-63 characters`);
  }
  if (!/^[a-z]/.test(name)) {
    problems.push(`"${name}" must start with a lowercase letter`);
  }
  if (!/^[a-z0-9-]*$/.test(name)) {
    problems.push(`"${name}" may only use lowercase letters, digits and "-"`);
  }
  if (/-$/.test(name)) problems.push(`"${name}" must not end with "-"`);
  return problems;
}

/** The id as a string, whether the API gave a string or a number. */
function idString(value: unknown): string | null {
  return typeof value === "number" ? String(value) : str(value);
}

/**
 * Other identifiers a compute resource is known by: self link, the host-less
 * path form of it (`projects/p/global/networks/n`, which Cloud SQL and
 * Memorystore use to name a network), numeric id, name.
 */
function aliasesOf(a: Record<string, unknown>, nativeId: string): string[] {
  const selfLink = str(a.selfLink);
  const path =
    selfLink?.match(/^https?:\/\/[^/]+\/(?:compute\/[^/]+\/)?(projects\/.+)$/)
      ?.[1] ?? null;
  const all = [selfLink, path, idString(a.id), str(a.name)];
  return [
    ...new Set(all.filter((x): x is string => x !== null && x !== nativeId)),
  ];
}

/** `europe-west2-a` → `europe-west2`. */
function regionOfZone(zone: string | null): string | null {
  return zone ? zone.replace(/-[a-z0-9]+$/, "") : null;
}

/**
 * Regions whose first zone is not "a". From memory of the GCP zone list (not
 * from a pulled schema): us-east1 has b, c, d; europe-west1 has b, c, d. Other
 * regions are assumed to have an "a" zone.
 */
const FIRST_ZONE_SUFFIX: Record<string, string> = {
  "us-east1": "b",
  "europe-west1": "b",
};

/** The zone every zonal resource is rendered into: the first zone of the region. */
export function firstZoneOf(region: string): string {
  return `${region}-${FIRST_ZONE_SUFFIX[region] ?? "a"}`;
}

function defaultZone(target: TargetSettings): string {
  return firstZoneOf(target.region);
}

/** The `project` global argument, or a decision when the target has no project. */
function projectArgs(
  target: TargetSettings,
  decisions: string[],
  what: string,
): Record<string, unknown> {
  if (target.project) return { project: target.project };
  decisions.push(`target.project is required to create ${what}`);
  return {};
}

/** Labels rewritten to GCP's rules, with the rewrite losses appended to `losses`. */
function gcpLabelsFor(
  p: Record<string, unknown>,
  losses: string[],
): Record<string, string> {
  const { labels, losses: l } = toGcpLabels(stringMap(p.labels));
  losses.push(...l);
  return labels;
}

/** A reference to the first dependency of `kind`, or null when there is none. */
function firstRef(
  context: RenderContext,
  kind: ResourceKind,
  field?: string,
): string | null {
  const id = context.dependencies(kind)[0];
  return id ? context.refTo(id, field) : null;
}

/** A ref to the resource a URL or name field points at, or no ref when the field is empty. */
function urlRef(
  kind: ResourceKind,
  value: unknown,
  via: string,
): ResourceRef[] {
  const s = str(value);
  return s ? [{ kind, nativeId: s, via }] : [];
}

const strings = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === "string");

// ---------------------------------------------------------------------------
// Machine types

interface MachineType {
  vcpus: number;
  memoryMiB: number;
  architecture: "x86_64" | "arm64";
}

/** Common predefined machine types. The order is the preference order when sizes tie. */
const MACHINE_TYPES: Record<string, MachineType> = {
  "e2-small": { vcpus: 2, memoryMiB: 2048, architecture: "x86_64" },
  "e2-medium": { vcpus: 2, memoryMiB: 4096, architecture: "x86_64" },
  "e2-standard-2": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64" },
  "e2-standard-4": { vcpus: 4, memoryMiB: 16384, architecture: "x86_64" },
  "e2-standard-8": { vcpus: 8, memoryMiB: 32768, architecture: "x86_64" },
  "e2-standard-16": { vcpus: 16, memoryMiB: 65536, architecture: "x86_64" },
  "n2-standard-2": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64" },
  "n2-standard-4": { vcpus: 4, memoryMiB: 16384, architecture: "x86_64" },
  "n2-standard-8": { vcpus: 8, memoryMiB: 32768, architecture: "x86_64" },
  "n2-standard-16": { vcpus: 16, memoryMiB: 65536, architecture: "x86_64" },
  "c3-standard-4": { vcpus: 4, memoryMiB: 16384, architecture: "x86_64" },
  "c3-standard-8": { vcpus: 8, memoryMiB: 32768, architecture: "x86_64" },
  "t2a-standard-1": { vcpus: 1, memoryMiB: 4096, architecture: "arm64" },
  "t2a-standard-2": { vcpus: 2, memoryMiB: 8192, architecture: "arm64" },
  "t2a-standard-4": { vcpus: 4, memoryMiB: 16384, architecture: "arm64" },
  "t2a-standard-8": { vcpus: 8, memoryMiB: 32768, architecture: "arm64" },
};

/** Regions that offer the Arm `t2a` series (Google's published list at time of writing). */
const T2A_REGIONS = ["us-central1", "europe-west4", "asia-southeast1"];

/** Size of a machine type: from the table, or parsed from `custom-<vcpus>-<memoryMiB>`. */
function machineSize(machineType: string | null): MachineType | null {
  if (!machineType) return null;
  const known = MACHINE_TYPES[machineType];
  if (known) return known;
  const custom = /^(?:[a-z0-9]+-)?custom-(\d+)-(\d+)/.exec(machineType);
  if (custom) {
    return {
      vcpus: Number(custom[1]),
      memoryMiB: Number(custom[2]),
      architecture: "x86_64",
    };
  }
  return null;
}

/** The smallest predefined type of `architecture` with at least this CPU and memory. */
function smallestFitting(
  vcpus: number,
  memoryMiB: number,
  architecture: string,
): string | null {
  const fits = Object.entries(MACHINE_TYPES).filter(([, m]) =>
    m.architecture === architecture && m.vcpus >= vcpus &&
    m.memoryMiB >= memoryMiB
  );
  // A stable sort keeps the table's preference order among equal sizes.
  fits.sort(([, a], [, b]) => a.vcpus - b.vcpus || a.memoryMiB - b.memoryMiB);
  return fits[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// network

const network: KindAdapter = {
  behaviorType: "@swamp/gcp/compute/networks",
  idField: "selfLink",
  normalise(a, behaviorName): CanonicalResource {
    const name = str(a.name) ?? "";
    const nativeId = str(a.selfLink) ?? name;
    return {
      id: canonicalId("gcp", "network", nativeId),
      provider: "gcp",
      kind: "network",
      nativeId,
      aliases: aliasesOf(a, nativeId),
      name,
      // VPC networks are global.
      region: null,
      source: { behaviorType: network.behaviorType, behaviorName },
      properties: {
        // A VPC network has no CIDR of its own; only legacy networks carry IPv4Range.
        cidr: str(a.IPv4Range),
        // Compute networks have no labels.
        labels: {},
      },
      refs: [],
      dependsOn: [],
      dataBytes: null,
      unknownFields: [],
    };
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      // Custom mode: subnets are created explicitly, which is what the mapping does.
      autoCreateSubnetworks: false,
      routingConfig: { routingMode: "REGIONAL" },
      ...projectArgs(target, decisions, "a VPC network"),
    };
    if (typeof p.cidr === "string") {
      losses.push(
        `network CIDR ${p.cidr} is not a property of a GCP VPC network; it moves to the subnets`,
      );
    }
    if (Object.keys(stringMap(p.labels)).length > 0) {
      losses.push("GCP VPC networks have no labels; they are dropped");
    }
    return {
      behaviorType: network.behaviorType,
      globalArguments,
      expected: { cidr: null, labels: {} },
      losses,
      decisions,
    };
  },
  validateName: rfc1035Problems,
};

// ---------------------------------------------------------------------------
// subnet

const subnet: KindAdapter = {
  behaviorType: "@swamp/gcp/compute/subnetworks",
  idField: "selfLink",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const nativeId = str(a.selfLink) ?? name;
    const region = lastSegment(a.region) ?? regionFallback;
    if (region === null) unknownFields.push("region");
    const cidr = track(unknownFields, "cidr", str(a.ipCidrRange));
    return {
      id: canonicalId("gcp", "subnet", nativeId),
      provider: "gcp",
      kind: "subnet",
      nativeId,
      aliases: aliasesOf(a, nativeId),
      name,
      region,
      source: { behaviorType: subnet.behaviorType, behaviorName },
      properties: {
        cidr,
        // GCP subnets are regional.
        zone: null,
        // Instances only get an external IP when they ask for an access config.
        publicIpOnLaunch: false,
        // Subnetworks have no labels.
        labels: {},
      },
      refs: urlRef("network", a.network, "network"),
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
      name: targetName,
      region: target.region,
      ...projectArgs(target, decisions, "a subnetwork"),
    };
    if (typeof p.cidr === "string") globalArguments.ipCidrRange = p.cidr;
    else {decisions.push(
        "the source subnet has no CIDR; choose an ipCidrRange for the target subnet",
      );}
    const net = firstRef(context, "network");
    if (net) globalArguments.network = net;
    else {
      decisions.push(
        "no network in the migration for this subnet; set `network` to an existing VPC network URL",
      );
    }
    if (p.zone) {
      losses.push(
        `the source subnet is zonal (${p.zone}); GCP subnets are regional`,
      );
    }
    if (p.publicIpOnLaunch === true) {
      losses.push(
        "GCP subnets cannot assign public IPs automatically; instances ask for an external IP individually",
      );
    }
    if (Object.keys(stringMap(p.labels)).length > 0) {
      losses.push("GCP subnetworks have no labels; they are dropped");
    }
    return {
      behaviorType: subnet.behaviorType,
      globalArguments,
      expected: {
        cidr: p.cidr ?? null,
        zone: null,
        publicIpOnLaunch: false,
        labels: {},
      },
      losses,
      decisions,
    };
  },
  validateName: rfc1035Problems,
};

// ---------------------------------------------------------------------------
// firewall

/**
 * Canonical rules from a GCP `allowed` list. One rule per (protocol, port);
 * an entry with no ports is a rule for all ports.
 */
function expandAllowed(
  allowed: unknown,
  direction: "ingress" | "egress",
  cidrs: string[],
): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const entry of arr(allowed)) {
    const e = obj(entry);
    const protocol = str(e?.IPProtocol)?.toLowerCase();
    if (!protocol) continue;
    const ports = strings(e?.ports);
    if (ports.length === 0) {
      rules.push({ direction, protocol, ports: null, cidrs });
    } else {for (const port of ports) {
        rules.push({ direction, protocol, ports: port, cidrs });
      }}
  }
  return rules;
}

/** Canonical rules → GCP `allowed` entries, one per protocol; an all-ports rule wins for its protocol. */
function collapseToAllowed(
  rules: FirewallRule[],
): { IPProtocol: string; ports?: string[] }[] {
  const byProtocol = new Map<string, string[] | null>();
  for (const r of rules) {
    if (r.protocol === "all" || r.ports === null) {
      byProtocol.set(r.protocol, null);
    } else if (byProtocol.get(r.protocol) !== null) {
      byProtocol.set(r.protocol, [
        ...(byProtocol.get(r.protocol) ?? []),
        r.ports,
      ]);
    }
  }
  return [...byProtocol].map((
    [IPProtocol, ports],
  ) => (ports ? { IPProtocol, ports } : { IPProtocol }));
}

/** Allow-everything egress is GCP's implied default rule, so it needs no resource. */
function isImpliedEgress(r: FirewallRule): boolean {
  return r.direction === "egress" && r.protocol === "all" &&
    r.cidrs.length > 0 &&
    r.cidrs.every((c) => c === "0.0.0.0/0" || c === "::/0");
}

const firewall: KindAdapter = {
  behaviorType: "@swamp/gcp/compute/firewalls",
  idField: "selfLink",
  /**
   * One canonical firewall per GCP firewall resource. A GCP rule is one
   * direction with one source/destination range list and a list of protocols
   * and ports, so its `allowed` entries expand to canonical rules that all
   * share one direction and cidr list. Properties the canonical form has no
   * place for are kept as extra properties (`targetTags`, `sourceTags`,
   * `deniedEntries`, `serviceAccountScoped`) so a GCP-to-GCP render can say
   * what it could not carry.
   */
  normalise(a, behaviorName): CanonicalResource {
    const name = str(a.name) ?? "";
    const nativeId = str(a.selfLink) ?? name;
    const direction = str(a.direction)?.toUpperCase() === "EGRESS"
      ? "egress"
      : "ingress";
    const cidrs = strings(
      direction === "egress" ? a.destinationRanges : a.sourceRanges,
    );
    return {
      id: canonicalId("gcp", "firewall", nativeId),
      provider: "gcp",
      kind: "firewall",
      nativeId,
      aliases: aliasesOf(a, nativeId),
      name,
      region: null,
      source: { behaviorType: firewall.behaviorType, behaviorName },
      properties: {
        description: str(a.description),
        rules: expandAllowed(a.allowed, direction, cidrs),
        // Compute firewalls have no labels.
        labels: {},
        targetTags: strings(a.targetTags),
        sourceTags: strings(a.sourceTags),
        // Deny entries have no canonical form (canonical rules are allow-only).
        deniedEntries: arr(a.denied).length,
        serviceAccountScoped: strings(a.targetServiceAccounts).length > 0 ||
          strings(a.sourceServiceAccounts).length > 0,
      },
      refs: urlRef("network", a.network, "network"),
      dependsOn: [],
      dataBytes: null,
      unknownFields: [],
    };
  },
  /**
   * GCP firewall rules are one direction with one range list, while a canonical
   * firewall is a rule set. This renders ONE GCP firewall: the first group of
   * rules sharing a direction and cidr list (ingress groups first). Every
   * other group becomes a decision naming the extra firewall it needs, so the
   * mapping is never silently incomplete. Allow-all egress is dropped because
   * GCP allows egress implicitly. Rules reach instances through the network tag
   * `<targetName>`, which the vm adapter puts on the VMs that used the source
   * firewall.
   */
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      ...projectArgs(target, decisions, "a firewall rule"),
    };
    if (typeof p.description === "string") {
      globalArguments.description = p.description;
    }
    const net = firstRef(context, "network");
    if (net) globalArguments.network = net;
    else {
      decisions.push(
        "no network in the migration for this firewall; set `network` (GCP otherwise uses the project's default network)",
      );
    }

    const fromGcp = resource.provider === "gcp";
    const sourceTags = fromGcp ? strings(p.sourceTags) : [];
    const all = arr(p.rules).map((r) => obj(r)).filter((r) =>
      r !== null
    ) as unknown as FirewallRule[];
    const rules = all.filter((r) => !isImpliedEgress(r));

    // A rule with no CIDRs references other groups or tags, which another cloud cannot express.
    const usable = rules.filter((r) =>
      r.cidrs.length > 0 || sourceTags.length > 0
    );
    if (rules.length > usable.length) {
      decisions.push(
        `${
          rules.length - usable.length
        } rule(s) reference other security groups instead of CIDR ranges; recreate them with network tags or service accounts on the target`,
      );
    }

    // Group by direction + cidr list: one GCP firewall holds exactly one group.
    const groups = new Map<string, FirewallRule[]>();
    for (const r of usable) {
      const key = `${r.direction}|${[...r.cidrs].sort().join(",")}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) =>
      Number(b.startsWith("ingress")) - Number(a.startsWith("ingress"))
    );
    const chosen = ordered[0]?.[1] ?? [];
    ordered.slice(1).forEach(([key, group], i) => {
      const [direction, cidrs] = key.split("|");
      decisions.push(
        `${group.length} ${direction} rule(s) for ${
          cidrs || "tag-scoped sources"
        } need a separate GCP firewall (one direction and range list per firewall): add one, for example "${targetName}-${direction}-${
          i + 2
        }", with the same target tag`,
      );
    });

    let renderedRules: FirewallRule[] = [];
    if (chosen.length > 0) {
      const direction = chosen[0].direction;
      const cidrs = chosen[0].cidrs;
      const allowed = collapseToAllowed(chosen);
      globalArguments.direction = direction === "egress" ? "EGRESS" : "INGRESS";
      globalArguments.allowed = allowed;
      if (cidrs.length > 0) {
        globalArguments[
          direction === "egress" ? "destinationRanges" : "sourceRanges"
        ] = cidrs;
      } else globalArguments.sourceTags = sourceTags;
      renderedRules = expandAllowed(allowed, direction, cidrs);
    } else {
      decisions.push(
        "no rule on this firewall can be carried over as a GCP allow rule; add rules by hand",
      );
    }

    // GCP rules apply to instances through network tags (or service accounts).
    if (fromGcp) {
      const tags = strings(p.targetTags);
      if (tags.length > 0) globalArguments.targetTags = tags;
      if (p.serviceAccountScoped === true) {
        decisions.push(
          "the source rule targets service accounts; set target/source service accounts on the target",
        );
      }
    } else {
      globalArguments.targetTags = [targetName];
      decisions.push(
        `GCP firewall rules attach to instances through network tags, not group membership: this rule targets the tag "${targetName}", which the migrated VMs that used this group carry; any other instance needs the tag added`,
      );
    }
    if (typeof p.deniedEntries === "number" && p.deniedEntries > 0) {
      decisions.push(
        `${p.deniedEntries} deny entr(ies) in the source are not carried over (canonical rules are allow-only); recreate them with an explicit priority`,
      );
    }
    if (Object.keys(stringMap(p.labels)).length > 0) {
      losses.push("GCP firewall rules have no labels; they are dropped");
    }
    return {
      behaviorType: firewall.behaviorType,
      globalArguments,
      expected: {
        description: p.description ?? null,
        rules: renderedRules,
        labels: {},
      },
      losses,
      decisions,
    };
  },
  validateName: rfc1035Problems,
};

// ---------------------------------------------------------------------------
// block-volume (disks)

const DISK_MEDIA: Record<string, string> = {
  "pd-standard": "hdd",
  "pd-balanced": "ssd",
  "pd-ssd": "ssd",
  "pd-extreme": "ssd",
};

/** `…/cryptoKeys/k/cryptoKeyVersions/1` → `…/cryptoKeys/k`. */
function stripKeyVersion(key: string): string {
  return key.replace(/\/cryptoKeyVersions\/.*$/, "");
}

const blockVolume: KindAdapter = {
  behaviorType: "@swamp/gcp/compute/disks",
  idField: "selfLink",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const nativeId = str(a.selfLink) ?? name;
    const zone = track(unknownFields, "zone", lastSegment(a.zone));
    const sizeGiB = track(unknownFields, "sizeGiB", num(a.sizeGb));
    const typeName = lastSegment(a.type);
    const media = typeName
      ? DISK_MEDIA[typeName] ??
        (typeName.startsWith("hyperdisk") ? "ssd" : null)
      : null;
    if (media === null) unknownFields.push("media");
    const kmsKey = str(obj(a.diskEncryptionKey)?.kmsKeyName);
    return {
      id: canonicalId("gcp", "block-volume", nativeId),
      provider: "gcp",
      kind: "block-volume",
      nativeId,
      aliases: aliasesOf(a, nativeId),
      name,
      region: regionOfZone(zone) ?? regionFallback,
      source: { behaviorType: blockVolume.behaviorType, behaviorName },
      properties: {
        sizeGiB,
        media,
        iops: num(a.provisionedIops),
        // Persistent disks are always encrypted; a KMS key makes it customer-managed.
        encryption: kmsKey ? "customer-key" : "provider-managed",
        zone,
        labels: stringMap(a.labels),
      },
      refs: kmsKey
        ? [{
          kind: "kms-key",
          nativeId: stripKeyVersion(kmsKey),
          via: "diskEncryptionKey.kmsKeyName",
        }]
        : [],
      dependsOn: [],
      dataBytes: sizeGiB !== null ? sizeGiB * 1024 ** 3 : null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const zone = defaultZone(target);
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      zone,
      ...projectArgs(target, decisions, "a persistent disk"),
    };
    losses.push(
      `the disk is created in zone ${zone}; a zonal disk attaches only to VMs in the same zone, which the migrated VMs also use`,
    );
    const size = typeof p.sizeGiB === "number" ? Math.ceil(p.sizeGiB) : null;
    if (size !== null && size !== p.sizeGiB) {
      losses.push(
        `size ${p.sizeGiB} GiB is rounded up to ${size} GiB (whole numbers only)`,
      );
    }
    if (size !== null) globalArguments.sizeGb = String(size);
    else {decisions.push(
        "the source volume size is unknown; set sizeGb on the target disk",
      );}
    if (p.media !== "hdd" && p.media !== "ssd") {
      losses.push(
        "the source volume media is unknown; an SSD persistent disk (pd-ssd) is used",
      );
    }
    globalArguments.type = `zones/${zone}/diskTypes/${
      p.media === "hdd" ? "pd-standard" : "pd-ssd"
    }`;
    if (typeof p.iops === "number") {
      losses.push(
        `provisioned IOPS (${p.iops}) are not carried over; pd-ssd performance scales with size (use a hyperdisk type if you need provisioned IOPS)`,
      );
    }
    let encryption = p.encryption ?? null;
    if (p.encryption === "customer-key") {
      const key = firstRef(context, "kms-key");
      if (key) globalArguments.diskEncryptionKey = { kmsKeyName: key };
      else {
        decisions.push(
          "the source volume uses a customer-managed key; add its key to the migration or choose a Cloud KMS key for diskEncryptionKey",
        );
        encryption = null;
      }
    } else if (p.encryption === "none") {
      losses.push(
        "GCP persistent disks are always encrypted at rest; the target uses Google-managed keys",
      );
      encryption = "provider-managed";
    }
    const labels = gcpLabelsFor(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    return {
      behaviorType: blockVolume.behaviorType,
      globalArguments,
      expected: {
        sizeGiB: size,
        media: p.media === "hdd" ? "hdd" : "ssd",
        iops: null,
        encryption,
        zone,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName: rfc1035Problems,
};

// ---------------------------------------------------------------------------
// vm (instances)

/** Marks the boot-disk ref so render can tell it from data disks. */
const BOOT_DISK_VIA = "disks[boot].source";

const vm: KindAdapter = {
  behaviorType: "@swamp/gcp/compute/instances",
  idField: "selfLink",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const nativeId = str(a.selfLink) ?? name;
    const zone = lastSegment(a.zone);
    const region = regionOfZone(zone) ?? regionFallback;
    if (region === null) unknownFields.push("region");

    // The record only has a machineType URL; sizes come from the table (or a custom-<n>-<mib> name).
    const machineType = track(
      unknownFields,
      "machineType",
      lastSegment(a.machineType),
    );
    const size = machineSize(machineType);
    const vcpus = track(unknownFields, "vcpus", size?.vcpus ?? null);
    const memoryMiB = track(
      unknownFields,
      "memoryMiB",
      size?.memoryMiB ?? null,
    );
    const architecture = track(
      unknownFields,
      "architecture",
      size?.architecture ?? null,
    );

    const disks = arr(a.disks).map((d) => obj(d)).filter((d) => d !== null);
    const boot = disks.find((d) => d.boot === true) ?? null;
    const init = obj(boot?.initializeParams);
    const image = track(unknownFields, "image", str(init?.sourceImage));
    const bootDiskGiB = track(
      unknownFields,
      "bootDiskGiB",
      num(boot?.diskSizeGb) ?? num(init?.diskSizeGb),
    );

    const ifaces = arr(a.networkInterfaces).map((i) => obj(i)).filter((i) =>
      i !== null
    );
    const publicIp = ifaces.length === 0
      ? null
      : ifaces.some((i) => arr(i.accessConfigs).length > 0);
    if (publicIp === null) unknownFields.push("publicIp");

    const refs: ResourceRef[] = [];
    ifaces.forEach((iface, i) => {
      refs.push(
        ...urlRef(
          "subnet",
          iface.subnetwork,
          `networkInterfaces[${i}].subnetwork`,
        ),
      );
      refs.push(
        ...urlRef("network", iface.network, `networkInterfaces[${i}].network`),
      );
    });
    disks.forEach((d, i) => {
      refs.push(
        ...urlRef(
          "block-volume",
          d.source,
          d.boot === true ? BOOT_DISK_VIA : `disks[${i}].source`,
        ),
      );
    });
    // Best effort: a service account email is the principal's alias.
    arr(a.serviceAccounts).forEach((s, i) => {
      refs.push(
        ...urlRef(
          "iam-principal",
          obj(s)?.email,
          `serviceAccounts[${i}].email`,
        ),
      );
    });
    // Firewalls reach a VM through network tags, which name no resource: no ref, by design.

    return {
      id: canonicalId("gcp", "vm", nativeId),
      provider: "gcp",
      kind: "vm",
      nativeId,
      aliases: aliasesOf(a, nativeId),
      name,
      region,
      source: { behaviorType: vm.behaviorType, behaviorName },
      properties: {
        machineType,
        vcpus,
        memoryMiB,
        architecture,
        image,
        publicIp,
        bootDiskGiB,
        labels: stringMap(a.labels),
        // Beyond the canonical form: the tags firewall rules target.
        networkTags: strings(obj(a.tags)?.items),
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
    const zone = defaultZone(target);
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      zone,
      ...projectArgs(target, decisions, "a Compute Engine instance"),
    };
    losses.push(
      `the VM is placed in zone ${zone}; change the zone if you need another`,
    );

    // Sizing: keep a GCP type we know, otherwise the smallest same-architecture type that fits.
    const sourceType = typeof p.machineType === "string" ? p.machineType : null;
    const arch = p.architecture === "arm64" ? "arm64" : "x86_64";
    if (p.architecture !== "arm64" && p.architecture !== "x86_64") {
      losses.push('the source architecture is unknown; assuming "x86_64"');
    }
    let machineType: string | null = null;
    if (resource.provider === "gcp" && sourceType && machineSize(sourceType)) {
      machineType = sourceType;
    } else if (typeof p.vcpus === "number" && typeof p.memoryMiB === "number") {
      machineType = smallestFitting(p.vcpus, p.memoryMiB, arch);
      if (machineType) {
        const m = MACHINE_TYPES[machineType];
        losses.push(
          `machine type ${
            sourceType ?? "(unknown)"
          } (${p.vcpus} vCPU, ${p.memoryMiB} MiB) becomes ${machineType} (${m.vcpus} vCPU, ${m.memoryMiB} MiB)`,
        );
      } else {
        decisions.push(
          `no ${arch} machine type in the built-in table has ${p.vcpus} vCPU and ${p.memoryMiB} MiB; choose one (or a custom type) for the target`,
        );
      }
    } else {
      decisions.push(
        "the source VM size is unknown; choose a machine type for the target",
      );
    }
    const picked = machineType ? machineSize(machineType) : null;
    if (machineType) {
      globalArguments.machineType = `zones/${zone}/machineTypes/${machineType}`;
      if (
        picked?.architecture === "arm64" && !T2A_REGIONS.includes(target.region)
      ) {
        decisions.push(
          `Arm (t2a) machines are only offered in ${
            T2A_REGIONS.join(", ")
          }; ${target.region} has none, so pick another region or an x86_64 type`,
        );
      }
    }

    // Disks: the boot disk is its own block-volume when it is in the migration.
    const bootRefInfo = resource.refs.find((r) => r.via === BOOT_DISK_VIA);
    const bootId = bootRefInfo
      ? canonicalId(resource.provider, "block-volume", bootRefInfo.nativeId)
      : null;
    const disks: Record<string, unknown>[] = [];
    const bootRef = bootId ? context.refTo(bootId) : null;
    if (bootRef) disks.push({ boot: true, autoDelete: true, source: bootRef });
    for (const id of context.dependencies("block-volume")) {
      if (id === bootId) continue;
      const ref = context.refTo(id);
      if (ref) disks.push({ boot: false, autoDelete: false, source: ref });
    }
    if (!bootRef) {
      // No image is invented: images are not portable, so the person picks one.
      const initializeParams: Record<string, unknown> = {};
      if (typeof p.bootDiskGiB === "number") {
        initializeParams.diskSizeGb = String(p.bootDiskGiB);
      }
      disks.unshift({ boot: true, autoDelete: true, initializeParams });
      decisions.push(
        "the boot disk has no image: set disks[0].initializeParams.sourceImage to an image of the same OS and version",
      );
    }
    globalArguments.disks = disks;

    // Network interface.
    const sub = firstRef(context, "subnet");
    const net = firstRef(context, "network");
    const iface: Record<string, unknown> = {};
    if (sub) iface.subnetwork = sub;
    if (net) iface.network = net;
    if (!sub && !net) {
      decisions.push(
        "no subnet or network in the migration for this VM; set networkInterfaces (GCP otherwise uses the project's default network)",
      );
    }
    if (p.publicIp === true) {
      iface.accessConfigs = [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }];
    }
    globalArguments.networkInterfaces = [iface];

    // Network tags: the firewall rules rendered for its source groups target these.
    const tags = new Set<string>();
    if (resource.provider === "gcp") {
      for (const t of strings(p.networkTags)) tags.add(t);
    }
    for (const id of context.dependencies("firewall")) {
      const fwName = context.targetNameOf(id);
      if (fwName) tags.add(fwName);
    }
    if (tags.size > 0) globalArguments.tags = { items: [...tags] };

    // Service account (best effort).
    const sa = firstRef(context, "iam-principal", "email");
    if (sa) {
      globalArguments.serviceAccounts = [{
        email: sa,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }];
      losses.push(
        "the VM's service account gets the cloud-platform access scope; limit what it can do with IAM roles",
      );
    }

    const labels = gcpLabelsFor(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;

    return {
      behaviorType: vm.behaviorType,
      globalArguments,
      expected: {
        machineType,
        vcpus: picked?.vcpus ?? null,
        memoryMiB: picked?.memoryMiB ?? null,
        architecture: picked?.architecture ?? null,
        image: null,
        publicIp: typeof p.publicIp === "boolean" ? p.publicIp : null,
        bootDiskGiB: typeof p.bootDiskGiB === "number" ? p.bootDiskGiB : null,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName: rfc1035Problems,
};

// ---------------------------------------------------------------------------
// load-balancer (forwarding rules)

type Listener = { protocol: string; port: number | string };

/** One listener per port; a range stays a "<from>-<to>" string, all ports is "all". */
function listenersOf(a: Record<string, unknown>): Listener[] {
  const protocol = (str(a.IPProtocol) ?? "TCP").toUpperCase();
  if (a.allPorts === true) return [{ protocol, port: "all" }];
  const ports = strings(a.ports);
  const specs = ports.length > 0
    ? ports
    : [str(a.portRange)].filter((x): x is string => x !== null);
  return specs.map((spec) => {
    const [from, to] = spec.split("-");
    const single = to === undefined || to === from;
    return {
      protocol,
      port: single && /^\d+$/.test(from) ? Number(from) : spec,
    };
  });
}

const loadBalancer: KindAdapter = {
  behaviorType: "@swamp/gcp/compute/forwardingrules",
  idField: "selfLink",
  /**
   * A forwarding rule is the frontend of a GCP load balancer: scheme, protocol,
   * ports and the network it listens on. Backend services, URL maps, proxies
   * and certificates are separate resources this extension does not model, so
   * only the frontend is normalised and rendered (regional forwarding rules;
   * global ones are `globalforwardingrules` and are not covered).
   */
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const nativeId = str(a.selfLink) ?? name;
    const scheme = track(unknownFields, "scheme", str(a.loadBalancingScheme));
    const targetUrl = str(a.target) ?? "";
    const application = scheme?.endsWith("_MANAGED") === true ||
      /targetHttps?Prox/i.test(targetUrl);
    const listeners = listenersOf(a);
    if (listeners.length === 0) unknownFields.push("listeners");
    return {
      id: canonicalId("gcp", "load-balancer", nativeId),
      provider: "gcp",
      kind: "load-balancer",
      nativeId,
      aliases: aliasesOf(a, nativeId),
      name,
      region: lastSegment(a.region) ?? regionFallback,
      source: { behaviorType: loadBalancer.behaviorType, behaviorName },
      properties: {
        scheme: scheme === null
          ? null
          : scheme.startsWith("INTERNAL")
          ? "internal"
          : "internet",
        layer: scheme === null ? null : application ? "application" : "network",
        listeners,
        labels: stringMap(a.labels),
      },
      refs: [
        ...urlRef("network", a.network, "network"),
        ...urlRef("subnet", a.subnetwork, "subnetwork"),
      ],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const internal = p.scheme === "internal";
    const application = p.layer === "application";
    const scheme = application
      ? internal ? "INTERNAL_MANAGED" : "EXTERNAL_MANAGED"
      : internal
      ? "INTERNAL"
      : "EXTERNAL";
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      region: target.region,
      loadBalancingScheme: scheme,
      ...projectArgs(target, decisions, "a forwarding rule"),
    };

    // A forwarding rule has exactly one protocol: keep the first, flag the rest.
    const listeners = arr(p.listeners).map((l) => obj(l)).filter((l) =>
      l !== null
    );
    const protocolOf = (l: Record<string, unknown>) =>
      String(l.protocol ?? "TCP").toUpperCase();
    const first = listeners[0] ? protocolOf(listeners[0]) : "TCP";
    const sameProtocol = listeners.filter((l) => protocolOf(l) === first);
    // Proxy-based (application) rules take a single port.
    const kept = application ? sameProtocol.slice(0, 1) : sameProtocol;
    // HTTP(S) load balancers forward TCP to their proxy.
    const gcpProtocol = application || first === "HTTP" || first === "HTTPS"
      ? "TCP"
      : first;
    globalArguments.IPProtocol = gcpProtocol;
    const ports = kept.map((l) => l.port);
    if (ports.includes("all")) globalArguments.allPorts = true;
    else if (application && ports[0] !== undefined) {
      globalArguments.portRange = String(ports[0]);
    } else if (ports.length > 0) globalArguments.ports = ports.map(String);
    if (listeners.length > kept.length) {
      decisions.push(
        `${listeners.length - kept.length} listener(s) use another protocol${
          application ? " or port" : ""
        } than the rendered forwarding rule (${gcpProtocol}); a forwarding rule has one protocol${
          application ? " and one port" : ""
        }, so add a forwarding rule for each`,
      );
    }

    if (internal) {
      const net = firstRef(context, "network");
      const sub = firstRef(context, "subnet");
      if (net) globalArguments.network = net;
      if (sub) globalArguments.subnetwork = sub;
      if (!net || !sub) {
        decisions.push(
          "an internal load balancer needs a network and subnetwork; add them to the migration or set them by hand",
        );
      }
    }
    decisions.push(
      application
        ? "an application load balancer also needs a URL map, target proxy and backend service: only the forwarding rule is rendered; set `target` to the proxy"
        : "the backend service (or target pool) and health check behind the forwarding rule are not rendered: set `backendService`",
    );
    const labels = gcpLabelsFor(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    return {
      behaviorType: loadBalancer.behaviorType,
      globalArguments,
      expected: {
        scheme: internal ? "internal" : "internet",
        layer: application ? "application" : "network",
        listeners: kept.map((l) => ({ protocol: protocolOf(l), port: l.port })),
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName: rfc1035Problems,
};

// ---------------------------------------------------------------------------
// dns-zone (managed zones)

/** `example.com.` → `example.com`. */
function stripDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/** `example.com` → `example.com.` */
function withDot(name: string): string {
  return name.endsWith(".") ? name : `${name}.`;
}

const dnsZone: KindAdapter = {
  behaviorType: "@swamp/gcp/dns/managedzones",
  idField: "name",
  normalise(a, behaviorName): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const dnsName = str(a.dnsName);
    const domain = track(
      unknownFields,
      "domain",
      dnsName ? stripDot(dnsName) : null,
    );
    const networks = arr(obj(a.privateVisibilityConfig)?.networks).map((n) =>
      obj(n)
    ).filter((n) => n !== null);
    return {
      id: canonicalId("gcp", "dns-zone", name),
      provider: "gcp",
      kind: "dns-zone",
      nativeId: name,
      aliases: [idString(a.id)].filter((x): x is string =>
        x !== null && x !== name
      ),
      name,
      region: null,
      source: { behaviorType: dnsZone.behaviorType, behaviorName },
      // The API omits visibility on some public zones, so only "private" is private.
      properties: {
        domain,
        private: str(a.visibility) === "private",
        labels: stringMap(a.labels),
      },
      refs: networks.flatMap((n, i) =>
        urlRef(
          "network",
          n.networkUrl,
          `privateVisibilityConfig.networks[${i}].networkUrl`,
        )
      ),
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
      name: targetName,
      visibility: p.private === true ? "private" : "public",
      ...projectArgs(target, decisions, "a managed zone"),
    };
    // Cloud DNS wants the trailing dot.
    if (typeof p.domain === "string") {
      globalArguments.dnsName = withDot(p.domain);
    } else {decisions.push(
        "the source zone has no domain; set dnsName on the target zone",
      );}
    // Cloud DNS requires a description; name where the zone came from.
    globalArguments.description =
      `Migrated from ${resource.provider} zone ${resource.name}`;
    if (p.private === true) {
      const networks = context.dependencies("network")
        .map((id) => context.refTo(id))
        .filter((r): r is string => r !== null);
      if (networks.length > 0) {
        globalArguments.privateVisibilityConfig = {
          networks: networks.map((networkUrl) => ({ networkUrl })),
        };
      } else {
        decisions.push(
          "a private zone needs at least one VPC network to resolve it; add one to the migration",
        );
      }
    }
    const labels = gcpLabelsFor(p, losses);
    if (Object.keys(labels).length > 0) globalArguments.labels = labels;
    return {
      behaviorType: dnsZone.behaviorType,
      globalArguments,
      expected: {
        domain: p.domain ?? null,
        private: p.private === true,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems = rfc1035Problems(name);
    // Zone names, unlike the base rule, may not end in "-" (already covered) and must end alphanumeric.
    if (name.length > 0 && !/[a-z0-9]$/.test(name) && !/-$/.test(name)) {
      problems.push(`"${name}" must end with a letter or digit`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// dns-record (resource record sets)

/** Types whose value (or its last field) is a domain name, which Cloud DNS wants dot-terminated. */
const NAME_VALUED_TYPES = new Set(["CNAME", "NS", "PTR", "MX", "SRV", "DNAME"]);

/** Record types Cloud DNS accepts. */
const CLOUD_DNS_TYPES = new Set([
  "A",
  "AAAA",
  "CAA",
  "CNAME",
  "DNAME",
  "DNSKEY",
  "DS",
  "HTTPS",
  "IPSECKEY",
  "MX",
  "NAPTR",
  "NS",
  "PTR",
  "SOA",
  "SPF",
  "SRV",
  "SSHFP",
  "SVCB",
  "TLSA",
  "TXT",
]);

/** Apply `fn` to the domain name in a record value: the whole value, or the last field of MX and SRV. */
function mapNameInValue(
  type: string,
  value: string,
  fn: (name: string) => string,
): string {
  if (!NAME_VALUED_TYPES.has(type)) return value;
  if (type === "MX" || type === "SRV") {
    const fields = value.trim().split(/\s+/);
    fields[fields.length - 1] = fn(fields[fields.length - 1]);
    return fields.join(" ");
  }
  return fn(value);
}

const dnsRecord: KindAdapter = {
  behaviorType: "@swamp/gcp/dns/resourcerecordsets",
  idField: "name",
  /**
   * The canonical name is `<fqdn>-<type>` in lowercase (an A and an MX record
   * can share one DNS name, and target behavior names must be unique);
   * `properties.name` carries the real DNS name. The state only names its
   * zone when `managedZone` was set on the behavior, so a record without it
   * has an unknown zone and no zone ref.
   */
  normalise(a, behaviorName): CanonicalResource {
    const unknownFields: string[] = [];
    const rawName = str(a.name);
    const fqdn = rawName ? stripDot(rawName) : "";
    const type = (str(a.type) ?? "").toUpperCase();
    // The resourcerecordsets state has no zone field; `managedZone` is only a
    // global argument, so read it only if a caller (a snapshot) supplied it.
    const zone = str(a.managedZone);
    if (zone === null) unknownFields.push("zone");
    const values = strings(a.rrdatas).map((v) =>
      mapNameInValue(type, v, stripDot)
    );
    // Without a zone, same-name records of one type in two zones share a
    // nativeId and collide; the zone is not recoverable from the state.
    const nativeId = `${zone ?? ""}/${fqdn}/${type}`;
    return {
      id: canonicalId("gcp", "dns-record", nativeId),
      provider: "gcp",
      kind: "dns-record",
      nativeId,
      aliases: [],
      name: `${fqdn}-${type.toLowerCase()}`,
      region: null,
      source: { behaviorType: dnsRecord.behaviorType, behaviorName },
      properties: {
        name: fqdn,
        type,
        ttl: track(unknownFields, "ttl", num(a.ttl)),
        values,
      },
      refs: urlRef("dns-zone", zone, "managedZone"),
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, _targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const type = String(p.type ?? "").toUpperCase();
    // The record keeps its DNS name; `targetName` only names the swamp behavior.
    const fqdn = typeof p.name === "string" ? p.name : stripDot(resource.name);
    // Cloud DNS needs the full name: "@" or a bare label is relative to an unknown zone.
    const qualified = typeof p.name === "string" && fqdn !== "@" &&
      fqdn.includes(".");
    if (!qualified) {
      decisions.push(
        `the record's full DNS name is unknown ("${fqdn}" is relative to a domain the source did not give): set \`name\` to the fully qualified name`,
      );
    }
    const values = strings(p.values);
    const globalArguments: Record<string, unknown> = {
      ...(qualified ? { name: withDot(fqdn) } : {}),
      type,
      rrdatas: values.map((v) => mapNameInValue(type, v, withDot)),
      ...projectArgs(target, decisions, "a record set"),
    };
    if (typeof p.ttl === "number") globalArguments.ttl = p.ttl;
    const zone = firstRef(context, "dns-zone");
    if (zone) globalArguments.managedZone = zone;
    else {
      decisions.push(
        "no DNS zone in the migration for this record; set `managedZone` to an existing Cloud DNS zone name",
      );
    }
    if (!CLOUD_DNS_TYPES.has(type)) {
      decisions.push(
        `Cloud DNS does not support "${type}" records (for example provider alias records); replace it with a supported type`,
      );
    }
    if (type === "SOA") {
      decisions.push(
        "Cloud DNS creates and manages the SOA record itself; leave this record out of the migration",
      );
    }
    if (type === "TXT" && values.some((v) => !v.startsWith('"'))) {
      decisions.push(
        "Cloud DNS expects TXT values wrapped in double quotes; check the quoting of the migrated values",
      );
    }
    return {
      behaviorType: dnsRecord.behaviorType,
      globalArguments,
      expected: {
        name: qualified ? fqdn : null,
        type,
        ttl: p.ttl ?? null,
        values,
      },
      losses,
      decisions,
    };
  },
  /** The target name here is a DNS name plus a type suffix, not an RFC1035 label. */
  validateName(name) {
    const problems: string[] = [];
    if (name.length === 0 || name.length > 253) {
      problems.push(`"${name}" must be 1-253 characters`);
    }
    if (!/^[a-z0-9_*.-]+$/.test(name)) {
      problems.push(
        `"${name}" may only use lowercase letters, digits, "-", "_", "*" and "."`,
      );
    }
    if (name.split(".").some((label) => label.length > 63)) {
      problems.push(`"${name}" has a DNS label longer than 63 characters`);
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// kubernetes-cluster (GKE)

/** `1.30.2-gke.1234` → `1.30`. */
function minorVersion(version: string | null): string | null {
  const m = version ? /^(\d+\.\d+)/.exec(version) : null;
  return m ? m[1] : null;
}

const gke: KindAdapter = {
  behaviorType: "@swamp/gcp/container/clusters",
  idField: "name",
  normalise(a, behaviorName, regionFallback): CanonicalResource {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const location = str(a.location);
    // A zonal cluster has a location like europe-west2-a; a regional one europe-west2.
    const region = location
      ? (/-[a-z]$/.test(location) ? regionOfZone(location) : location)
      : regionFallback;
    if (region === null) unknownFields.push("region");
    const version = track(
      unknownFields,
      "version",
      minorVersion(str(a.currentMasterVersion) ?? str(a.initialClusterVersion)),
    );
    const pools = arr(a.nodePools).map((n) => obj(n)).filter((n) => n !== null);
    const poolNodes = pools.length > 0
      ? pools.reduce((sum, n) => sum + (num(n.initialNodeCount) ?? 0), 0)
      : null;
    const nodeCount = track(
      unknownFields,
      "nodeCount",
      num(a.currentNodeCount) ?? poolNodes,
    );
    const priv = obj(a.privateClusterConfig);
    // No privateClusterConfig on a full record (it has a status) means a public endpoint.
    const privateEndpoint = priv
      ? priv.enablePrivateEndpoint === true
      : str(a.status) !== null
      ? false
      : null;
    if (privateEndpoint === null) unknownFields.push("privateEndpoint");
    const nodeSa = str(obj(a.nodeConfig)?.serviceAccount);
    return {
      id: canonicalId("gcp", "kubernetes-cluster", name),
      provider: "gcp",
      kind: "kubernetes-cluster",
      nativeId: name,
      aliases: [str(a.selfLink), idString(a.id)].filter((x): x is string =>
        x !== null && x !== name
      ),
      name,
      region,
      source: { behaviorType: gke.behaviorType, behaviorName },
      properties: {
        version,
        nodeCount,
        privateEndpoint,
        labels: stringMap(a.resourceLabels),
      },
      refs: [
        // Both are plain names (or paths); the network's and subnet's aliases include their names.
        ...urlRef("network", a.network, "network"),
        ...urlRef("subnet", a.subnetwork, "subnetwork"),
        ...(nodeSa && nodeSa !== "default"
          ? [{
            kind: "iam-principal" as const,
            nativeId: nodeSa,
            via: "nodeConfig.serviceAccount",
          }]
          : []),
      ],
      dependsOn: [],
      dataBytes: null,
      unknownFields,
    };
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const cluster: Record<string, unknown> = { name: targetName };
    const globalArguments: Record<string, unknown> = {
      name: targetName,
      parent: `projects/${
        target.project ?? "PROJECT"
      }/locations/${target.region}`,
      cluster,
      ...(target.project ? { project: target.project } : {}),
    };
    if (!target.project) {
      decisions.push("target.project is required to create a GKE cluster");
    }

    if (typeof p.version === "string") {
      cluster.initialClusterVersion = p.version;
      losses.push(
        `Kubernetes ${p.version} is requested as a version prefix; GKE picks the latest available ${p.version}.x patch`,
      );
    }
    // GKE takes names for network and subnetwork.
    const net = firstRef(context, "network", "name");
    const sub = firstRef(context, "subnet", "name");
    if (net) cluster.network = net;
    if (sub) cluster.subnetwork = sub;
    if (!net) {
      decisions.push(
        "no network in the migration for this cluster; the target uses the project's default network unless you set `cluster.network`",
      );
    }

    // The cluster is regional, so initialNodeCount applies per zone (three zones assumed).
    let nodeCount: number | null = null;
    if (typeof p.nodeCount === "number") {
      const perZone = Math.max(1, Math.ceil(p.nodeCount / 3));
      cluster.initialNodeCount = perZone;
      nodeCount = perZone * 3;
      if (nodeCount !== p.nodeCount) {
        losses.push(
          `${p.nodeCount} nodes become ${nodeCount} (${perZone} in each of 3 zones of a regional cluster)`,
        );
      }
    } else {
      cluster.initialNodeCount = 1;
      losses.push(
        "the source node count is unknown; the cluster starts with 1 node per zone",
      );
    }

    if (p.privateEndpoint === true) {
      cluster.privateClusterConfig = {
        enablePrivateNodes: true,
        enablePrivateEndpoint: true,
      };
      cluster.ipAllocationPolicy = { useIpAliases: true };
      decisions.push(
        "a private GKE control plane needs a /28 range: set cluster.privateClusterConfig.masterIpv4CidrBlock to one that does not overlap your networks",
      );
    }
    const sa = firstRef(context, "iam-principal", "email");
    if (sa) cluster.nodeConfig = { serviceAccount: sa };

    const labels = gcpLabelsFor(p, losses);
    if (Object.keys(labels).length > 0) cluster.resourceLabels = labels;
    return {
      behaviorType: gke.behaviorType,
      globalArguments,
      expected: {
        version: p.version ?? null,
        nodeCount,
        privateEndpoint: p.privateEndpoint === true,
        labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    const problems: string[] = [];
    if (name.length < 1 || name.length > 40) {
      problems.push(`"${name}" must be 1-40 characters on GKE`);
    }
    if (!/^[a-z]/.test(name)) {
      problems.push(`"${name}" must start with a lowercase letter`);
    }
    if (!/^[a-z0-9-]*$/.test(name)) {
      problems.push(`"${name}" may only use lowercase letters, digits and "-"`);
    }
    if (/-$/.test(name)) problems.push(`"${name}" must not end with "-"`);
    return problems;
  },
};

/** Kind adapters merged into the provider in its main file. */
export const gcpInfraKinds: ProviderAdapter["kinds"] = {
  network,
  subnet,
  firewall,
  vm,
  "block-volume": blockVolume,
  "load-balancer": loadBalancer,
  "dns-zone": dnsZone,
  "dns-record": dnsRecord,
  "kubernetes-cluster": gke,
};

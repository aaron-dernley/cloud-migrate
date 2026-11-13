/**
 * DigitalOcean adapters, over the official `@swamp/digitalocean/*`
 * behaviors. Their `state` attributes are the DigitalOcean API's JSON field
 * names (the raw API object, so a few fields vary by type: `region` is a slug
 * string on VPCs, databases, Kubernetes and NFS but an object with a `slug`
 * on droplets, volumes and load balancers).
 *
 * Skipped kinds, with no fitting `@swamp/digitalocean` type: `object-bucket`
 * (only Spaces access keys exist, no bucket type), `subnet` (VPC subnets are
 * not a type), `message-topic`, `message-queue`, `nosql-table`, `kms-key`,
 * `secret` and `iam-principal`. `function` is left out too: function
 * namespaces do not map onto a single function.
 *
 * Secrets are never read: database cluster state carries connection URIs and
 * passwords, so those adapters pick named fields instead of copying the record.
 *
 * @module
 */
import {
  arr,
  canonicalId,
  type CanonicalResource,
  type KindAdapter,
  labelsToStringTags,
  num,
  obj,
  type ProviderAdapter,
  type RenderContext,
  type ResourceRef,
  str,
  stringTagsToLabels,
  track,
} from "../adapter.ts";
import type { FirewallRule, ResourceKind } from "../kinds.ts";

// ---------------------------------------------------------------------------
// Shared helpers

type Props = Record<string, unknown>;

/** A region slug from a string (`nyc3`) or a `{ slug }` object, else the fallback. */
function regionSlug(value: unknown, fallback: string | null): string | null {
  return str(value) ?? str(obj(value)?.slug) ?? fallback;
}

/** The `id` of a record as a string (droplet and record ids are numbers, the rest UUIDs). */
function idOf(a: Props): string {
  const n = num(a.id);
  return str(a.id) ?? (n !== null ? String(n) : "");
}

/** Assemble a canonical resource; every DigitalOcean adapter shares this shape. */
function make(
  kind: ResourceKind,
  behaviorType: string,
  behaviorName: string,
  nativeId: string,
  aliases: unknown[],
  name: string,
  region: string | null,
  properties: Props,
  refs: ResourceRef[],
  unknownFields: string[],
  dataBytes: number | null = null,
): CanonicalResource {
  const names = aliases.map((x) => str(x)).filter((x): x is string =>
    x !== null
  );
  return {
    id: canonicalId("digitalocean", kind, nativeId),
    provider: "digitalocean",
    kind,
    nativeId,
    aliases: [...new Set(names)].filter((x) => x !== nativeId),
    name,
    region,
    source: { behaviorType, behaviorName },
    properties,
    refs,
    dependsOn: [],
    dataBytes,
    unknownFields,
  };
}

/** The label map a canonical resource carries, `{}` when absent. */
function labelsOf(p: Props): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(p.labels) ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Labels as DigitalOcean tags. Tags are plain strings limited to letters,
 * digits, `:`, `-` and `_` (255 chars), so labels become `key:value` strings
 * and anything else is rewritten. `labels` is what the target will show.
 */
function toDoTags(
  labels: Record<string, string>,
): { tags: string[]; labels: Record<string, string>; losses: string[] } {
  const losses: string[] = [];
  const keys = Object.keys(labels);
  const tags = labelsToStringTags(labels).map((tag, i) => {
    const clean = tag.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 255);
    if (clean !== tag) {
      losses.push(
        `label "${
          keys[i]
        }" becomes tag "${clean}" (DigitalOcean tags allow letters, digits, ":", "-", "_")`,
      );
    }
    return clean;
  });
  if (tags.length > 0) {
    losses.push(
      `DigitalOcean tags are plain strings, so ${tags.length} label(s) become "key:value" tags rather than key/value pairs`,
    );
  }
  return { tags, labels: stringTagsToLabels(tags), losses };
}

/** Loss for labels on a resource type that has no tags at all. */
function untaggable(what: string, labels: Record<string, string>): string[] {
  const n = Object.keys(labels).length;
  return n > 0
    ? [`${what} cannot be tagged on DigitalOcean: ${n} label(s) are dropped`]
    : [];
}

/** vCPUs and memory from a slug such as `s-2vcpu-4gb` or `db-s-2vcpu-4gb`. */
function parseSlug(
  slug: string | null,
): { vcpus: number; memoryMiB: number } | null {
  const m = slug?.match(/(\d+)vcpu-(\d+)gb/);
  return m ? { vcpus: Number(m[1]), memoryMiB: Number(m[2]) * 1024 } : null;
}

interface Size {
  slug: string;
  vcpus: number;
  memoryMiB: number;
}

function sizeFromSlug(slug: string): Size {
  return { slug, ...parseSlug(slug)! };
}

/**
 * Droplet sizes, x86_64 only. Shared-CPU `s-` sizes come first (cheapest),
 * then the dedicated families (CPU-optimised `c-`, general purpose `g-`,
 * memory-optimised `m-`) by vCPUs then memory.
 */
const DROPLET_SIZES: Size[] = [
  ...[
    "s-1vcpu-1gb",
    "s-1vcpu-2gb",
    "s-2vcpu-2gb",
    "s-2vcpu-4gb",
    "s-4vcpu-8gb",
    "s-8vcpu-16gb",
  ].map(sizeFromSlug),
  ...[
    ...["c-2", "c-4", "c-8", "c-16", "c-32"].map((slug) => {
      // CPU-optimised sizes carry 2 GiB per vCPU.
      const vcpus = Number(slug.slice(2));
      return { slug, vcpus, memoryMiB: vcpus * 2 * 1024 };
    }),
    ...[
      "g-2vcpu-8gb",
      "g-4vcpu-16gb",
      "g-8vcpu-32gb",
      "g-16vcpu-64gb",
      "g-32vcpu-128gb",
      "g-40vcpu-160gb",
      "m-2vcpu-16gb",
      "m-4vcpu-32gb",
      "m-8vcpu-64gb",
      "m-16vcpu-128gb",
      "m-24vcpu-192gb",
      "m-32vcpu-256gb",
    ].map(sizeFromSlug),
  ].sort((a, b) => a.vcpus - b.vcpus || a.memoryMiB - b.memoryMiB),
];

/** Managed database node sizes (shared CPU), smallest first. */
const DB_SIZES: Size[] = [
  "db-s-1vcpu-1gb",
  "db-s-1vcpu-2gb",
  "db-s-2vcpu-4gb",
  "db-s-4vcpu-8gb",
  "db-s-6vcpu-16gb",
  "db-s-8vcpu-32gb",
  "db-s-16vcpu-64gb",
].map(sizeFromSlug);

/** The first size in `table` with at least `vcpus` and `memoryMiB`; null when none fits. */
function smallestFit(
  table: Size[],
  vcpus: number,
  memoryMiB: number,
): Size | null {
  return table.find((s) => s.vcpus >= vcpus && s.memoryMiB >= memoryMiB) ??
    null;
}

/** Loss text when the chosen size differs from what was asked. */
function sizeLoss(want: string, size: Size): string {
  return `source size ${want} is rendered as ${size.slug} (${size.vcpus} vCPU, ${
    size.memoryMiB / 1024
  } GiB), the smallest DigitalOcean size that fits`;
}

/** `value` as a CIDR: bare IPs get /32 (IPv4) or /128 (IPv6). */
function toCidr(value: string): string {
  if (value.includes("/")) return value;
  return value.includes(":") ? `${value}/128` : `${value}/32`;
}

/** Name problems for a pattern-and-length rule. */
function nameProblems(
  name: string,
  pattern: RegExp,
  max: number,
  rule: string,
  min = 1,
): string[] {
  const problems: string[] = [];
  if (name.length < min || name.length > max) {
    problems.push(`"${name}" must be ${min}-${max} characters`);
  }
  if (!pattern.test(name)) problems.push(`"${name}" ${rule}`);
  return problems;
}

/** The first migrated dependency of `kind`, as a CEL expression, or null. */
function depRef(context: RenderContext, kind: ResourceKind): string | null {
  return depRefs(context, kind)[0] ?? null;
}

/** Every migrated dependency of `kind` as CEL expressions (the adapter's idField). */
function depRefs(context: RenderContext, kind: ResourceKind): string[] {
  return context.dependencies(kind)
    .map((id) => context.refTo(id))
    .filter((x): x is string => x !== null);
}

// ---------------------------------------------------------------------------
// network (vpc)

const vpc: KindAdapter = {
  behaviorType: "@swamp/digitalocean/vpc",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    return make(
      "network",
      vpc.behaviorType,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        cidr: track(unknownFields, "cidr", str(a.ip_range)),
        // VPCs have no tags.
        labels: {},
      },
      [],
      unknownFields,
    );
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const losses = untaggable("a VPC", labelsOf(p));
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };
    let cidr: string | null = null;
    if (typeof p.cidr === "string") {
      const m = p.cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
      const first = m ? Number(m[1]) : -1;
      const second = m ? Number(m[2]) : -1;
      const prefix = m ? Number(m[5]) : -1;
      const rfc1918 = first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
      if (m && rfc1918 && prefix >= 16 && prefix <= 28) {
        cidr = p.cidr;
        globalArguments.ip_range = cidr;
      } else {
        decisions.push(
          `source CIDR ${p.cidr} is not an RFC1918 range between /16 and /28, which DigitalOcean requires: choose a new ip_range and renumber the resources in it`,
        );
      }
    } else {
      losses.push(
        "source CIDR is unknown, so DigitalOcean picks a free /20 range",
      );
    }
    return {
      behaviorType: vpc.behaviorType,
      globalArguments,
      expected: { cidr, labels: {} },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-zA-Z0-9.-]+$/,
      255,
      'may only contain letters, digits, "-" and "."',
    );
  },
};

// ---------------------------------------------------------------------------
// firewall

/** Ports meaning "all ports" in DigitalOcean (and none for ICMP). */
const ALL_PORTS = new Set(["", "0", "all", "1-65535", "0-65535"]);

/** DigitalOcean rules in one direction → canonical rules plus what could not be expressed. */
function doRules(
  direction: "ingress" | "egress",
  rules: unknown,
  endpointKey: "sources" | "destinations",
): { rules: FirewallRule[]; notes: string[] } {
  const out: FirewallRule[] = [];
  const notes: string[] = [];
  for (const raw of arr(rules)) {
    const r = obj(raw);
    if (!r) continue;
    const protocol = (str(r.protocol) ?? "tcp").toLowerCase();
    const ports = str(r.ports);
    const portLabel = ports ?? "all ports";
    const ep = obj(r[endpointKey]) ?? {};
    if (str(r.action) === "deny") {
      notes.push(
        `${direction} deny rule for ${protocol} ${portLabel} is not representable`,
      );
      continue;
    }
    const cidrs = arr(ep.addresses).filter((x): x is string =>
      typeof x === "string"
    )
      .map(toCidr);
    const droplets = arr(ep.droplet_ids).length;
    const tags = arr(ep.tags).filter((x): x is string => typeof x === "string");
    const lbs = arr(ep.load_balancer_uids).length;
    const k8s = arr(ep.kubernetes_ids).length;
    if (droplets + tags.length + lbs + k8s > 0) {
      const parts = [
        droplets ? `${droplets} droplet(s)` : "",
        tags.length ? `tag(s) ${tags.join(", ")}` : "",
        lbs ? `${lbs} load balancer(s)` : "",
        k8s ? `${k8s} Kubernetes cluster(s)` : "",
      ].filter(Boolean).join(", ");
      notes.push(
        `${direction} ${protocol} ${portLabel} ${
          direction === "ingress" ? "from" : "to"
        } ${parts} (not an address range)`,
      );
    }
    if (cidrs.length === 0) continue;
    out.push({
      direction,
      protocol,
      ports: protocol === "icmp" || ports === null || ALL_PORTS.has(ports)
        ? null
        : ports,
      cidrs,
    });
  }
  return { rules: out, notes };
}

const firewall: KindAdapter = {
  behaviorType: "@swamp/digitalocean/firewall",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    if (a.inbound_rules === undefined && a.outbound_rules === undefined) {
      unknownFields.push("rules");
    }
    const ingress = doRules("ingress", a.inbound_rules, "sources");
    const egress = doRules("egress", a.outbound_rules, "destinations");
    return make(
      "firewall",
      firewall.behaviorType,
      behaviorName,
      nativeId,
      [name],
      name,
      // Firewalls are account-wide, not regional.
      regionFallback,
      {
        description: null,
        rules: [...ingress.rules, ...egress.rules],
        // Firewall `tags` select the droplets it protects; they are not labels on the firewall.
        labels: {},
        // What the firewall is attached to, and rule endpoints that are not
        // address ranges. Not canonical; render turns the notes into decisions.
        attachedDropletIds: arr(a.droplet_ids).map((x) => num(x)).filter((x) =>
          x !== null
        ),
        attachedTags: arr(a.tags).filter((x): x is string =>
          typeof x === "string"
        ),
        unrepresented: [...ingress.notes, ...egress.notes],
      },
      [],
      unknownFields,
    );
  },
  render(resource, targetName) {
    const p = resource.properties;
    const losses = untaggable("a firewall", labelsOf(p));
    const decisions: string[] = [];
    const rules = (Array.isArray(p.rules) ? p.rules : []) as FirewallRule[];

    // DigitalOcean has tcp, udp and icmp only; "all" expands to the three.
    const expected: FirewallRule[] = [];
    for (const direction of ["ingress", "egress"] as const) {
      for (const rule of rules.filter((r) => r.direction === direction)) {
        if (rule.cidrs.length === 0) {
          decisions.push(
            `${direction} ${rule.protocol} rule has no CIDR ranges (it references tags, groups or service accounts); DigitalOcean needs addresses, so recreate it by hand`,
          );
        } else if (rule.protocol === "all") {
          for (const protocol of ["tcp", "udp", "icmp"]) {
            expected.push({
              ...rule,
              protocol,
              ports: protocol === "icmp" ? null : rule.ports,
            });
          }
        } else if (["tcp", "udp", "icmp"].includes(rule.protocol)) {
          expected.push({
            ...rule,
            ports: rule.protocol === "icmp" ? null : rule.ports,
          });
        } else {
          decisions.push(
            `${direction} protocol "${rule.protocol}" is not supported by DigitalOcean firewalls (tcp, udp, icmp only)`,
          );
        }
      }
    }
    const toDo = (direction: "ingress" | "egress") =>
      expected.filter((r) => r.direction === direction).map((r) => ({
        protocol: r.protocol,
        ports: r.ports ?? (r.protocol === "icmp" ? "" : "1-65535"),
        [direction === "ingress" ? "sources" : "destinations"]: {
          addresses: r.cidrs,
        },
      }));
    const globalArguments: Props = { name: targetName };
    const inbound = toDo("ingress");
    const outbound = toDo("egress");
    if (inbound.length > 0) globalArguments.inbound_rules = inbound;
    if (outbound.length > 0) globalArguments.outbound_rules = outbound;
    else {
      losses.push(
        "the source lists no egress rules; a DigitalOcean firewall with no outbound rules blocks all outbound traffic from the droplets it protects",
      );
    }
    losses.push(
      "DigitalOcean firewalls attach to droplets by droplet_ids or tag, not by VPC: attach this firewall to the migrated droplets (their droplet ids or a shared tag) once they exist",
    );
    for (const note of arr(p.unrepresented)) {
      if (typeof note === "string") {
        decisions.push(`rule not translated: ${note}`);
      }
    }
    return {
      behaviorType: firewall.behaviorType,
      globalArguments,
      expected: { description: null, rules: expected, labels: {} },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-zA-Z0-9][a-zA-Z0-9.-]+$/,
      255,
      'must start with a letter or digit and use only letters, digits, "." and "-"',
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// vm (droplet)

const droplet: KindAdapter = {
  behaviorType: "@swamp/digitalocean/droplet",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    const size = obj(a.size);
    const machineType = track(
      unknownFields,
      "machineType",
      str(a.size_slug) ?? str(size?.slug),
    );
    const fromSlug = parseSlug(machineType);
    const image = obj(a.image);
    const imageId = num(image?.id);
    const v4 = arr(obj(a.networks)?.v4).map((n) => obj(n));
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    const refs: ResourceRef[] = [];
    const vpcId = str(a.vpc_uuid);
    if (vpcId) refs.push({ kind: "network", nativeId: vpcId, via: "vpc_uuid" });
    for (const v of arr(a.volume_ids)) {
      const volumeId = str(v);
      if (volumeId) {
        refs.push({
          kind: "block-volume",
          nativeId: volumeId,
          via: "volume_ids",
        });
      }
    }
    return make(
      "vm",
      droplet.behaviorType,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        machineType,
        vcpus: track(
          unknownFields,
          "vcpus",
          num(a.vcpus) ?? num(size?.vcpus) ?? fromSlug?.vcpus ?? null,
        ),
        memoryMiB: track(
          unknownFields,
          "memoryMiB",
          num(a.memory) ?? num(size?.memory) ?? fromSlug?.memoryMiB ?? null,
        ),
        // DigitalOcean offers x86_64 droplets only.
        architecture: "x86_64",
        image: track(
          unknownFields,
          "image",
          str(image?.slug) ?? str(image?.name) ??
            (imageId !== null ? String(imageId) : null),
        ),
        publicIp: v4.length === 0
          ? track(unknownFields, "publicIp", null)
          : v4.some((n) => n?.type === "public"),
        bootDiskGiB: track(
          unknownFields,
          "bootDiskGiB",
          num(a.disk) ?? num(size?.disk),
        ),
        labels: stringTagsToLabels(a.tags),
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };

    let size:
      | { slug: string; vcpus: number | null; memoryMiB: number | null }
      | null = null;
    if (
      resource.provider === "digitalocean" && typeof p.machineType === "string"
    ) {
      // Same provider: the size slug carries over as it is.
      size = {
        slug: p.machineType,
        vcpus: typeof p.vcpus === "number" ? p.vcpus : null,
        memoryMiB: typeof p.memoryMiB === "number" ? p.memoryMiB : null,
      };
    } else if (typeof p.vcpus === "number" && typeof p.memoryMiB === "number") {
      size = smallestFit(DROPLET_SIZES, p.vcpus, p.memoryMiB);
      if (size === null) {
        decisions.push(
          `no DigitalOcean droplet size has ${p.vcpus} vCPU and ${p.memoryMiB} MiB: choose a size or split the workload`,
        );
      } else if (size.vcpus !== p.vcpus || size.memoryMiB !== p.memoryMiB) {
        losses.push(
          sizeLoss(`${p.vcpus} vCPU / ${p.memoryMiB / 1024} GiB`, size as Size),
        );
      }
    } else {
      decisions.push(
        "source vCPUs and memory are unknown, so no droplet size can be chosen: set `size` by hand",
      );
    }
    if (size) globalArguments.size = size.slug;

    if (p.architecture === "arm64") {
      decisions.push(
        "source is arm64 and DigitalOcean droplets are x86_64 only: rebuild the image and workload for x86_64",
      );
    }
    if (resource.provider === "digitalocean" && typeof p.image === "string") {
      globalArguments.image = p.image;
    } else {
      decisions.push(
        `source image ${
          typeof p.image === "string" ? `"${p.image}" ` : ""
        }is not portable: set \`image\` to a DigitalOcean image slug or custom image id (create fails without one)`,
      );
    }
    if (p.publicIp === false) globalArguments.public_networking = false;

    const vpcRef = depRef(context, "network");
    if (vpcRef) globalArguments.vpc_uuid = vpcRef;
    else if (context.dependencies("subnet").length > 0) {
      losses.push(
        "the source subnet has no DigitalOcean equivalent; the droplet joins the default VPC of the region unless its network is migrated too",
      );
    }
    const volumes = depRefs(context, "block-volume");
    if (volumes.length > 0) globalArguments.volumes = volumes;

    for (const id of context.dependencies("firewall")) {
      losses.push(
        `firewall ${
          context.targetNameOf(id) ?? id
        } applies to this droplet on the source; on DigitalOcean add this droplet's id (or a shared tag) to that firewall`,
      );
    }
    if (context.dependencies("iam-principal").length > 0) {
      losses.push(
        "the attached IAM principal has no DigitalOcean equivalent and is dropped",
      );
    }
    if (typeof p.bootDiskGiB === "number") {
      losses.push(
        "the boot disk size is fixed by the droplet size on DigitalOcean; it is not set separately",
      );
    }

    const tags = toDoTags(labelsOf(p));
    if (tags.tags.length > 0) globalArguments.tags = tags.tags;
    losses.push(...tags.losses);
    return {
      behaviorType: droplet.behaviorType,
      globalArguments,
      expected: {
        vcpus: size ? size.vcpus : null,
        memoryMiB: size ? size.memoryMiB : null,
        architecture: "x86_64",
        publicIp: p.publicIp !== false,
        labels: tags.labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    // The name becomes the droplet hostname (and a PTR record for managed domains).
    return nameProblems(
      name,
      /^[a-zA-Z0-9]?[a-z0-9A-Z.-]*[a-z0-9A-Z]$/,
      255,
      'may only use letters, digits, "." and "-" and must end with a letter or digit',
    );
  },
};

// ---------------------------------------------------------------------------
// block-volume

const volume: KindAdapter = {
  behaviorType: "@swamp/digitalocean/volume",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    return make(
      "block-volume",
      volume.behaviorType,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        sizeGiB: track(unknownFields, "sizeGiB", num(a.size_gigabytes)),
        // DigitalOcean block storage is SSD-backed and encrypted at rest.
        media: "ssd",
        iops: null,
        encryption: "provider-managed",
        // No availability zones: volumes live in a region.
        zone: null,
        labels: stringTagsToLabels(a.tags),
      },
      [],
      unknownFields,
    );
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };
    if (typeof p.sizeGiB === "number") {
      const whole = Math.ceil(p.sizeGiB);
      if (whole !== p.sizeGiB) {
        losses.push(
          `size ${p.sizeGiB} GiB is rounded up to ${whole} GiB (whole numbers only)`,
        );
      }
      globalArguments.size_gigabytes = whole;
    } else {decisions.push(
        "source size is unknown: set `size_gigabytes` by hand",
      );}
    if (p.media === "hdd") {
      losses.push("DigitalOcean volumes are SSD; the HDD source becomes SSD");
    }
    if (typeof p.iops === "number") {
      losses.push(
        `provisioned ${p.iops} IOPS cannot be set on DigitalOcean volumes`,
      );
    }
    if (p.encryption === "customer-key") {
      decisions.push(
        "source uses a customer-managed key; DigitalOcean volumes use provider-managed encryption only: confirm that is acceptable",
      );
    }
    const tags = toDoTags(labelsOf(p));
    if (tags.tags.length > 0) globalArguments.tags = tags.tags;
    losses.push(...tags.losses);
    return {
      behaviorType: volume.behaviorType,
      globalArguments,
      expected: {
        sizeGiB: typeof p.sizeGiB === "number" ? Math.ceil(p.sizeGiB) : null,
        media: "ssd",
        encryption: "provider-managed",
        labels: tags.labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z][a-z0-9-]*$/,
      64,
      'must start with a lowercase letter and use only lowercase letters, digits and "-"',
    );
  },
};

// ---------------------------------------------------------------------------
// sql-database and cache (database_cluster, split by engine)

/** `database_cluster` engines that are SQL databases, with their canonical engine. */
const SQL_ENGINES: Record<string, string> = {
  pg: "postgres",
  advanced_pg: "postgres",
  mysql: "mysql",
  advanced_mysql: "mysql",
};

/** `database_cluster` engines that are caches. */
const CACHE_ENGINES = new Set(["redis", "valkey"]);

const CLUSTER_TYPE = "@swamp/digitalocean/database-cluster";

/** The fields both cluster kinds share. Reads named fields only: never connection details. */
function clusterBasics(a: Props) {
  const nativeId = idOf(a);
  const name = str(a.name) ?? nativeId;
  const refs: ResourceRef[] = [];
  const vpcId = str(a.private_network_uuid);
  if (vpcId) {
    refs.push({
      kind: "network",
      nativeId: vpcId,
      via: "private_network_uuid",
    });
  }
  return { nativeId, name, refs, labels: stringTagsToLabels(a.tags) };
}

/** Cluster names (conservative: lowercase letters, digits and dashes). */
function clusterName(name: string): string[] {
  return nameProblems(
    name,
    /^[a-z][a-z0-9-]*[a-z0-9]$/,
    63,
    'must start with a lowercase letter, end with a letter or digit, and use only lowercase letters, digits and "-"',
    3,
  );
}

const sqlDatabase: KindAdapter = {
  behaviorType: CLUSTER_TYPE,
  idField: "id",
  accepts: (a) => typeof a.engine === "string" && a.engine in SQL_ENGINES,
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const { nativeId, name, refs, labels } = clusterBasics(a);
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    const engine = SQL_ENGINES[str(a.engine) ?? ""] ?? null;
    const slug = str(a.size);
    const fromSlug = parseSlug(slug);
    const nodes = num(a.num_nodes);
    const storageMiB = num(a.storage_size_mib);
    const rules = Array.isArray(a.rules) ? a.rules : null;
    let publicAccess: boolean | null = null;
    if (rules === null) unknownFields.push("publicAccess");
    else {
      // Every cluster has a public endpoint; trusted sources decide who may use it.
      publicAccess = rules.length === 0 ||
        rules.some((r) =>
          obj(r)?.type === "ip_addr" && obj(r)?.value === "0.0.0.0/0"
        );
    }
    return make(
      "sql-database",
      CLUSTER_TYPE,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        engine: track(unknownFields, "engine", engine),
        engineVersion: track(unknownFields, "engineVersion", str(a.version)),
        instanceClass: track(unknownFields, "instanceClass", slug),
        vcpus: track(unknownFields, "vcpus", fromSlug?.vcpus ?? null),
        memoryMiB: track(
          unknownFields,
          "memoryMiB",
          fromSlug?.memoryMiB ?? null,
        ),
        storageGiB: track(
          unknownFields,
          "storageGiB",
          storageMiB === null ? null : storageMiB / 1024,
        ),
        highAvailability: nodes === null
          ? track(unknownFields, "highAvailability", null)
          : nodes > 1,
        // Managed clusters keep daily backups for seven days; not configurable.
        backupRetentionDays: 7,
        publicAccess,
        labels,
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };

    const engine = p.engine === "postgres"
      ? "pg"
      : p.engine === "mysql"
      ? "mysql"
      : null;
    if (engine) globalArguments.engine = engine;
    else {
      decisions.push(
        `DigitalOcean managed databases offer PostgreSQL and MySQL only; source engine ${
          typeof p.engine === "string" ? `"${p.engine}"` : "(unknown)"
        } needs another approach (a droplet-hosted database, or a different engine)`,
      );
    }
    let version: string | null = null;
    if (typeof p.engineVersion === "string") {
      version = p.engineVersion.split(".")[0];
      globalArguments.version = version;
    } else {
      losses.push(
        "source engine version is unknown, so DigitalOcean uses its default version",
      );
    }

    let size: Size | null = null;
    if (
      resource.provider === "digitalocean" &&
      typeof p.instanceClass === "string"
    ) {
      // Same provider: the size slug carries over as it is.
      globalArguments.size = p.instanceClass;
      size = parseSlug(p.instanceClass) ? sizeFromSlug(p.instanceClass) : null;
    } else if (typeof p.vcpus === "number" && typeof p.memoryMiB === "number") {
      size = smallestFit(DB_SIZES, p.vcpus, p.memoryMiB);
      if (size === null) {
        decisions.push(
          `no DigitalOcean database size has ${p.vcpus} vCPU and ${p.memoryMiB} MiB: choose a size`,
        );
      } else {
        globalArguments.size = size.slug;
        if (size.vcpus !== p.vcpus || size.memoryMiB !== p.memoryMiB) {
          losses.push(
            sizeLoss(`${p.vcpus} vCPU / ${p.memoryMiB / 1024} GiB`, size),
          );
        }
      }
    } else {
      decisions.push(
        "source vCPUs and memory are unknown: set the database `size` by hand",
      );
    }

    // One primary, plus a standby when the source is highly available.
    const ha = p.highAvailability === true;
    globalArguments.num_nodes = ha ? 2 : 1;
    if (ha) {
      losses.push(
        "high availability is rendered as 2 nodes (primary plus one standby node)",
      );
    }

    if (typeof p.storageGiB === "number") {
      globalArguments.storage_size_mib = p.storageGiB * 1024;
      losses.push(
        "DigitalOcean ties base storage to the node size; storage_size_mib is set to the source storage and the API may reject a value below the size's base",
      );
    }
    if (
      typeof p.backupRetentionDays === "number" && p.backupRetentionDays !== 7
    ) {
      losses.push(
        `source retains backups ${p.backupRetentionDays} days; DigitalOcean keeps 7 days of daily backups`,
      );
    }
    if (p.publicAccess === false) {
      decisions.push(
        "source is not publicly reachable; a DigitalOcean cluster has a public endpoint until trusted sources are set: add `rules` (droplets, Kubernetes clusters, tags or IPs) after creation",
      );
    }
    const vpcRef = depRef(context, "network");
    if (vpcRef) globalArguments.private_network_uuid = vpcRef;
    if (
      context.dependencies("subnet").length +
          context.dependencies("firewall").length > 0
    ) {
      losses.push(
        "subnet and firewall dependencies have no DigitalOcean equivalent here; restrict access with trusted sources (rules)",
      );
    }
    if (context.dependencies("kms-key").length > 0) {
      losses.push(
        "the customer-managed key is dropped; DigitalOcean encrypts managed databases with its own keys",
      );
    }
    const tags = toDoTags(labelsOf(p));
    if (tags.tags.length > 0) globalArguments.tags = tags.tags;
    losses.push(...tags.losses);

    return {
      behaviorType: CLUSTER_TYPE,
      globalArguments,
      expected: {
        engine: typeof p.engine === "string" && engine ? p.engine : null,
        engineVersion: version,
        instanceClass: size ? size.slug : null,
        vcpus: size ? size.vcpus : null,
        memoryMiB: size ? size.memoryMiB : null,
        storageGiB: typeof p.storageGiB === "number" ? p.storageGiB : null,
        highAvailability: ha,
        backupRetentionDays: 7,
        // A person adds trusted sources when the source was private.
        publicAccess: p.publicAccess === true ? true : null,
        labels: tags.labels,
      },
      losses,
      decisions,
    };
  },
  validateName: clusterName,
};

const cache: KindAdapter = {
  behaviorType: CLUSTER_TYPE,
  idField: "id",
  accepts: (a) => typeof a.engine === "string" && CACHE_ENGINES.has(a.engine),
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const { nativeId, name, refs, labels } = clusterBasics(a);
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    const memoryMiB = parseSlug(str(a.size))?.memoryMiB ?? null;
    return make(
      "cache",
      CLUSTER_TYPE,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        engine: track(unknownFields, "engine", str(a.engine)),
        engineVersion: track(unknownFields, "engineVersion", str(a.version)),
        memoryGiB: memoryMiB === null
          ? track(unknownFields, "memoryGiB", null)
          : memoryMiB / 1024,
        nodes: track(unknownFields, "nodes", num(a.num_nodes)),
        labels,
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };

    let engine: string | null = null;
    if (p.engine === "redis" || p.engine === "valkey") {
      engine = p.engine;
      globalArguments.engine = engine;
    } else {
      decisions.push(
        `DigitalOcean offers Redis and Valkey caches only; source engine ${
          typeof p.engine === "string" ? `"${p.engine}"` : "(unknown)"
        } needs another approach (Valkey suits clients that speak the Redis protocol)`,
      );
    }
    losses.push("the engine version is left to DigitalOcean's default");

    let size: Size | null = null;
    if (typeof p.memoryGiB === "number") {
      size = smallestFit(DB_SIZES, 0, p.memoryGiB * 1024);
      if (size === null) {
        decisions.push(
          `no DigitalOcean database size has ${p.memoryGiB} GiB: choose a size`,
        );
      } else {
        globalArguments.size = size.slug;
        if (size.memoryMiB !== p.memoryGiB * 1024) {
          losses.push(sizeLoss(`${p.memoryGiB} GiB`, size));
        }
      }
    } else {
      decisions.push("source memory is unknown: set the cache `size` by hand");
    }

    // Managed clusters take 1 to 3 nodes (primary plus standbys).
    const nodes = typeof p.nodes === "number"
      ? Math.min(3, Math.max(1, p.nodes))
      : 1;
    globalArguments.num_nodes = nodes;
    if (typeof p.nodes !== "number") {
      losses.push("source node count is unknown, so a single node is used");
    } else if (nodes !== p.nodes) {
      losses.push(
        `source has ${p.nodes} nodes; DigitalOcean clusters take 1 to 3, so ${nodes} is used`,
      );
    }

    const vpcRef = depRef(context, "network");
    if (vpcRef) globalArguments.private_network_uuid = vpcRef;
    if (
      context.dependencies("subnet").length +
          context.dependencies("firewall").length > 0
    ) {
      losses.push(
        "subnet and firewall dependencies have no DigitalOcean equivalent here; restrict access with trusted sources (rules)",
      );
    }
    const tags = toDoTags(labelsOf(p));
    if (tags.tags.length > 0) globalArguments.tags = tags.tags;
    losses.push(...tags.losses);

    return {
      behaviorType: CLUSTER_TYPE,
      globalArguments,
      expected: {
        engine,
        engineVersion: null,
        memoryGiB: size ? size.memoryMiB / 1024 : null,
        nodes,
        labels: tags.labels,
      },
      losses,
      decisions,
    };
  },
  validateName: clusterName,
};

// ---------------------------------------------------------------------------
// dns-zone (domain) and dns-record

const domain: KindAdapter = {
  behaviorType: "@swamp/digitalocean/domain",
  // Domains have no numeric id; the name identifies them.
  idField: "name",
  normalise(a, behaviorName, regionFallback) {
    const name = (str(a.name) ?? "").replace(/\.$/, "");
    return make(
      "dns-zone",
      domain.behaviorType,
      behaviorName,
      name,
      [a.urn],
      name,
      regionFallback,
      // DigitalOcean DNS has public zones only and no tags.
      { domain: name, private: false, labels: {} },
      [],
      [],
    );
  },
  render(resource, targetName) {
    const p = resource.properties;
    const losses = untaggable("a DNS domain", labelsOf(p));
    const decisions: string[] = [];
    if (p.private === true) {
      decisions.push(
        "source zone is private (VPC-only) and DigitalOcean DNS has public zones only: publishing these records exposes them, so keep them off DigitalOcean or accept that",
      );
    }
    return {
      behaviorType: domain.behaviorType,
      globalArguments: { name: targetName },
      expected: { domain: targetName, private: false, labels: {} },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(name)
      ? []
      : [`"${name}" must be a lowercase domain name such as example.com`];
  },
};

/** Record types DigitalOcean can hold (SOA is managed by DigitalOcean itself). */
const RECORD_TYPES = new Set([
  "A",
  "AAAA",
  "CAA",
  "CNAME",
  "MX",
  "NS",
  "SRV",
  "TXT",
]);

/** A DigitalOcean record's fields → the canonical value string. */
function recordValue(a: Props): string | null {
  const type = str(a.type)?.toUpperCase();
  const data = str(a.data);
  if (data === null) return null;
  const host = data.replace(/\.$/, "");
  switch (type) {
    case "MX":
      return `${num(a.priority) ?? 0} ${host}`;
    case "SRV":
      return `${num(a.priority) ?? 0} ${num(a.weight) ?? 0} ${
        num(a.port) ?? 0
      } ${host}`;
    case "CAA":
      return `${num(a.flags) ?? 0} ${str(a.tag) ?? "issue"} "${data}"`;
    case "CNAME":
    case "NS":
      return host;
    default:
      return data;
  }
}

/** A canonical value → the fields DigitalOcean wants, or null when it cannot be parsed. */
function parseRecordValue(type: string, value: string): Props | null {
  const dotted = (host: string) =>
    host === "@" || host.endsWith(".") ? host : `${host}.`;
  switch (type) {
    case "MX": {
      const m = value.match(/^(\d+)\s+(\S+)$/);
      return m ? { priority: Number(m[1]), data: dotted(m[2]) } : null;
    }
    case "SRV": {
      const m = value.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
      return m
        ? {
          priority: Number(m[1]),
          weight: Number(m[2]),
          port: Number(m[3]),
          data: dotted(m[4]),
        }
        : null;
    }
    case "CAA": {
      const m = value.match(/^(\d+)\s+(\w+)\s+"?([^"]*)"?$/);
      return m ? { flags: Number(m[1]), tag: m[2], data: m[3] } : null;
    }
    case "CNAME":
    case "NS":
      return { data: dotted(value) };
    case "TXT":
      return { data: value.replace(/^"(.*)"$/s, "$1") };
    default:
      return { data: value };
  }
}

const domainRecord: KindAdapter = {
  behaviorType: "@swamp/digitalocean/domain-record",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const type = (str(a.type) ?? "").toUpperCase();
    // The record state carries no parent domain (it lives in the model's
    // `domain_name` global argument). Use it when the caller merged it in.
    const zone = (str(a.domain_name) ?? "").replace(/\.$/, "");
    const host = str(a.name) ?? "@";
    // Without a domain the record must not pretend to know its full name:
    // `name` stays null and both name and zone are unknown.
    let fqdn: string | null;
    if (zone) {
      fqdn = host === "@"
        ? zone
        : host === zone || host.endsWith(`.${zone}`)
        ? host
        : `${host}.${zone}`;
    } else {
      unknownFields.push("zone", "name");
      fqdn = null;
    }
    const value = recordValue(a);
    const refs: ResourceRef[] = zone
      ? [{ kind: "dns-zone", nativeId: zone, via: "domain_name" }]
      : [];
    return make(
      "dns-record",
      domainRecord.behaviorType,
      behaviorName,
      nativeId,
      [],
      fqdn ?? (host === "@" ? "apex" : host),
      regionFallback,
      {
        name: fqdn,
        type: track(unknownFields, "type", type || null),
        ttl: track(unknownFields, "ttl", num(a.ttl)),
        values: value === null ? [] : [value],
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, _target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const type = typeof p.type === "string" ? p.type.toUpperCase() : "";
    const fqdn = (typeof p.name === "string" ? p.name : resource.name).replace(
      /\.$/,
      "",
    );
    // "@" or a bare label is relative to a domain this record does not carry.
    const qualified = typeof p.name === "string" && fqdn !== "@" &&
      fqdn.includes(".");
    const values = (Array.isArray(p.values) ? p.values : [])
      .filter((v): v is string => typeof v === "string");
    const globalArguments: Props = { instance_name: targetName, type };

    // DigitalOcean names are relative to the domain ("@" for the apex): find
    // the migrated zone that contains this record (the longest match wins).
    const zone = !qualified ? undefined : context.dependencies("dns-zone")
      .map((id) => ({ id, name: context.targetNameOf(id) }))
      .filter((z): z is { id: string; name: string } => z.name !== null)
      .sort((a, b) => b.name.length - a.name.length)
      .find((z) => fqdn === z.name || fqdn.endsWith(`.${z.name}`));
    let relative: string | null = null;
    if (zone) {
      relative = fqdn === zone.name
        ? "@"
        : fqdn.slice(0, -(zone.name.length + 1));
      const ref = context.refTo(zone.id);
      if (ref) globalArguments.domain_name = ref;
      globalArguments.name = relative;
    } else if (!qualified) {
      decisions.push(
        `the record's full DNS name is unknown ("${
          p.name ?? resource.name
        }" is relative to a domain the source did not give): set \`domain_name\` and \`name\` by hand`,
      );
    } else {
      decisions.push(
        `record ${fqdn} is not inside a migrated DNS zone: add its domain to the migration, or set \`domain_name\` and \`name\` by hand`,
      );
    }

    if (!RECORD_TYPES.has(type)) {
      decisions.push(
        `DigitalOcean cannot hold ${
          type || "unknown"
        } records here (SOA is managed by DigitalOcean; alias-style records are not supported): replace it with a supported record`,
      );
    }
    let expectedValue: string | null = null;
    if (values.length === 0) {
      decisions.push("the record has no value: set `data` by hand");
    } else {
      if (values.length > 1) {
        decisions.push(
          `DigitalOcean records hold one value each but this record set has ${values.length}: only the first is rendered, so create one record per value`,
        );
      }
      const parsed = parseRecordValue(type, values[0]);
      if (parsed === null) {
        decisions.push(
          `value "${
            values[0]
          }" does not parse as a ${type} record: set the record fields by hand`,
        );
      } else {
        Object.assign(globalArguments, parsed);
        // What the target will show, read back the way normalise reads it.
        expectedValue = recordValue({ type, ...parsed });
      }
    }
    if (type === "NS" && relative === "@") {
      decisions.push(
        "apex NS records are managed by DigitalOcean and cannot be changed",
      );
    }
    let ttl: number | null = null;
    if (typeof p.ttl === "number") {
      ttl = Math.max(30, p.ttl);
      if (ttl !== p.ttl) {
        losses.push(`TTL ${p.ttl}s is raised to DigitalOcean's 30s minimum`);
      }
      globalArguments.ttl = ttl;
    }
    return {
      behaviorType: domainRecord.behaviorType,
      globalArguments,
      expected: {
        name: qualified ? fqdn : null,
        type,
        ttl,
        values: expectedValue === null ? [] : [expectedValue],
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    // The target name is only the swamp instance name; the record name comes from the zone.
    return name.length > 0 ? [] : ["a record name must not be empty"];
  },
};

// ---------------------------------------------------------------------------
// load-balancer

const loadBalancer: KindAdapter = {
  behaviorType: "@swamp/digitalocean/load-balancer",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    const listeners: { protocol: string; port: number }[] = [];
    for (const rule of arr(a.forwarding_rules)) {
      const r = obj(rule);
      const entry = (str(r?.entry_protocol) ?? "").toLowerCase();
      const port = num(r?.entry_port);
      // http2/http3 are TLS-terminating HTTP: canonically https.
      const protocol = entry === "http2" || entry === "http3" ? "https" : entry;
      if (protocol && port !== null) listeners.push({ protocol, port });
    }
    if (listeners.length === 0) unknownFields.push("listeners");
    const type = str(a.type);
    let layer: string | null;
    if (type === "REGIONAL_NETWORK") layer = "network";
    else if (listeners.length === 0) {
      layer = track(unknownFields, "layer", null);
    } else {
      layer = listeners.every((l) =>
          l.protocol === "tcp" || l.protocol === "udp"
        )
        ? "network"
        : "application";
    }
    const refs: ResourceRef[] = [];
    const vpcId = str(a.vpc_uuid);
    if (vpcId) refs.push({ kind: "network", nativeId: vpcId, via: "vpc_uuid" });
    for (const id of arr(a.droplet_ids)) {
      const dropletId = num(id);
      if (dropletId !== null) {
        refs.push({
          kind: "vm",
          nativeId: String(dropletId),
          via: "droplet_ids",
        });
      }
    }
    return make(
      "load-balancer",
      loadBalancer.behaviorType,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        // `network` defaults to EXTERNAL.
        scheme: str(a.network)?.toUpperCase() === "INTERNAL"
          ? "internal"
          : "internet",
        layer,
        listeners,
        // `tag` selects target droplets; the balancer itself has no labels.
        labels: {},
        targetTag: str(a.tag),
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses = untaggable("a load balancer", labelsOf(p));
    const decisions: string[] = [];
    const networkLayer = p.layer === "network";
    const rules: Props[] = [];
    const expectedListeners: { protocol: string; port: number }[] = [];
    for (const raw of arr(p.listeners)) {
      const l = obj(raw);
      if (typeof l?.port !== "number" || typeof l.protocol !== "string") {
        continue;
      }
      const port = l.port;
      let protocol = l.protocol.toLowerCase();
      if (networkLayer && (protocol === "http" || protocol === "https")) {
        losses.push(
          `${protocol.toUpperCase()} listener on port ${port} becomes TCP on a DigitalOcean network load balancer`,
        );
        protocol = "tcp";
      }
      if (protocol === "https") {
        // No certificate to attach, so pass TLS through rather than terminate it.
        rules.push({
          entry_protocol: "https",
          entry_port: port,
          target_protocol: "https",
          target_port: port,
          tls_passthrough: true,
        });
        losses.push(
          `HTTPS listener on port ${port} is rendered as TLS passthrough; add a certificate_id to terminate TLS at the balancer`,
        );
      } else if (["http", "tcp", "udp"].includes(protocol)) {
        rules.push({
          entry_protocol: protocol,
          entry_port: port,
          target_protocol: protocol,
          target_port: port,
        });
      } else {
        decisions.push(
          `listener protocol "${protocol}" on port ${port} has no DigitalOcean equivalent`,
        );
        continue;
      }
      expectedListeners.push({ protocol, port });
    }
    if (rules.length > 0) {
      losses.push(
        "backend ports are assumed to equal the listener ports; set target_port to the real backend ports",
      );
    } else {
      decisions.push(
        "no usable listeners in the source: add `forwarding_rules` by hand (create requires them)",
      );
    }
    const globalArguments: Props = {
      name: targetName,
      region: target.region,
      forwarding_rules: rules,
      type: networkLayer ? "REGIONAL_NETWORK" : "REGIONAL",
      network: p.scheme === "internal" ? "INTERNAL" : "EXTERNAL",
    };
    const vpcRef = depRef(context, "network");
    if (vpcRef) globalArguments.vpc_uuid = vpcRef;
    if (context.dependencies("subnet").length > 0) {
      losses.push(
        "the source subnet has no DigitalOcean equivalent; the balancer joins its VPC's default subnet",
      );
    }
    const droplets = depRefs(context, "vm");
    if (droplets.length > 0) globalArguments.droplet_ids = droplets;
    if (context.dependencies("firewall").length > 0) {
      losses.push(
        "firewall rules for the balancer map to the balancer's own `firewall` allow/deny lists: add them by hand",
      );
    }
    losses.push(
      "health checks, certificates and sticky sessions are not carried: add health_check and certificate_id once the backends exist",
    );
    return {
      behaviorType: loadBalancer.behaviorType,
      globalArguments,
      expected: {
        scheme: p.scheme === "internal" ? "internal" : "internet",
        layer: networkLayer ? "network" : "application",
        listeners: expectedListeners,
        labels: {},
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
      255,
      'must start with a letter or digit and use only letters, digits, ".", "_" and "-"',
    );
  },
};

// ---------------------------------------------------------------------------
// kubernetes-cluster

/** Node size used for the placeholder pool; a person picks the real one. */
const DEFAULT_NODE_SIZE = "s-2vcpu-4gb";

const kubernetes: KindAdapter = {
  behaviorType: "@swamp/digitalocean/kubernetes-cluster",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    const pools = Array.isArray(a.node_pools) ? a.node_pools : null;
    const nodeCount = pools === null
      ? track(unknownFields, "nodeCount", null)
      : pools.reduce<number>(
        (sum, pool) => sum + (num(obj(pool)?.count) ?? 0),
        0,
      );
    const refs: ResourceRef[] = [];
    const vpcId = str(a.vpc_uuid);
    if (vpcId) refs.push({ kind: "network", nativeId: vpcId, via: "vpc_uuid" });
    // Every cluster is tagged `k8s`, `k8s:<id>` and so on automatically.
    const labels = stringTagsToLabels(
      arr(a.tags).filter((t) => typeof t === "string" && !t.startsWith("k8s")),
    );
    return make(
      "kubernetes-cluster",
      kubernetes.behaviorType,
      behaviorName,
      nativeId,
      [a.urn, name],
      name,
      region,
      {
        // "1.30.4-do.0" → "1.30".
        version: track(
          unknownFields,
          "version",
          str(a.version)?.match(/^\d+\.\d+/)?.[0] ?? null,
        ),
        nodeCount,
        // The API endpoint is always public; isolated workers only hide the nodes.
        privateEndpoint: false,
        labels,
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses: string[] = [];
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };
    if (typeof p.version === "string") globalArguments.version = p.version;
    else {
      globalArguments.version = "latest";
      losses.push(
        "source Kubernetes version is unknown, so the latest DigitalOcean version is used",
      );
    }
    // A pool is required at create; the source carries no node shapes.
    const count = typeof p.nodeCount === "number" && p.nodeCount > 0
      ? p.nodeCount
      : 3;
    globalArguments.node_pools = [{
      name: "default-pool",
      size: DEFAULT_NODE_SIZE,
      count,
    }];
    decisions.push(
      `node pools are not carried over: one placeholder pool "default-pool" of ${count} x ${DEFAULT_NODE_SIZE} is rendered; choose node sizes, counts and autoscaling`,
    );
    if (p.privateEndpoint === true) {
      losses.push(
        "the DigitalOcean API endpoint is always public; restrict it with control_plane_firewall allowed_addresses",
      );
    }
    const vpcRef = depRef(context, "network");
    if (vpcRef) globalArguments.vpc_uuid = vpcRef;
    if (context.dependencies("subnet").length > 0) {
      losses.push(
        "the source subnet has no DigitalOcean equivalent; worker nodes use the VPC's default subnet",
      );
    }
    if (context.dependencies("iam-principal").length > 0) {
      losses.push(
        "cloud IAM bindings (workload identity) have no DigitalOcean equivalent and are dropped",
      );
    }
    const tags = toDoTags(labelsOf(p));
    if (tags.tags.length > 0) globalArguments.tags = tags.tags;
    losses.push(...tags.losses);
    return {
      behaviorType: kubernetes.behaviorType,
      globalArguments,
      expected: {
        version: typeof p.version === "string" ? p.version : null,
        nodeCount: count,
        privateEndpoint: false,
        labels: tags.labels,
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    // Conservative: DOKS accepts more, but this is safe wherever the name is reused.
    return nameProblems(
      name,
      /^[a-z0-9][a-z0-9-]*$/,
      255,
      'must start with a lowercase letter or digit and use only lowercase letters, digits and "-"',
    );
  },
};

// ---------------------------------------------------------------------------
// container-registry

const registry: KindAdapter = {
  behaviorType: "@swamp/digitalocean/container-registry",
  // A registry is identified by its (globally unique) name.
  idField: "name",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const name = str(a.name) ?? "";
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    return make(
      "container-registry",
      registry.behaviorType,
      behaviorName,
      name,
      [],
      name,
      region,
      {
        name,
        // DigitalOcean registries cannot make tags immutable, and are not taggable.
        immutableTags: false,
        scanOnPush: null,
        labels: {},
      },
      [],
      unknownFields,
      num(a.storage_usage_bytes),
    );
  },
  render(resource, targetName, target) {
    const p = resource.properties;
    const losses = untaggable("a container registry", labelsOf(p));
    if (p.immutableTags === true) {
      losses.push(
        "DigitalOcean registries cannot make tags immutable; enforce it in CI instead",
      );
    }
    if (p.scanOnPush === true) {
      losses.push(
        "scan-on-push is not configurable on a DigitalOcean registry",
      );
    }
    losses.push(
      'subscription tier "basic" is chosen; pick starter, basic or professional to match the image storage and repository count',
    );
    return {
      behaviorType: registry.behaviorType,
      globalArguments: {
        name: targetName,
        subscription_tier_slug: "basic",
        region: target.region,
      },
      expected: {
        name: targetName,
        immutableTags: false,
        scanOnPush: null,
        labels: {},
      },
      losses,
      decisions: [],
    };
  },
  validateName(name) {
    return nameProblems(
      name,
      /^[a-z0-9-]+$/,
      63,
      'may only use lowercase letters, digits and "-" (names are unique across all of DigitalOcean)',
    );
  },
};

// ---------------------------------------------------------------------------
// file-share (nfs)

/** The smallest NFS share DigitalOcean provisions. */
const MIN_NFS_GIB = 50;

const nfs: KindAdapter = {
  behaviorType: "@swamp/digitalocean/nfs",
  idField: "id",
  normalise(a, behaviorName, regionFallback) {
    const unknownFields: string[] = [];
    const nativeId = idOf(a);
    const name = str(a.name) ?? nativeId;
    const region = regionSlug(a.region, regionFallback);
    if (region === null) unknownFields.push("region");
    const tier = str(a.performance_tier)?.toLowerCase() ?? null;
    const refs: ResourceRef[] = [];
    for (const v of arr(a.vpc_ids)) {
      const id = str(v);
      if (id) refs.push({ kind: "network", nativeId: id, via: "vpc_ids" });
    }
    return make(
      "file-share",
      nfs.behaviorType,
      behaviorName,
      nativeId,
      [name],
      name,
      region,
      {
        protocol: "nfs",
        capacityGiB: track(unknownFields, "capacityGiB", num(a.size_gib)),
        performance: tier === null
          ? track(unknownFields, "performance", null)
          : tier === "standard"
          ? "standard"
          : "high",
        // The share's encryption is not reported.
        encryption: null,
        labels: {},
      },
      refs,
      unknownFields,
    );
  },
  render(resource, targetName, target, context) {
    const p = resource.properties;
    const losses = untaggable("an NFS share", labelsOf(p));
    const decisions: string[] = [];
    const globalArguments: Props = { name: targetName, region: target.region };
    if (p.protocol === "smb") {
      decisions.push(
        "source is an SMB share and DigitalOcean offers NFS only: clients must switch protocol",
      );
    }
    if (p.encryption === "customer-key") {
      decisions.push(
        "source uses a customer-managed key; DigitalOcean offers no customer-managed key for NFS shares",
      );
    }
    let size = MIN_NFS_GIB;
    if (typeof p.capacityGiB === "number") {
      size = Math.max(MIN_NFS_GIB, p.capacityGiB);
      if (size !== p.capacityGiB) {
        losses.push(
          `capacity ${p.capacityGiB} GiB is raised to DigitalOcean's ${MIN_NFS_GIB} GiB minimum`,
        );
      }
    } else {
      losses.push(
        `source capacity is elastic or unknown; a fixed ${MIN_NFS_GIB} GiB share is rendered and must be resized as data grows`,
      );
    }
    globalArguments.size_gib = size;
    if (p.performance === "standard" || p.performance === "high") {
      globalArguments.performance_tier = p.performance;
    }
    const vpcs = depRefs(context, "network");
    if (vpcs.length > 0) globalArguments.vpc_ids = vpcs;
    else {
      decisions.push(
        "no migrated network to attach: set `vpc_ids` to the VPC(s) allowed to mount the share (create requires them)",
      );
    }
    return {
      behaviorType: nfs.behaviorType,
      globalArguments,
      expected: {
        protocol: "nfs",
        capacityGiB: size,
        performance: p.performance === "high" || p.performance === "standard"
          ? p.performance
          : null,
        encryption: null,
        labels: {},
      },
      losses,
      decisions,
    };
  },
  validateName(name) {
    // Conservative: lowercase letters, digits and dashes are safe wherever a share name is reused.
    return nameProblems(
      name,
      /^[a-z0-9][a-z0-9-]*$/,
      63,
      'must start with a lowercase letter or digit and use only lowercase letters, digits and "-"',
    );
  },
};

/** The DigitalOcean provider adapter. */
export const digitalocean: ProviderAdapter = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  kinds: {
    network: vpc,
    firewall,
    vm: droplet,
    "block-volume": volume,
    "sql-database": sqlDatabase,
    cache,
    "dns-zone": domain,
    "dns-record": domainRecord,
    "load-balancer": loadBalancer,
    "kubernetes-cluster": kubernetes,
    "container-registry": registry,
    "file-share": nfs,
  },
};

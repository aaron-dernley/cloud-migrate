---
name: cloud-migrate-develop
description: >
  Pick up development of the @aaronge/cloud-migrate swamp extension in this
  repo: its layout, how to add a cloud provider or a resource kind, the
  test/validate loop, how parallel agents split the work, keeping the
  Obsidian atlas docs current, and what must never happen (publishing,
  pushing, real-cloud calls). Use when asked to "add a provider", "add a
  kind", "add AWS/GCP/DigitalOcean/Hetzner support for X", "improve
  cloud-migrate", "fix an adapter", "continue the cloud-migrate work", or
  when working on any file in this repo.
---

# Developing @aaronge/cloud-migrate

Read `CLAUDE.md` (repo rules) and `~/.claude/swamp-playbook.md` first. To
learn what the extension does for its users, read the shipped skill
`.claude/skills/cloud-migrate/` and `docs/using-with-stagecraft.md`.

## Hard rules

1. **No publishing.** Never run `swamp extension push` (not even
   `--dry-run` unless the user asks), `git push`, `gh repo create`, or file
   issues. Commits stay local until the user says otherwise.
2. **No real clouds.** Tests use made-up fixtures. Never run a provider
   behavior's `create`/`update`/`delete` from this repo.
3. **Run swamp with `SWAMP_SERVE_URL` unset** (`env -u SWAMP_SERVE_URL swamp ...`),
   or commands go to the Pi's ops serve instead of this repo.
4. **Facts from schemas, not memory.** Attribute names come from
   `swamp behavior type describe <type> --json` and the pulled sources in
   `.swamp/pulled-extensions/`. When you must use outside knowledge (size
   tables, offered versions), say so in a comment and in your report.
5. **Secrets never enter data.** Adapters never read, store or render
   passwords, secret values, tokens or connection strings. Each provider's
   tests include a planted-secret check.
6. **No `Co-Authored-By` trailer** in commits.

## Layout

| Path | What |
| --- | --- |
| `extensions/behaviors/cloud_migrate.ts` | The behavior: `inventory`, `map`, `resolve`, `plan` and `parity` methods; resources |
| `extensions/behaviors/_lib/kinds.ts` | The 21 canonical kinds: properties, parity fields, `alwaysDecide`, `carriesData` |
| `extensions/behaviors/_lib/adapter.ts` | The adapter contract (`KindAdapter`, `RenderContext`, `CanonicalResource`) and record helpers |
| `extensions/behaviors/_lib/planning.ts` | Dependency resolution, mapping, resolutions, waves, plan, parity, create commands |
| `extensions/behaviors/_lib/providers.ts` | Provider registry and transfer strategies |
| `extensions/behaviors/_lib/providers/<p>.ts` | One file per provider. AWS and GCP split into `_infra` and `_services` |
| `extensions/reports/migration_plan.ts` | The `@aaronge/cloud-migrate-plan` report |
| `workflows/workflow-cloud-migrate-assess.yaml` | The `@aaronge/cloud-migrate/assess` workflow |
| `factory/cloud-migration.yaml` | Source of the stagecraft factory. The copy under `models/@swamp/stagecraft/factory/` is for `validate` only |
| `.claude/skills/cloud-migrate/` | The skill shipped to users (`skills:` in the manifest) |
| `docs/using-with-stagecraft.md` | The person's guide (shipped) |

## Add a resource kind to a provider

1. Find the type:
   `env -u SWAMP_SERVE_URL swamp behavior type search <service> --json`.
   Pull the package if it's missing (`swamp extension pull @swamp/<cloud>/<svc>`;
   only one agent pulls at a time, because pulls rewrite the lockfile).
2. If the kind is new, add it to `RESOURCE_KINDS` and `KINDS` in `kinds.ts`
   first, with its properties, parity fields, `dependsOnKinds`,
   `alwaysDecide` and `carriesData`, plus a strategy in `providers.ts` if
   data moves.
3. In the provider file, write a `KindAdapter`:
   - `behaviorType` and `idField` (what other resources reference).
   - `normalise`: every canonical property, `null` and listed in
     `unknownFields` when the record lacks it. `aliases` for every id others
     may use. `refs` for dependencies.
   - `render`: input may come from any provider, so read only `properties`,
     `name` and `region`. Use exact schema names. Dependencies go through
     `context.refTo(id)`, or `context.targetNameOf(id)` when an API wants a
     name or path rather than an id. Record honest `losses` and `decisions`.
     `expected` is what parity should see.
   - `validateName`: the provider's naming rules.
   - `accepts`: only when one type models several kinds.
4. Tests in `<p>_test.ts`: a made-up fixture shaped like the schema,
   normalise, render from a foreign-provider canonical, refs through a fake
   `RenderContext`, a loss or decision path, and a planted-secret check.

## Add a cloud provider

Create `_lib/providers/<id>.ts` exporting a `ProviderAdapter` (`id`,
`displayName`, `kinds`), register it in `PROVIDERS` in `providers.ts`, add
pair-specific transfer strategies where a native path exists, and add tests.
Then regenerate the support matrix in the README and in
`.claude/skills/cloud-migrate/references/kinds.md` from the registry (a
short Deno script over `PROVIDERS` and `RESOURCE_KINDS`).

## The loop before every commit

```sh
~/.swamp/deno/deno test -A extensions/
~/.swamp/deno/deno lint extensions/
env -u SWAMP_SERVE_URL swamp extension fmt manifest.yaml
env -u SWAMP_SERVE_URL swamp behavior type describe @aaronge/cloud-migrate --json   # swamp loads it
env -u SWAMP_SERVE_URL swamp extension quality manifest.yaml
# after any factory change: regenerate the models/ copy, then
env -u SWAMP_SERVE_URL swamp behavior run cloud-migration validate
env -u SWAMP_SERVE_URL swamp workflow validate "@aaronge/cloud-migrate/assess"
```

Bump the CalVer `version` in both `manifest.yaml` and `cloud_migrate.ts`
for a behavior change (`YYYY.MM.DD.N`).

## Working with parallel agents

- **Split by file.** Give each agent files it owns outright (a provider
  file and its test). Shared files (`kinds.ts`, `adapter.ts`,
  `planning.ts`, `providers.ts`, `cloud_migrate.ts`, `manifest.yaml`) belong
  to the coordinating agent.
- An agent may see type errors from a sibling file that is mid-edit. It
  reports them and doesn't fix them.
- The coordinator reviews each hand-back, runs the full suite, and commits
  per agent with a message naming what landed.

## Keeping the docs current

After each reviewed commit, re-chart the Obsidian atlas through the user's
`@aaronge/obsidian-atlas` extension. The behavior `atlas` in this repo
writes to `~/Documents/Obsidian Vault/Atlas/cloud-migrate/`:

```sh
env -u SWAMP_SERVE_URL swamp behavior run atlas chart \
  --input repo="file://$PWD" \
  --input project=cloud-migrate --input prune=true
```

It charts the committed HEAD only, so commit first. A docs subagent can own
this: message it after each commit.

## Trying it end to end

`~/Repositories/cloud-migrate-demo` is a demo repo that loads this one as a
local extension source (`swamp extension source add ~/Repositories/cloud-migrate`)
with stagecraft pulled, and plans `examples/demo-aws-estate.json` through the
factory. A local source loads `extensions/<kind>/` only, so the shipped
workflows in `workflows/` need a second source:
`swamp extension source add ~/Repositories/cloud-migrate/workflows --only workflows`.
The first demo (mig-1, 2026-11-13) is the source of the fixes for range
overlap, transfer overrides, parity after overrides and review convergence.

## Known gaps (good next work)

- Static IPs, health checks, VPNs, snapshot schedules and NFS have no
  kinds: plans list them as manual steps.
- DigitalOcean DNS records need their domain merged into the record data.
- GCP load balancers cover the forwarding rule only (no backend services or
  URL maps).
- Sizing tables, offered database versions and Lambda runtimes are from
  memory; check them against provider docs or live data.
- No egress cost estimate yet: `dataBytes` is mostly null.
- An adversarial review must be recorded before any publish (the playbook
  covers this).

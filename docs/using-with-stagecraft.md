# Running a migration with stagecraft

This guide is for the person running a migration: what stagecraft is, how to
set it up, what you do at each stage, and how `@aaronge/cloud-migrate` fits in.
Your agent runs the commands; you decide.

## What stagecraft is

[`@swamp/stagecraft`](https://github.com/swamp-club/swamp-extensions/tree/main/stagecraft)
holds a process as data. It has five parts:

- **Factory**: your process, written as a set of **stages**.
- **Stage**: one step. Some work happens in it, and it records **artifacts**
  (documents such as a scope or a plan) or **evidence** (facts, such as "the
  transfer moved 100 of 100 objects").
- **Gates**: rules for leaving a stage, e.g. "the plan review has no
  blocking findings" or "a person approved the cutover".
- **Work item**: one piece of work going through the factory, such as one
  migration or one wave of a big one. It keeps a **journal** of everything
  recorded, every decision, who made it, and how long each stage took.
- **Human stop**: a gate only a person can open: approve, decline, send the
  work back, or abandon it.

Stagecraft never does the work itself. It enforces the order and the gates,
so a step can't be skipped and nobody can approve their own work.

## How cloud-migrate and stagecraft fit together

| Piece | Job |
| --- | --- |
| Official `@swamp/<cloud>/*` behaviors | Read and change each cloud |
| `@aaronge/cloud-migrate` | Read the source's data and work out the migration: inventory, map, resolve, plan, parity. Never changes anything |
| `@aaronge/cloud-migrate-plan` report | The readable plan you approve from |
| Stagecraft factory `cloud-migration` | The order of the work, and where you must say yes |
| Your agent | Runs each stage's work and stops for you |

The factory ships with the package as `factory/cloud-migration.yaml`.

## One-time setup

In a swamp repo:

```sh
swamp extension pull @swamp/stagecraft
swamp extension pull @aaronge/cloud-migrate --channel beta
# plus the provider packages you need, e.g.
swamp extension pull @swamp/aws/ec2
swamp extension pull @swamp/gcp/compute

# A tracker for the tickets: the built-in one keeps them in swamp data.
swamp behavior create @swamp/stagecraft/tracker migrations --global-arg prefix=mig

# The factory, bound to the tracker.
swamp behavior create @swamp/stagecraft/factory cloud-migration --global-arg tracker=migrations
```

Then copy the `definition:` and `scenarios:` blocks of the shipped factory
(after a pull it is at `.swamp/pulled-extensions/@aaronge/cloud-migrate/files/factory/cloud-migration.yaml`) under `globalArguments:` in
`models/@swamp/stagecraft/factory/cloud-migration.yaml`, and check it:

```sh
swamp behavior run cloud-migration validate
```

It should report 12 stages, 0 warnings, and its saved scenarios passing. Or
just ask your agent to "set up the cloud-migration stagecraft factory": the
stagecraft skill does all of this.

### Watching it: the studio

```sh
swamp behavior create @swamp/stagecraft/studio studio
swamp behavior run studio serve --input port=<a free port>
```

Open the address it prints. It has four views:

- **Design** draws the factory, with the stops that need you in gold.
- **Board** shows every migration in the stage it's in, how long it has
  been there, and whether it's waiting on you.
- **Work item** shows one migration's path and full timeline.
- **Simulate** replays the saved scenarios.

The studio is read-only: your agent makes the changes, and you watch them
arrive. It runs until you stop it (Ctrl-C), so start it when you want it.

## Starting a migration

Ask your agent: "start a cloud migration of X to Y". Behind the scenes it
runs:

```sh
# A ticket for the work: mig-1, mig-2, ...
swamp workflow run @swamp/stagecraft/create --input tracker=migrations \
  --input 'title=Move the web tier from AWS to GCP' --input 'body=...' --input type=feature
# Reserve the ticket and get the start command, then run that command.
swamp workflow run @swamp/stagecraft/claim --input tracker=migrations \
  --input issue=mig-1 --input factory=cloud-migration
swamp behavior run @swamp/stagecraft/work-item status mig-1
```

## What happens at each stage, and what you do

| Stage | The agent | You |
| --- | --- | --- |
| **scope** | Asks you about the clouds, region, what's in scope, downtime, budget and compliance, then creates the `@aaronge/cloud-migrate` behavior | Answer, then **approve the scope** |
| **inventory** | Refreshes the source behaviors and runs `inventory`, reporting anything it couldn't read | Nothing, unless it finds gaps |
| **map** | Runs `map` and explains every loss. For each decision it proposes options and trade-offs | **Decide each open question.** The agent records your words with `resolve`, naming you, and re-runs `map`. You're asked to approve only if something needed a decision |
| **plan** | Runs `plan` and writes the migration plan: waves, transfer methods, an egress estimate, downtime, and rollback | Read the report |
| **plan-review** | A separate subagent tries to break the plan. Critical or high findings send it back | **Approve the plan**, or send it back with feedback |
| **provision** | Creates the target resources with the plan's exact commands, then runs `parity` | Nothing. It only moves on if parity passes |
| **transfer** | Moves the data with each step's method and records the tool's own counts | Give credentials or choices when asked. A failed or short transfer only retries if you say so |
| **cutover** | Lays out the DNS, config and credential changes, the downtime, and the rollback | **Approve the cutover**, then cut over together |
| **soak** | Watches the target for 7 days (or as agreed) and re-runs parity | Report anything you see |
| **decommission** | Lists exactly what will be deleted at the source, with provider ids | **Approve deleting the source** |

At any point you can **abandon** the migration (with confirmation) or send
work back a stage. Every loop back is capped. Past the cap, the work stops
until you grant an override, which is recorded with your name.

### When the review keeps sending the plan back

The plan-review subagent tries to break the plan. Critical or high findings
send it back automatically, and each later review starts from the last one's
findings: it marks the fixed ones resolved and looks for new problems. The
`plan` stage can be entered three times. After that, the work stops for you:
grant an override for another round (recorded with your name), or step back.

If reviews keep finding new serious problems in the same area, take that as
a sign the design is wrong, not that it needs more safeguards. In the first
demo, four reviews in a row found new ways a hand-built two-way file sync
could lose uploads. The better answer would have been one shared store in
object storage, with nothing to sync. Your agent should propose that kind of
change rather than another patch.

### At a human stop

The agent shows you what the stage produced, then lists every option open
to you and what each costs. It recommends one only after listing them all,
and marks the recommendation as its own. Answer in plain words, e.g.
"approve the plan" or "send it back: split the database into its own wave".
The agent records your decision with your name, so the journal shows who
decided.

The agent can't approve, decline, override or abandon without your word in
the conversation. Locally you both run swamp as the same user, so this rule,
and the journal, are what keep it honest.

## Big migrations

Run one work item per wave. Each later wave's ticket is **blocked by** the
waves it depends on (the factory's tracker supports blocked-by relations),
so a wave can't start before its dependencies are done. The plan's waves
already respect dependencies: a VM comes after its subnet and firewall, and
a DNS record after its zone.

## Checking progress without the studio

```sh
swamp behavior run @swamp/stagecraft/work-item status mig-1    # where it is, what it waits on
swamp behavior run @swamp/stagecraft/work-item summary mig-1   # the timeline and metrics
```

And the migration itself:

```sh
swamp data query 'modelName == "<migration>" && name == "mapping"' --select content
```

## Without stagecraft

Everything works without the factory: run `inventory`, `map`, `resolve`,
`plan` and `parity` yourself (see the README), or run the
`@aaronge/cloud-migrate/assess` workflow. The factory adds the enforced
order, the approvals, the review subagent and the journal. Use it whenever
you want those, which for a production migration is always.

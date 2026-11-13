# Transfer methods

The plan names a method per step, from `extensions/behaviors/_lib/providers.ts`.
`providerNative` means the clouds do the work; otherwise bytes flow through
a host you run, so size it and expect its egress. `needsDecision` means a
person picks or confirms the method before it starts.

| Kind | AWS → GCP | GCP → AWS | Any other pair |
| --- | --- | --- | --- |
| object-bucket | Storage Transfer Service | DataSync (GCS XML API + HMAC) | copier host (rclone), decision |
| sql-database | Database Migration Service | AWS DMS | dump/restore or logical replication, decision |
| vm | Migrate to Virtual Machines, decision | Application Migration Service (MGN), decision | rebuild or replicate, decision |
| file-share | Storage Transfer agents, decision | DataSync agent, decision | NFS rsync, decision |
| block-volume | snapshot and copy, decision | same | same |
| container-registry | image copy (crane/skopeo) | same | same |
| nosql-table | export, transform, import, decision | same | same |
| dns-zone | recreate, then switch delegation | same | same |
| dns-record | recreate | same | same |
| secret | copy through a swamp vault | same | same |
| cache | warm on cutover | same | same |
| message-queue | drain and switch | same | same |
| everything else | recreate from configuration | same | same |

Record each transfer's own report as evidence: what was counted (objects,
rows, files, images, secrets), the counts on both sides, failures, and how
they were verified (checksums, row counts, digests). Never claim a
transfer verified that its tool did not report.

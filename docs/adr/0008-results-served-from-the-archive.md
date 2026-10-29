---
status: accepted
date: 2026-10-29
---

# Results are fetched when a run ends and served out of the archive in place

The task API offers one download per task, the whole archive, stored without compression and without range requests. It has no download for a single output, and by default it deletes a finished task two days after it ends. The sample run's archive is about a quarter of a gigabyte.

We decided that the server fetches the archive the moment a run completes, with the resumable downloader it already has, into the run's folder under the project, and that a run counts as finished with results only once that file is complete. Everything the operator gets comes out of that one file where it lies: the whole archive, each single output by name at its known path inside, and the map tiles the engine made. Nothing is unpacked to disk. Nothing is deleted on its own: the operator deletes a run, or a run's results while keeping its settings and log, and the server removes a task on an engine for no other reason.

## Considered options

- Download on demand from the engine. Rejected: the engine forgets the run after two days, and the operator's own results would vanish with it.
- Unpack the archive after fetching. Rejected: it doubles every run's footprint, and the archive's entries are stored uncompressed, so one entry can be streamed from its offset.

## Consequences

- The run page has a "fetching results" step between the engine's completion and the downloads.
- The archive's internal layout is a contract with the task API; a change there changes the entry reader and nothing above it.
- The project page can show the exact size of every run's results, because each is one file.

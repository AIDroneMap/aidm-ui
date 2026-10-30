# Results archive checks

A completed engine task starts a local archive fetch. The run reports `step: "results"` until the archive passes ZIP structure and streamed CRC checks. Only then does the server rename the partial file to `projects/<project>/runs/<run>/results.zip` and expose downloads. CRC checks detect damaged entries. They do not authenticate the engine or replace signed package verification.

The task API publishes no trusted archive size or digest. Archive downloads therefore use a separate streaming entry point in the downloader. It requests the saved partial offset on retry. A `200` response restarts the file; a `206` response must match the requested offset and complete range. The pinned task API does not serve ranges, so its interrupted transfers restart. Three failed transfers leave an actionable failed-results state. Restarting the application resumes pending fetches. A retry replaces a damaged saved archive with a fresh download. Deleting results records that choice, so restarting does not fetch them again.

The known output paths follow `AIDroneMap/aidm-api` v2.6.1, commit `d9e27406130a76c62e14349d03b562cc17a26079`, `libs/Task.js` archive assembly. Its preferred archive writer stores entries, while its fallback uses deflate. Both methods are supported. Stored outputs and tiles stream from file offsets. Deflated entries inflate as they stream. Neither path extracts files to disk. The archive retains model material and texture companions; the named textured-model download is the OBJ file.

The reader accepts ZIP64 offsets and sizes within JavaScript's safe integer range. It limits the directory to 64 MiB, 100,000 entries and 4,096 bytes per name. It rejects encryption, multiple disks, unsafe or duplicate names, unsupported methods, inconsistent headers, overlapping entries, truncation and CRC failures. A rejected archive remains unavailable. These limits bound untrusted metadata; they do not limit an individual output to 4 GiB.

Evidence:

- `server/results/routes.test.ts`: completion, local reads with the engine offline, output ranges, sizes, deletion, retry, restart and the project deletion gate.
- `server/results/download.test.ts`: interrupted responses, matching ranges, restart when ranges are ignored, invalid responses and cancellation.
- `server/results/zip.test.ts`: stored and compressed entries, corruption, descriptors and a sparse ZIP64 fixture beyond 4 GiB.
- `server/packages/real-task-api.test.ts`: the existing hosted test-mode check reads the live archive's orthophoto, GLB and tile through the routes and verifies deletion preserves the task.
- The results and run-page browser fixtures: fetching, retry, confirmed deletion, keyboard operation and project-to-run navigation.

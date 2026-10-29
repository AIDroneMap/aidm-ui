---
status: accepted
date: 2026-10-29
---

# The aidm-ui server keeps the photos and feeds every engine from them

The task API takes photos only as uploads or as the address of a zip file, keeps them in its own task folder, and by default forgets a finished task two days after it ends. It cannot resume an upload, list what it holds, or replace a file: a file sent twice becomes a second copy. An interface that uploaded straight from the browser to the engine would lose the photos on every cut connection and would have nothing left to retry with.

We decided that the aidm-ui server is the keeper of a project's photos and the only party that talks to an engine about them. Photos reach it three ways. An upload from the browser is chunked and resumable, checked file by file, and stored once under the project; that copy is the source for every run. An import names a folder on the server's machine; the server records the path and reads the files when a run needs them, never copies them and never writes into the folder. A link is the address of a zip file; the server checks it once and passes it to the engine, which fetches it itself, so the photos never touch the operator's machine. Retry and run-again use the engine's restart call while the engine still holds the photos; when it does not, the server sends them again from its copy, the folder or the link, without asking the operator.

When the engine runs on the same machine as an imported folder, the server does not copy. The engine reads the photos where they are, through links made on the engine's side into its own task folder, because the engine writes frames, masks and a frames list into its images folder and must never do so into the operator's. That needs a task API addition: a task created from a readable path, announced in the engine's info. Until an engine has it, the interface offers the copy alone. The operator may always choose the copy, for example when the photos sit on a slower disk than the engine.

## Considered options

- Browser to engine directly. Rejected by ADR 0002 for the token, and here again because the task API cannot resume or de-duplicate.
- Copy imported folders into the data folder. Rejected: it doubles a multi-gigabyte flight on the same disk for nothing.
- Mount the operator's folder as the engine's images folder. Rejected: the engine writes into that folder.

## Consequences

- Deleting a project removes the server's copy, the archives and the project's tasks on every engine. It never touches an imported folder or the file behind a link.
- A project fed by a link has no photo facts until its first run ends, when the server reads them from the archive.
- The server knows the browser is on its own machine only from a loopback connection, so the folder import is offered there and nowhere else.

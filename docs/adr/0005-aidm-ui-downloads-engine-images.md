---
status: accepted
date: 2026-10-26
---

# aidm-ui downloads engine images itself and hands them to the runtime

This amends ADR 0004 for image pulls only. aidm-ui no longer asks a container runtime to pull. It downloads the image from the registry itself, checks it, and hands it to the runtime with the runtime's own load command. Everything else (detect, start, stop, status, logs, remove) still goes through the runtimes' command-line tools, as ADR 0004 says.

## Why

The first install on a real Mac (Apple M5 Pro, 24 GiB, macOS 27) ran over a slow, unstable mobile link through a VPN exit node, at about 0.5 to 1 MB/s. Apple's container tool 1.6.1 pulled the pinned linux/arm64 image of aidm-api 2.5.0 (594 MiB in 9 layers) with `container image pull --platform linux/arm64 --progress plain`. Four tries in a row ended with exit 1 after 9 min 29 s to about 11 min 30 s, each with `StreamClosed(... HTTP2ErrorCode<0x1 ProtocolError> ...)`. Something on the path resets a long-lived connection after just under ten minutes.

The tool fetches every blob over one HTTP/2 connection, and a failed pull keeps nothing: it cancels and deletes its ingest session (1.6.1 with containerization 0.53.0: `ImageStore.swift`, `LocalContentStore.swift`). Every try began again at 0 bytes. At that speed the image needs more than ten minutes, so no try could ever finish. Retrying the same pull, which spec #2 relied on, cannot work on such a link with any runtime that does not resume a blob.

The registry allows what the runtime does not do. GHCR answers a blob request with a 307 to a signed address on pkg-containers.githubusercontent.com that expires within minutes (its `se=` parameter). That host answers a Range request with 206 and `accept-ranges: bytes`. Anonymous pull tokens come from `https://ghcr.io/token?scope=repository:<repo>:pull`. (Checked against the registry on 26 October 2026.)

## Decision

One image downloader serves every runtime. It is built on the resumable downloader in `server/downloads/` and works like this:

- It asks the registry for a token through the registry's own 401 challenge, fetches the manifest by the digest the manifest entry pins and checks the bytes against that digest, then fetches the config and each layer, each in requests of its own. No connection stays open for the whole image.
- On a reset or an error it asks the registry for the blob again. That gives it a fresh redirect, because the signed address expires. It then continues with a Range request from the last byte on disk. A 401 gets a new token. The token goes only to the registry, never to the signed address.
- Each blob is checked against its digest before it counts. A blob that fails the check is discarded alone and downloaded again, up to three times.
- Partial and finished blobs live in `<data folder>/downloads/images/sha256-<manifest>/`, laid out as an OCI image layout. They survive a restart of aidm-ui, and the next install continues from them.
- There is no cap on tries while bytes keep arriving. The download fails only when no byte has arrived for five minutes (`DOWNLOAD_STALL_MS`). A connection that is open but silent for a minute (`DOWNLOAD_IDLE_MS`) is dropped and made again. Both live in `server/machine/thresholds.ts` with the other thresholds. The rule applies to every download aidm-ui makes, not only images.
- Progress is real bytes against the manifest's total, with the speed over the last ten seconds, sent as message codes and data. When a connection breaks, the step says why and how often it happened.

Once every blob is checked, aidm-ui hands the image to the runtime, then asks the runtime to show that it holds the image with the pinned digest. Only the exit status of the load and that check count, never a line of output: Apple's tool printed "100%" in the same second as it failed, at 36% and at 50%. Then the engine starts from the image exactly as before, and only after it started does aidm-ui delete the downloaded blobs.

### How each runtime loads the image

Found in each tool's source and checked against Podman 5.8.9, Docker 29.9.2 (containerd image store) and Docker 28.5.2 (classic overlay2 store) on Linux on 26 October 2026. Apple's tool was read at the 1.6.1 tag only, because no Mac was at hand.

| Runtime | Load | Why this form | Checked by | Runs the image by |
| --- | --- | --- | --- | --- |
| Podman | `podman load -i <folder>`, then `podman tag <config digest> <name>` | libimage tries an OCI folder first (`libimage/load.go`), so the blobs are read where they are and no archive is made. From standard input, `podman load` would first copy everything to a temporary file (`cmd/podman/images/load.go`). A folder gives no name, hence the tag. | `podman image inspect`: `Digest` is the manifest digest, `Id` the config digest | the image ID |
| Docker | `docker load`, with an archive made from the blobs as it streams to standard input | The client streams standard input to the daemon (`cli/command/image/load.go`). The archive is an OCI image layout with the `manifest.json` of `docker save` next to it, the form `docker save` writes since Docker 25. The classic store reads only `manifest.json` and unpacks the archive into a temporary folder first (`image/tarexport/load.go`). The containerd store reads the layout and keeps the manifest digest. | `docker image inspect`: `Id` is the config digest in the classic store and the manifest digest in the containerd store | the image ID |
| Apple's tool | `container image load`, with an OCI layout archive on standard input | The tool reads only an OCI image layout, not `docker save`'s format (`LocalOCILayoutClient.swift`). It copies standard input to a temporary file before it reads it, so a file of our own would gain nothing (`ImageLoad.swift`). Its service unpacks the archive into a temporary folder and keeps the blobs in its content store (`ImagesService.swift`). It wraps a single manifest in an index of its own. | `container image inspect`: the manifest digest is among the image's variants | the image's name |

Every loaded image is named `<repository>:sha256-<manifest digest>`, in the `io.containerd.image.name` annotation that all three read first, so it can be found and removed by that name. Removing it removes only that name.

No runtime needs the fallback, a read-only registry for the checked blobs that aidm-ui would serve on the loopback address: each tool loads a local archive or folder. Apple's tool could pull from a loopback registry (`--scheme http`), which would save it the two temporary copies, but the load is what the tool documents for local images and uses no network code at all.

### The disk check

The check before the download counts the real need. The data folder needs the bytes of the download still to come. The runtime's storage needs the copies its load makes (Podman 1: each blob in a temporary file while it copies; Docker 1: the temporary folder or the content store; Apple's tool 3: the spooled archive, the unpacked archive and the content store) plus the unpacked layers. Unpacked layers took up to 2.8 times the download for the three images of aidm-api 2.5.0, measured on 26 October 2026 (`IMAGE_UNPACKED_FACTOR`). Each need gets the 20 percent margin. When the data folder and the storage are on one disk, that disk needs the sum.

## Consequences

- An image downloads on a link that resets every connection after a few minutes, and a restart of aidm-ui or of the computer loses at most the bytes of the connection that broke.
- The runtime adapters lose `pull` and their pull-output parsers, and gain `load`, `verifyImage` and `loadCopies`. Images the runtimes pulled before this change still run by `<image>@<digest>`, as before.
- aidm-ui now talks to registries itself: one more piece of HTTP code to keep right (token challenges, manual redirects, Range). The fake registry in `test-support/` covers it, with tokens, 307 redirects to short-lived addresses, ranges and timed resets.
- The download needs the image's size free in the data folder on top of what the runtime needs, until the engine has started.
- Pulls through a proxy or a registry mirror configured in the runtime no longer apply to engine images. aidm-ui reads the standard proxy variables of its own process.

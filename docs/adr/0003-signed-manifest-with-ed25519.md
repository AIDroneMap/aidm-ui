---
status: accepted
date: 2026-10-26
---

# Engine releases are described by a manifest signed with a raw Ed25519 key

The engine manager downloads engine packages from the internet and runs them. Something must say which packages exist, how large they are and what their checksums or image digests are, and that something must be trusted offline. We decided on one JSON manifest per engine release, published as a release asset of `aidm-api`, signed over its exact bytes with a raw Ed25519 signature. The public key ships inside aidm-ui, and verification uses WebCrypto, which Bun provides, so it adds no dependency and needs no network. The manifest carries a sequence number, and the manager refuses a manifest older than the one it already holds. Container images are pinned by digest inside the signed manifest, so image signing is not needed on top. Published releases are never edited, so the 2.5.0 release, which predates manifests, is covered by one built-in entry in aidm-ui, pinned by digest and signed with the same key, which goes through the same code path as any downloaded manifest.

## Considered options

- Sigstore or GitHub artifact attestations. Rejected: offline verification needs a trust root refreshed from the network a few times a year, and the JavaScript verifier targets Node, not Bun.
- The Update Framework (TUF). Rejected: its key-rotation and threshold model is for many publishers and mirrors. One publisher with one signed file gets nearly the same protection in a few dozen lines.
- Trusting GitHub Releases and the registry without a signature. Rejected: release assets can be re-uploaded by anyone with write access, and a registry tag can be moved.

## Consequences

- The private key is a repository secret in `aidm-api`, with an offline backup. Losing it means installed clients cannot verify new releases until they update the UI.
- aidm-ui holds a list of accepted public keys, so a second key can be introduced before the first is retired.
- The 2.5.0 built-in entry is removed once 2.6.0 is the oldest supported engine version.

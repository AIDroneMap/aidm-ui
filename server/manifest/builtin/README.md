# Built-in manifest entry

`2.5.0.json` describes the published aidm-api 2.5.0 release, which predates manifests and never gets one. It goes through the same code path as a downloaded manifest (ADR 0003). `2.5.0.json.sig.b64` is its raw Ed25519 signature in base64.

Where the numbers come from:

- Image: `ghcr.io/aidronemap/aidm-api`, pinned by digest, never by tag.
- Digests: the per-platform image digests listed in the multi-platform index of the 2.5.0 release (index digest `sha256:d31ddbb2c1e04cfa67365c7a8dc9bc3b6b4f3b486371a2d60b97a2457c79bdcc`). The GPU image is its own image, index digest `sha256:ae6e4538f6c5715951001e0e388c7bb4e28977e6db1c48adcf39705626342b72`.
- Sizes: the sum of the compressed layer sizes and the config size in each platform manifest. That is the number of bytes a pull downloads.
- Sequence 1, so any downloaded manifest replaces it.

The signature is made with the development test key listed in `../keys.ts`. The maintainer replaces the key and signs the file again with `scripts/sign-manifest.ts`. Release builds refuse the test key (`bun scripts/build.ts --release`).

The entry is removed once 2.6.0 is the oldest supported task API version.

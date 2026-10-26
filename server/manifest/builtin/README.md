# Built-in manifest entry

`2.5.0.json` describes the published aidm-api 2.5.0 release, which predates manifests and never gets one. It goes through the same code path as a downloaded manifest (ADR 0003). `2.5.0.json.sig.b64` is its raw Ed25519 signature in base64.

Where the numbers come from:

- Image: `ghcr.io/aidronemap/aidm-api`, pinned by digest, never by tag.
- Digests: the per-platform image digests listed in the multi-platform index of the 2.5.0 release (index digest `sha256:d31ddbb2c1e04cfa67365c7a8dc9bc3b6b4f3b486371a2d60b97a2457c79bdcc`). The GPU image is its own image, index digest `sha256:ae6e4538f6c5715951001e0e388c7bb4e28977e6db1c48adcf39705626342b72`.
- Sizes: the sum of the compressed layer sizes and the config size in each platform manifest. That is the number of bytes a pull downloads.
- Sequence 1, so any downloaded manifest replaces it.

The signature is made with the development test key listed in `../keys.ts`. The maintainer replaces the key and signs the file again with `scripts/sign-manifest.ts`. A build is a release build unless it is given `--development`, and a release build refuses the test key (`bun scripts/build.ts`).

Signing:

- `bun scripts/sign-manifest.ts --generate-key --out-key <new-file.pem>` makes a key pair. The private key goes to a new file that only its owner can read, and the command refuses a path that already exists. It prints only the public key, which goes into `../keys.ts`. Keep the private key file offline.
- `bun scripts/sign-manifest.ts 2.5.0.json < <private-key.pem>` reads the private key from standard input. It refuses a manifest the app would not read, and checks the signature against the public key of the private key before it writes anything.
- It writes the raw signature to `2.5.0.json.sig` and its base64 text to `2.5.0.json.sig.b64`. The built-in entry keeps the `.sig.b64` file; the release publishes the raw `manifest.json.sig`.
- `.gitattributes` marks this folder as not text, so a checkout on Windows keeps the exact bytes the signature covers.

The entry is removed once 2.6.0 is the oldest supported task API version.

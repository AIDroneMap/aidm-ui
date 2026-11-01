# Built-in manifest entry

`2.7.0.json` contains the exact manifest published with API 2.7.0. `2.7.0.json.sig.b64` stores its raw Ed25519 signature as base64. The default setup offers this package before any release check. The manifest names engine 0.2.0 and sequence 2007000.

The publisher's public key is already accepted in `../keys.ts`. The built-in bytes pass through the same signature and schema verification as a downloaded manifest. The release's per-platform image digests, compressed sizes and socket capabilities are preserved. Nothing is resigned, and no key, schema or sequence rule changes when selecting this entry.

The release is https://github.com/AIDroneMap/aidm-api/releases/tag/v2.7.0. The manifest SHA-256 is `a91dc6bc9445974444adc1a18665571544f46dc0df9f278e879015b83a079d97`. Matching fixtures and signature-tampering checks are in `test-support/fixtures` and `server/manifest/verify.test.ts`. Route regressions in `server/manifest/builtin-offer.test.ts` check fresh Linux and Apple silicon offers and the update offer for an older saved installation.

A new UI build does not silently replace an installed engine or its recorded data. The normal engine controls offer the newer package and require the operator to start the update. This preserves running work and rollback behavior.

The `2.5.0` files are retained for historical compatibility tests. `builtin.ts` no longer imports them for installation. That older entry predates publisher manifests and is signed by the development test key.

Development builds still accept that test key. The release-build check still rejects it. Updating the default package does not turn a development executable into a production release or change the accepted-key list.

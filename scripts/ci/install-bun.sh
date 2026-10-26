#!/usr/bin/env bash
# Installs the pinned Bun release on a GitHub-hosted Linux runner and checks it
# against the SHA-256 published with the release. This replaces a setup
# action, which the organisation's allow list does not include.
set -euo pipefail

BUN_VERSION=1.4.4
case "$(uname -m)" in
  x86_64)
    asset=bun-linux-x64
    sha256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
    ;;
  aarch64)
    asset=bun-linux-aarch64
    sha256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
    ;;
  *)
    echo "No pinned Bun build for $(uname -m)" >&2
    exit 1
    ;;
esac

dir="${RUNNER_TEMP:-/tmp}/bun-$BUN_VERSION"
mkdir -p "$dir"
curl -fsSL --retry 3 -o "$dir/bun.zip" \
  "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$asset.zip"
echo "$sha256  $dir/bun.zip" | sha256sum -c -
unzip -q -o "$dir/bun.zip" -d "$dir"
echo "$dir/$asset" >> "$GITHUB_PATH"
"$dir/$asset/bun" --version

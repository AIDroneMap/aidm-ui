#!/usr/bin/env bash
# Signs "AIDM UI.app", puts it in a disk image and checks both. Runs on a Mac.
#
#   scripts/ci/package-macos.sh <AIDM UI.app> <version> <output folder>
#
# With the five variables below, the app and the disk image are signed with
# the Developer ID certificate, the disk image is notarized and carries the
# ticket, and Gatekeeper must accept the app. With none of them, the app gets
# an ad-hoc signature: it runs, and macOS asks the pilot to approve it once in
# System Settings. Some but not all of them is an error.
#
#   MACOS_SIGNING_CERTIFICATE           base64 of a .p12 holding a "Developer ID Application" certificate and its key
#   MACOS_SIGNING_CERTIFICATE_PASSWORD  the password of that .p12
#   MACOS_NOTARY_KEY                    base64 of an App Store Connect API key (.p8) allowed to notarize
#   MACOS_NOTARY_KEY_ID                 the ID of that key
#   MACOS_NOTARY_ISSUER_ID              the issuer ID of that key
#
# Writes <output folder>/aidm-ui-<version>-mac-apple-silicon.dmg, and
# <output folder>/mac-signing, which holds "signed" or "unsigned".
set -euo pipefail

app="$1"
version="$2"
out="$3"
here="$(cd "$(dirname "$0")" && pwd)"

fail() {
  echo "::error::$1"
  exit 1
}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "The version must look like 1.2.3, got '$version'."
[ -x "$app/Contents/MacOS/aidm-ui" ] || fail "$app has no runnable Contents/MacOS/aidm-ui."

names="MACOS_SIGNING_CERTIFICATE MACOS_SIGNING_CERTIFICATE_PASSWORD MACOS_NOTARY_KEY MACOS_NOTARY_KEY_ID MACOS_NOTARY_ISSUER_ID"
missing=""
for name in $names; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
missing="${missing# }"
if [ -z "$missing" ]; then
  signing=signed
elif [ "$missing" = "$names" ]; then
  signing=unsigned
else
  fail "Signing needs all of: $names. Missing: $missing."
fi

work="$(mktemp -d)"
keychain="$work/signing.keychain-db"
cleanup() {
  if [ -f "$keychain" ]; then security delete-keychain "$keychain" || true; fi
  if [ -d "$work/mnt" ]; then hdiutil detach "$work/mnt" -quiet || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

if [ "$signing" = signed ]; then
  keychain_password="$(uuidgen)"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  printf '%s' "$MACOS_SIGNING_CERTIFICATE" | base64 --decode > "$work/certificate.p12"
  security import "$work/certificate.p12" -k "$keychain" -P "$MACOS_SIGNING_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
  rm -f "$work/certificate.p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
  # codesign finds the identity only in a keychain on the search list. The
  # existing list is split into words on purpose: one argument per keychain.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  identity="$(security find-identity -v -p codesigning "$keychain" | awk -F'"' '/Developer ID Application/ { print $2; exit }')"
  [ -n "$identity" ] || fail "MACOS_SIGNING_CERTIFICATE holds no Developer ID Application identity."
  echo "Signing with: $identity"
  # The hardened runtime is required for notarization. Bun's JavaScript engine compiles code at run time, so it needs the entitlements in the file.
  codesign --force --timestamp --options runtime --keychain "$keychain" --sign "$identity" \
    --entitlements "$here/macos-entitlements.plist" "$app/Contents/MacOS/aidm-ui"
  codesign --force --timestamp --options runtime --keychain "$keychain" --sign "$identity" "$app"
else
  echo "::warning::No Developer ID signing in this run. Missing: $missing. The app gets an ad-hoc signature, and macOS asks the pilot to approve it in System Settings."
  codesign --force --sign - "$app/Contents/MacOS/aidm-ui"
  codesign --force --sign - "$app"
fi
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=2 "$app"

mkdir -p "$out" "$work/stage"
dmg="$out/aidm-ui-$version-mac-apple-silicon.dmg"
ditto "$app" "$work/stage/AIDM UI.app"
ln -s /Applications "$work/stage/Applications"
hdiutil create -volname "AIDM UI $version" -srcfolder "$work/stage" -fs HFS+ -format UDZO -ov "$dmg"

if [ "$signing" = signed ]; then
  codesign --force --timestamp --keychain "$keychain" --sign "$identity" "$dmg"
  printf '%s' "$MACOS_NOTARY_KEY" | base64 --decode > "$work/notary.p8"
  xcrun notarytool submit "$dmg" --key "$work/notary.p8" --key-id "$MACOS_NOTARY_KEY_ID" --issuer "$MACOS_NOTARY_ISSUER_ID" \
    --wait --timeout 30m --output-format json > "$work/notary.json" || true
  cat "$work/notary.json"
  status="$(plutil -extract status raw "$work/notary.json" 2> /dev/null || echo unknown)"
  if [ "$status" != Accepted ]; then
    submission="$(plutil -extract id raw "$work/notary.json" 2> /dev/null || true)"
    if [ -n "$submission" ]; then
      xcrun notarytool log "$submission" --key "$work/notary.p8" --key-id "$MACOS_NOTARY_KEY_ID" --issuer "$MACOS_NOTARY_ISSUER_ID" || true
    fi
    fail "Notarization ended with status '$status'."
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
fi

# Check the disk image the way a pilot gets it: downloaded by a browser, so quarantined.
cp "$dmg" "$work/downloaded.dmg"
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$work/downloaded.dmg"
mkdir "$work/mnt"
hdiutil attach -nobrowse -readonly -mountpoint "$work/mnt" "$work/downloaded.dmg"
ls -la "$work/mnt"
[ "$(readlink "$work/mnt/Applications")" = /Applications ] || fail "The disk image has no Applications shortcut."
codesign --verify --deep --strict --verbose=2 "$work/mnt/AIDM UI.app"
assessment="$(spctl --assess --type execute --verbose=4 "$work/mnt/AIDM UI.app" 2>&1 || true)"
echo "Gatekeeper: $assessment"
if [ "$signing" = signed ]; then
  case "$assessment" in
    *accepted*Notarized\ Developer\ ID*) ;;
    *) fail "Gatekeeper does not accept the signed app." ;;
  esac
fi
hdiutil detach "$work/mnt"
rmdir "$work/mnt"

echo "$signing" > "$out/mac-signing"
ls -l "$dmg"
echo "Packaged $dmg ($signing)"

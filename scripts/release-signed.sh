#!/usr/bin/env bash
#
# release-signed.sh — build a Developer ID-signed, notarized DMG of Samuel.
#
# Required environment:
#   APPLE_TEAM_ID        10-char Developer Team ID (e.g. ABCD123456)
#   APPLE_API_KEY        Path to the App Store Connect API key file (.p8)
#   APPLE_API_KEY_ID     10-char Key ID shown in App Store Connect
#   APPLE_API_ISSUER     Issuer UUID shown in App Store Connect
#
# Optional:
#   GH_RELEASE_TAG       If set, uploads the resulting DMG to that GitHub release
#                        with `gh release upload --clobber`. Default: skip upload.
#
# Prerequisites (one-time, see docs/release-signing.md):
#   1. "Developer ID Application" certificate installed in your login keychain.
#   2. App Store Connect API key (.p8) downloaded and stored locally.
#   3. `xcrun notarytool` available (ships with Xcode Command Line Tools).
#
# Run:  npm run release:signed
#
set -euo pipefail

# ---------- env validation ----------
require_env () {
  local name="$1"
  local hint="$2"
  if [ -z "${!name:-}" ]; then
    echo "ERROR: $name is not set." >&2
    echo "       $hint" >&2
    exit 1
  fi
}

require_env APPLE_TEAM_ID      "10-char Apple Developer Team ID, e.g. export APPLE_TEAM_ID=ABCD123456"
require_env APPLE_API_KEY      "Path to your App Store Connect API key, e.g. export APPLE_API_KEY=~/.apple/AuthKey_XXXXXXXXXX.p8"
require_env APPLE_API_KEY_ID   "10-char Key ID from App Store Connect, e.g. export APPLE_API_KEY_ID=XXXXXXXXXX"
require_env APPLE_API_ISSUER   "Issuer UUID from App Store Connect, e.g. export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000"

# Expand a leading ~ in APPLE_API_KEY (env vars don't tilde-expand).
APPLE_API_KEY="${APPLE_API_KEY/#\~/$HOME}"
export APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER

if [ ! -f "$APPLE_API_KEY" ]; then
  echo "ERROR: APPLE_API_KEY file not found: $APPLE_API_KEY" >&2
  echo "       Download the .p8 from https://appstoreconnect.apple.com/access/integrations/api" >&2
  exit 1
fi

# ---------- check cert is installed ----------
if ! security find-identity -p codesigning -v 2>/dev/null | grep -q "Developer ID Application"; then
  cat >&2 <<EOF
ERROR: No "Developer ID Application" certificate found in any keychain.

Fix:
  1. Open developer.apple.com -> Account -> Certificates -> "+"
     and create a new "Developer ID Application" certificate.
     (You'll need to upload a CSR — Keychain Access -> Certificate Assistant ->
      Request a Certificate from a Certificate Authority.)
  2. Download the resulting .cer and double-click it to install in
     login.keychain.
  3. Re-run:  security find-identity -p codesigning -v
     and confirm a line like:
       1) ABCDEF1234... "Developer ID Application: Your Name (ABCD123456)"
EOF
  exit 1
fi

CERT_LINE="$(security find-identity -p codesigning -v | grep "Developer ID Application" | head -n 1)"
echo "Using certificate: $CERT_LINE"
echo "Team ID:           $APPLE_TEAM_ID"
echo "Notary key:        $APPLE_API_KEY_ID (file: $APPLE_API_KEY)"
echo

# ---------- build ----------
echo "[1/3] Building UI + Electron ..."
npm run ui:build
npm run electron:compile

echo
echo "[2/3] Signing + notarizing via electron-builder ..."
echo "      (this uploads the DMG to Apple and waits for the notary ticket;"
echo "       typical wait is 1-5 min)"
echo

# electron-builder >=26 reads the four notary credentials directly from env:
#   APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER (notary auth)
#   APPLE_TEAM_ID                                       (signing identity disambiguator)
# The `mac.notarize` config field is just a boolean kill-switch in v26+; we
# don't need to pass it because notarization auto-activates when the env
# vars above are present.
export APPLE_TEAM_ID
npx electron-builder --mac

# ---------- locate output ----------
DMG="$(ls -t dist-app/Samuel-*.dmg 2>/dev/null | head -n 1 || true)"
if [ -z "$DMG" ]; then
  echo "ERROR: electron-builder did not produce a DMG in dist-app/." >&2
  exit 1
fi

# Try to locate the .app inside the build dir for codesign verification.
APP="$(find dist-app -maxdepth 3 -name "Samuel.app" -type d 2>/dev/null | head -n 1 || true)"

# ---------- notarize + staple the DMG envelope ----------
# electron-builder notarizes the .app *before* wrapping it into a DMG, so the
# DMG envelope itself is unsigned/unnotarized. End users opening the .app from
# Applications work fine (the .app has its own stapled ticket), but mounting
# the DMG triggers a slow online Gatekeeper check unless the DMG itself is
# notarized + stapled. We submit a second notarytool round for the DMG so the
# experience is offline-clean from download onward.
echo
echo "[3/4] Notarizing the DMG envelope (second round, ~1-3 min) ..."
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" \
  --wait 2>&1 | sed 's/^/    /'

echo
echo "    Stapling notarization ticket onto $DMG ..."
xcrun stapler staple "$DMG" 2>&1 | sed 's/^/    /'

# ---------- verification ----------
echo
echo "[4/4] Verifying signature and notarization ..."
echo

if [ -n "$APP" ]; then
  echo "--- codesign --verify $APP ---"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'
  echo
fi

# NOTE: we deliberately don't run `spctl` against the DMG here. spctl predates
# the modern notarization workflow and emits "rejected: Insufficient Context"
# or "no usable signature" against stapled DMGs even when they're 100% valid.
# `xcrun stapler validate` is Apple's canonical truth source for stapled DMGs;
# if it reports success here, the DMG will pass Gatekeeper at user-open time.
echo "--- stapler validate $DMG ---"
xcrun stapler validate "$DMG" 2>&1 | sed 's/^/    /' || true
echo

# ---------- optional upload ----------
if [ -n "${GH_RELEASE_TAG:-}" ]; then
  echo "--- gh release upload $GH_RELEASE_TAG ---"
  gh release upload "$GH_RELEASE_TAG" "$DMG" --clobber 2>&1 | sed 's/^/    /'
fi

echo
echo "Signed + notarized DMG ready:"
echo "    $DMG"
echo
echo "Drag-test it: double-click the DMG, drag Samuel into Applications, open."
echo "You should NOT see a Gatekeeper warning."

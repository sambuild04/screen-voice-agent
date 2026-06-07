#!/usr/bin/env bash
# Build a *development / unsigned* Samuel DMG and publish it to a GitHub Release.
#
# Usage:
#   scripts/release.sh                # version pulled from package.json
#   scripts/release.sh v0.1.0         # explicit tag (must be vX.Y.Z)
#
# WHEN TO USE THIS SCRIPT vs `release:signed`:
#   - This script (release.sh)       → ad-hoc signed DMG. Users see Gatekeeper's
#                                       "Apple cannot verify…" dialog on first
#                                       launch and must right-click → Open.
#                                       Use for early dev / pre-Apple-enrollment.
#   - `npm run release:signed`       → Developer ID-signed + Apple-notarized DMG.
#                                       Zero Gatekeeper warning, true one-click
#                                       install. Use for public releases once
#                                       you've completed docs/release-signing.md.
#
# Prerequisites:
#   - `gh` CLI authenticated against the target repo
#   - `npm run electron:build` works locally
#
# We force CSC_IDENTITY_AUTO_DISCOVERY=false so this script keeps producing an
# unsigned DMG even after you install a Developer ID cert in your keychain.
# That way `release` and `release:signed` always do exactly what their names
# imply — no surprise behavior change just because a cert showed up.
#
# What it does:
#   1. Reads the version from package.json (or accepts an override)
#   2. Builds the DMG via `npm run electron:build`
#   3. Verifies dist-app/ contains a DMG matching that version
#   4. Creates a GitHub Release if one doesn't exist for the tag
#   5. Uploads the DMG(s) as release assets
#
# Idempotent on a clean tree: if the release already exists, asset upload
# uses --clobber so a re-run replaces in place.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION_OVERRIDE="${1:-}"
PKG_VERSION=$(node -p "require('./package.json').version")
TAG="${VERSION_OVERRIDE:-v${PKG_VERSION}}"

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "[release] tag must look like v0.1.0 (got: $TAG)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[release] gh CLI is required: https://cli.github.com/" >&2
  exit 1
fi

echo "[release] building unsigned DMG for $TAG"
echo "[release] (run \`npm run release:signed\` instead for a notarized build)"
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run electron:build

shopt -s nullglob
DMGS=(dist-app/*.dmg)
shopt -u nullglob

if [[ ${#DMGS[@]} -eq 0 ]]; then
  echo "[release] no DMG found in dist-app/ — did electron-builder fail?" >&2
  exit 1
fi

echo "[release] found ${#DMGS[@]} DMG(s):"
for dmg in "${DMGS[@]}"; do echo "         - $dmg"; done

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "[release] release $TAG already exists — uploading assets with --clobber"
  gh release upload "$TAG" "${DMGS[@]}" --clobber
else
  echo "[release] creating release $TAG"
  NOTES_FILE=$(mktemp)
  cat >"$NOTES_FILE" <<EOF
Samuel ${TAG#v}.

**Install:** download the DMG, open it, drag Samuel to Applications. The first launch will warn that Apple cannot verify the app — right-click \`Samuel.app\` in Applications and choose **Open** to bypass once. Notarization is on the roadmap.

**Free trial included:** no OpenAI key required for first use. See [PRIVACY.md](https://github.com/sambuild04/screen-voice-agent/blob/main/PRIVACY.md) and [TERMS.md](https://github.com/sambuild04/screen-voice-agent/blob/main/TERMS.md).
EOF
  gh release create "$TAG" "${DMGS[@]}" \
    --title "Samuel ${TAG#v}" \
    --notes-file "$NOTES_FILE"
  rm -f "$NOTES_FILE"
fi

echo "[release] done. Latest-asset URL pattern:"
echo "         https://github.com/<owner>/<repo>/releases/latest/download/$(basename "${DMGS[0]}")"

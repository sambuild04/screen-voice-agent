# Release Signing — One-Time Setup

This document walks you through getting Samuel signed with your Apple Developer ID and notarized through Apple's malware scanner, so users can install the DMG without seeing the "unidentified developer" Gatekeeper warning.

You only need to do steps 1–4 once. After that, every release is just `npm run release:signed`.

> **Prereq:** an active Apple Developer Program membership ($99/yr). Enrollment can take 24–48 h to fully activate; if you just signed up, give it a day before starting step 1.

---

## 1. Generate a "Developer ID Application" certificate

This is the certificate that signs the `.app` bundle.

1. On your Mac, open **Keychain Access** → menu bar **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority…**
   - User Email Address: your Apple ID email
   - Common Name: anything (your name is fine)
   - CA Email Address: leave empty
   - Request is: **Saved to disk**
   - Save the resulting `CertificateSigningRequest.certSigningRequest` somewhere you can find it
2. Go to https://developer.apple.com/account/resources/certificates/list
3. Click the **"+"** button to create a new certificate
4. Pick **Developer ID Application** (NOT "Mac Development", NOT "Developer ID Installer")
5. Upload the `.certSigningRequest` file from step 1
6. Download the resulting `.cer` file
7. Double-click the `.cer` to install it in your **login** keychain

Verify it landed correctly:

```bash
security find-identity -p codesigning -v
```

You should see a line like:

```
1) ABCDEF1234567890... "Developer ID Application: Your Name (ABCD123456)"
```

The 10-char string in parentheses is your **Team ID** — save it for step 4.

---

## 2. Generate an App Store Connect API key

This is what `notarytool` uses to upload the DMG to Apple's notary service.

1. Go to https://appstoreconnect.apple.com/access/integrations/api
2. Click **Generate API Key** (or the **+** if you've made one before)
3. Name: `Samuel notarytool` (anything works)
4. Access: **Developer**
5. Click **Generate**
6. **Download the `.p8` file immediately** — Apple shows it to you exactly once. If you lose it you have to revoke the key and start over.
7. Note the two pieces of info shown on the row:
   - **Key ID** — 10-char string, e.g. `XXXXXXXXXX`
   - **Issuer ID** — UUID, e.g. `00000000-0000-0000-0000-000000000000` (shown at the top of the Keys page)

Save the `.p8` somewhere outside the repo. A common spot:

```bash
mkdir -p ~/.apple
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.apple/
chmod 600 ~/.apple/AuthKey_XXXXXXXXXX.p8
```

---

## 3. Install Xcode Command Line Tools (if you don't have them)

`notarytool` and `stapler` ship with Xcode CLT. If `xcrun notarytool --version` works, you're done. Otherwise:

```bash
xcode-select --install
```

---

## 4. Set the environment variables

Add to your `~/.zshrc` (or `~/.bashrc`):

```bash
export APPLE_TEAM_ID="ABCD123456"
export APPLE_API_KEY="$HOME/.apple/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
```

Then `source ~/.zshrc` (or open a new terminal).

Verify all four are set:

```bash
env | grep ^APPLE_
```

> **Don't commit these to git.** If you ever leak the `.p8` file, revoke the key in App Store Connect immediately.

---

## 5. Run the signed release

From the repo root:

```bash
npm run release:signed
```

This runs `scripts/release-signed.sh`, which:

1. Validates all four env vars are set and the `.p8` file exists
2. Confirms a "Developer ID Application" cert is in your keychain
3. Builds the UI (`vite build`) and Electron main process
4. Calls `electron-builder` with `--config.mac.notarize.teamId=$APPLE_TEAM_ID`, which:
   - Signs the `.app` with your Developer ID
   - Wraps it into `Samuel-X.Y.Z-arm64.dmg`
   - Uploads the DMG to Apple's notary service via `notarytool`
   - Waits for the notarization ticket (typically 1–5 minutes)
   - Staples the ticket to the DMG so it works offline
5. Verifies the result with `codesign --verify`, `spctl`, and `xcrun stapler validate`

If everything works, you'll see:

```
Signed + notarized DMG ready:
    dist-app/Samuel-0.1.0-arm64.dmg

Drag-test it: double-click the DMG, drag Samuel into Applications, open.
You should NOT see a Gatekeeper warning.
```

---

## 6. (Optional) Upload to GitHub Release in one shot

```bash
GH_RELEASE_TAG=v0.1.0 npm run release:signed
```

The script will run `gh release upload v0.1.0 dist-app/Samuel-0.1.0-arm64.dmg --clobber` after a successful build.

---

## Troubleshooting

### `errSecInternalComponent` during signing
Your login keychain is locked. Run `security unlock-keychain ~/Library/Keychains/login.keychain-db` and re-run.

### Notarization fails with `Invalid` status
Run `xcrun notarytool log <submission-id> --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"` against the submission ID printed by electron-builder. The most common cause is an entitlement that wasn't actually used by any binary in the bundle, or a sub-binary that wasn't signed (electron-builder signs everything by default — but custom helpers under `helpers/` may need their own signing pass).

### `spctl` reports `rejected` after stapling
The DMG was signed but not notarized. Re-run `npm run release:signed`; the ticket may not have been stapled because notarization is still pending. If it keeps failing, check `xcrun notarytool history`.

### Gatekeeper still warns after install
- macOS caches Gatekeeper decisions per binary; if you tested an unsigned build before, run `xattr -d com.apple.quarantine /Applications/Samuel.app` once.
- Verify the shipped DMG with `spctl -a -t open --context context:primary-signature -v Samuel-0.1.0-arm64.dmg`. A `accepted` line confirms it's good.

### Cert expired or replaced
Just generate a new "Developer ID Application" cert (step 1) and double-click the new `.cer`. Old signed binaries continue to validate forever (the notary ticket is what Gatekeeper checks); the new cert just lets you sign new builds.

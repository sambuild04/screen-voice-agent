# Landing-page copy (paste-ready)

A starter for the one-page Carrd / Vercel landing page used in the
re-launch tweet. Sized to be skimmable on mobile in ~10 seconds.

Replace `<release-asset-url>` with the URL that `scripts/release.sh`
prints after publishing. The pattern is:

```
https://github.com/<owner>/<repo>/releases/latest/download/Samuel-<version>-arm64.dmg
```

---

## Hero (above the fold)

> **Samuel**
>
> A voice-first AI that lives on your Mac.
> Watches your screen *only* when you say "Hey Samuel."
> Off until you turn it on.
>
> [Download for Mac (Apple Silicon)](<release-asset-url>)
> [Download for Mac (Intel)](<release-asset-url>)
>
> Free trial. No OpenAI key required. Bring your own for unlimited use.

(Background: the demo video, autoplay + muted, looping.)

---

## Three bullet points (the trust spine)

- **Privacy by default.** Every capability — microphone, screen, computer
  control — is OFF until you turn it on. macOS asks you for the
  underlying system permission the first time. Read the
  [Privacy Policy](https://github.com/sambuild04/screen-voice-agent/blob/main/PRIVACY.md).
- **Voice-first, sub-500 ms.** Built on the OpenAI Realtime API. Wake
  word, full conversation, both directions, no typing.
- **Bring your own key, or don't.** Use the free trial proxy out of the
  box, or paste your own OpenAI API key in Settings to bypass the proxy
  entirely. Your data, your call.

---

## Install (the unsigned-DMG dance, called out plainly)

1. Click Download. You'll get a `.dmg`.
2. Open it, drag **Samuel** to **Applications**.
3. **First launch:** macOS will say *"Apple cannot verify that this app is
   free from malware."* That's because we haven't paid Apple's
   notarization fee yet, not because anything's wrong with the app. To
   open it once: right-click `Samuel.app` in Applications → **Open** →
   click **Open** in the dialog. Subsequent launches won't ask.
4. In the app, open Settings (gear icon). Turn on the privacy
   capabilities you want (Voice Input, Screen Read, etc.). Each one
   shows a native macOS permission dialog the first time.
5. Say **"Hey Samuel"** and start talking.

---

## What you can ask

(Pick three to four; rotate based on which segment the tweet targets.)

- *"Read me my unread emails."*
- *"What's on my calendar tomorrow?"*
- *"I'm stuck on this — what should I try next?"*
- *"Walk me through this PDF, paragraph by paragraph."*
- *"Body-double me through this task. Don't let me Reddit-spiral."*
- *"Translate the last 30 seconds of audio."*

---

## FAQ (short)

**Is it really free?**
Yes for the trial — we cover the OpenAI bill up to a daily per-user cap.
For unlimited use, paste your own OpenAI key in Settings; the app then
talks to OpenAI directly and doesn't contact our proxy at all.

**What does the trial proxy see?**
Your installation UUID, your IP (from Cloudflare's headers), and the
content of your request as it passes through. The proxy stores only
short-lived rate-limit counters; it doesn't keep your audio,
screenshots, or text. Source is in the
[`proxy/` directory](https://github.com/sambuild04/screen-voice-agent/tree/main/proxy)
of the repo.

**Why isn't it on the Mac App Store?**
The App Store would require sandboxing, which would break the
computer-use feature. Direct distribution lets Samuel actually drive
your apps. Notarization (which removes the Gatekeeper warning) is
coming.

**Apple Silicon or Intel?**
Both. Pick the right DMG above.

**Source code?**
[GitHub](https://github.com/sambuild04/screen-voice-agent), MIT.

---

## Footer

Made by [@potentialfung](https://x.com/potentialfung).
[Privacy](https://github.com/sambuild04/screen-voice-agent/blob/main/PRIVACY.md) ·
[Terms](https://github.com/sambuild04/screen-voice-agent/blob/main/TERMS.md) ·
[Source](https://github.com/sambuild04/screen-voice-agent)

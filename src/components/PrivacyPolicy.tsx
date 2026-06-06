interface Props {
  onClose: () => void;
}

// This is the actual privacy policy. It replaces the previous claim that
// "no data is sent to third parties" — which was inaccurate, since voice
// audio, screen text, and tool inputs are all sent to OpenAI for processing.
// Keep this in sync with the network calls in `electron/handlers/*` whenever
// new outbound endpoints are added.
export function PrivacyPolicy({ onClose }: Props) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel privacy-policy-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Privacy Policy</h3>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="privacy-policy-body">
          <p className="privacy-policy-meta">
            Last updated: 2026-06-06. This describes how the Samuel desktop
            app handles your data. We aim to be specific rather than aspirational
            — if any item below stops being true, we treat that as a bug.
          </p>

          <h4>1. Who runs Samuel</h4>
          <p>
            Samuel is a desktop app that runs on your machine. It connects to
            OpenAI to do its thinking, in one of two modes:
          </p>
          <ul>
            <li>
              <strong>Bring-your-own-key (BYOK).</strong> If you paste an
              OpenAI API key into Settings, the app talks to OpenAI directly
              with that key. Nothing reaches the Samuel project's servers.
            </li>
            <li>
              <strong>Trial mode.</strong> If you have not provided a key, a
              short list of OpenAI endpoints is routed through the
              <em> Samuel proxy</em>, a Cloudflare Worker operated by the Samuel
              project. The proxy adds the OpenAI key on its way upstream and
              applies daily rate limits, so trial users can use the app
              without an OpenAI account. Section 8 below describes exactly
              what the proxy sees and stores.
            </li>
          </ul>

          <h4>2. Third parties that receive your data</h4>
          <p>
            <strong>OpenAI</strong> is the primary processor. When the agent is
            active, the following is sent to <code>api.openai.com</code>:
          </p>
          <ul>
            <li>
              <strong>Microphone audio</strong> — streamed live to the realtime
              voice model while you are speaking with Samuel.
            </li>
            <li>
              <strong>Audio recordings</strong> — when you use the system-audio
              recording feature, the captured clip is uploaded to the audio
              transcription endpoint and discarded after the response.
            </li>
            <li>
              <strong>Screen content</strong> — when you ask Samuel to read or
              act on an app, the accessibility tree text and (for Computer
              Use) periodic screenshots of the targeted window are sent.
            </li>
            <li>
              <strong>Conversation transcripts and tool calls</strong> — every
              turn of the conversation, including any text you type and any
              text returned by tools, is sent so the model can decide what
              to say next.
            </li>
            <li>
              <strong>Background watcher input</strong> — if you enable the
              optional &ldquo;Proactive Screen Watch&rdquo; or &ldquo;Proactive
              Audio Listening&rdquo; toggles, ambient screen text and audio
              snippets are periodically sent to a classifier model. These are
              off by default.
            </li>
          </ul>
          <p>
            OpenAI&rsquo;s handling of this data is governed by their own
            terms and privacy policy, including their default retention and
            abuse-monitoring practices. Samuel cannot opt you out of those on
            your behalf — review them on the OpenAI dashboard if that matters
            to you.
          </p>

          <p>
            <strong>SerpAPI</strong> is contacted only when Samuel uses the
            web search tool. Your search query is sent to <code>serpapi.com</code>.
            Nothing is sent to SerpAPI when you are not using web search.
          </p>

          <p>
            <strong>OAuth providers</strong> (Google, GitHub, Spotify) are
            contacted only when you explicitly connect an account. Samuel
            stores the resulting access tokens locally and uses them only
            against those providers.
          </p>

          <h4>3. What is stored on your computer</h4>
          <p>All persistent data lives in your home directory:</p>
          <ul>
            <li>
              <code>~/.samuel/memory.json</code> &mdash; facts you taught
              Samuel, recent observations, recent transcripts, vocabulary
              you&rsquo;ve seen, corrections you&rsquo;ve given, and active
              watches.
            </li>
            <li>
              <code>~/.samuel/secrets.json</code> &mdash; your API keys and
              OAuth tokens. <strong>This file is plaintext.</strong> Anyone with
              read access to your home directory can read your keys.
            </li>
            <li>
              <code>~/.samuel/skills/</code> and <code>~/.samuel/plugins/</code>
              &mdash; user-defined skills and plugin code.
            </li>
            <li>
              <code>~/.samuel/chrome-cua-profile/</code> &mdash; the Chrome
              profile used by Computer Use. This is a real browser profile,
              including cookies and signed-in sessions.
            </li>
            <li>
              <code>~/.books-reader.json</code> &mdash; non-secret config
              (model, provider) plus, on legacy installs, an API key.
            </li>
            <li>
              UI preferences in browser <code>localStorage</code> &mdash; window
              size, voice volume, privacy toggles, schema version.
            </li>
          </ul>

          <h4>4. What is <em>not</em> stored</h4>
          <ul>
            <li>
              Microphone audio captured during conversation. The audio buffer
              is streamed to OpenAI and discarded; nothing is written to disk
              by the app.
            </li>
            <li>
              Screenshots used for visual reasoning. They are encoded
              in-memory, sent to OpenAI, and dropped after the response.
            </li>
            <li>
              The Chrome browser profile is excluded from data exports
              because it is an opaque browser-managed directory, not data
              the app itself produced.
            </li>
            <li>
              Telemetry, crash reports, and analytics. Samuel does not run any.
            </li>
          </ul>

          <h4>5. Your controls</h4>
          <ul>
            <li>
              The five privacy toggles above each gate a specific capability
              (Screen Reading, Voice Input, Computer Use, and the two
              proactive watchers). When a toggle is off, the corresponding
              tool short-circuits before any audio or content leaves your
              machine.
            </li>
            <li>
              <strong>Memory Browser</strong> lets you inspect every individual
              fact, observation, transcript, vocabulary word, correction, and
              watch in <code>memory.json</code> and delete any of them.
            </li>
            <li>
              <strong>Export Data</strong> writes a single JSON file
              containing everything Samuel stored about you, suitable for
              archive or audit. API keys are excluded by default.
            </li>
            <li>
              <strong>Clear Memory / Clear API Keys / Reset Preferences /
              Clear Everything</strong> wipe the corresponding files immediately.
              Deletion is local-only — it does not reach back to OpenAI or
              other providers.
            </li>
          </ul>

          <h4>6. Children</h4>
          <p>
            Samuel is not designed for, or directed at, children under 13.
            Do not let a child use Samuel without supervision; the audio,
            screen, and tool capabilities are powerful and could expose
            personal information to OpenAI.
          </p>

          <h4>7. Changes</h4>
          <p>
            When this policy changes, the &ldquo;Last updated&rdquo; date at
            the top changes with it. There is no separate notification
            channel — the policy ships with the app.
          </p>

          <h4>8. The Samuel trial proxy</h4>
          <p>
            When you run in trial mode, requests to the OpenAI Realtime,
            Whisper, Chat Completions, and Responses endpoints are sent to
            <code> samuel-proxy.boshenfeng.workers.dev</code> instead of
            directly to OpenAI. The proxy then forwards them to OpenAI with
            the project&rsquo;s API key.
          </p>
          <p>
            On each request the proxy reads two things:
          </p>
          <ul>
            <li>
              <strong>Your installation ID</strong> &mdash; a UUID generated
              the first time Samuel runs and stored at
              <code> ~/.samuel/installation-id</code>. The proxy uses it as a
              rate-limit bucket so behind-NAT users don&rsquo;t share quota.
              It is not tied to any account, name, or device identifier.
              <code> rm ~/.samuel/installation-id</code> resets it.
            </li>
            <li>
              <strong>Your IP address</strong> &mdash; provided by Cloudflare
              for routing. Used only as a secondary rate-limit bucket so a
              single network can&rsquo;t drain the budget. Cloudflare may log
              IPs per its own privacy policy.
            </li>
          </ul>
          <p>
            The proxy stores both as integer counters in a key-value store,
            keyed by date and endpoint, that auto-expire after 48 hours. It
            also tracks a rolling per-day total of estimated cost so the
            project can pause the service if usage spikes. The proxy does
            <strong> not</strong> persist the audio, screenshots, or text
            content of your requests.
          </p>
          <p>
            If you do not want the proxy to see your requests at all, paste
            your own OpenAI key in Settings &rarr; API Key. The full source
            of the proxy is in the <code>proxy/</code> directory of the
            Samuel repository, including the Cloudflare configuration; you
            can audit or self-host it.
          </p>
        </div>
      </div>
    </div>
  );
}

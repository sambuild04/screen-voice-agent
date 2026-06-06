interface Props {
  onClose: () => void;
}

// Mirror of TERMS.md so users can read the agreement inside the app
// without needing to visit the repo. Keep the two in sync — TERMS.md is
// the canonical version (it's what the landing page links to and what
// the install README references), this component is the in-app render.
export function TermsOfUse({ onClose }: Props) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel privacy-policy-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Terms of Use</h3>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="privacy-policy-body">
          <p className="privacy-policy-meta">
            Last updated: 2026-06-06. By installing or running Samuel, you
            agree to these terms.
          </p>

          <h4>1. What Samuel is</h4>
          <p>
            Samuel is a desktop application for macOS that runs an AI
            assistant on your Mac. It can speak, listen, read your screen,
            and operate your computer when you tell it to. It uses OpenAI's
            models to do this, either through your own API key or through a
            free trial proxy operated by the Samuel project.
          </p>

          <h4>2. How Samuel uses OpenAI</h4>
          <ul>
            <li>
              <strong>Bring-your-own-key (BYOK).</strong> You paste an OpenAI
              API key into Settings. The app talks directly to OpenAI using
              your key. You pay OpenAI&rsquo;s metered rates for whatever you
              use. Samuel applies no caps; you do.
            </li>
            <li>
              <strong>Trial mode.</strong> If you have not provided a key,
              the app routes a small set of OpenAI endpoints through the
              Samuel proxy. The proxy uses a key paid for by the Samuel
              project, with daily per-installation rate limits and a global
              daily cost cap. Trial mode is offered as-is and may be paused,
              throttled, or removed at any time without notice.
            </li>
          </ul>

          <h4>3. Acceptable use</h4>
          <p>Don&rsquo;t use Samuel to:</p>
          <ul>
            <li>
              Break the law, including laws on harassment, fraud, hate
              speech, child sexual abuse material, or unauthorized access
              to systems.
            </li>
            <li>
              Generate content that violates OpenAI&rsquo;s usage policies.
            </li>
            <li>
              Try to defeat the trial proxy&rsquo;s rate limits, drain its
              budget, scrape it, or use it as a free OpenAI relay for
              non-Samuel apps.
            </li>
            <li>
              Reverse-engineer the proxy or impersonate the Samuel project.
            </li>
          </ul>
          <p>
            If you do, we may suspend trial-mode access for your installation.
          </p>

          <h4>4. No warranty</h4>
          <p>
            Samuel is provided <strong>as is</strong>, without any warranty
            of any kind, express or implied, including but not limited to
            warranties of merchantability, fitness for a particular purpose,
            or non-infringement. AI assistants make mistakes, including
            confidently wrong ones. Samuel can take actions on your computer
            when you turn on Computer Use; the consequences of those actions
            are yours.
          </p>
          <p>
            Do not use Samuel for medical, legal, financial, or
            safety-critical decisions, or for anything where a wrong answer
            or wrong action would cause real harm. If something Samuel does
            costs you money or breaks something on your Mac, that is on you,
            not on us.
          </p>

          <h4>5. No liability</h4>
          <p>
            To the maximum extent permitted by law, the Samuel project and
            its maintainers are not liable for any indirect, incidental,
            special, consequential, or punitive damages, or any loss of
            data, profits, revenue, or goodwill, arising out of or related
            to your use of Samuel. Our total liability under any theory will
            not exceed what you have paid us for Samuel &mdash; which, today,
            is zero.
          </p>

          <h4>6. Privacy</h4>
          <p>
            How Samuel handles your data is described in the Privacy Policy,
            which is part of these terms. Open it from Settings &rarr;
            Privacy Policy.
          </p>

          <h4>7. Changes</h4>
          <p>
            We may update these terms over time. Material changes will be
            called out in the release notes. Your continued use of Samuel
            after a change means you accept the new terms; if you don&rsquo;t,
            uninstall the app.
          </p>

          <h4>8. Termination</h4>
          <p>
            You can stop using Samuel at any time by uninstalling it. We can
            stop offering the trial proxy at any time. Either of those
            terminates your right to use the trial mode but does not affect
            your right to keep running the BYOK mode against your own OpenAI
            account.
          </p>

          <h4>9. Governing law</h4>
          <p>
            These terms are governed by the laws of the State of California,
            USA, without regard to conflict-of-law rules.
          </p>
        </div>
      </div>
    </div>
  );
}

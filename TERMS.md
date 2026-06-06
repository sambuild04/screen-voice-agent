# Samuel Terms of Use

_Last updated: June 6, 2026._

These terms govern your use of the Samuel desktop app and the optional
Samuel trial proxy service. By installing or running Samuel, you agree
to them.

## What Samuel is

Samuel is a desktop application for macOS that runs an AI assistant on
your Mac. It can speak, listen, read your screen, and operate your
computer when you tell it to. It uses OpenAI's models to do this, either
through your own API key or through a free trial proxy operated by the
Samuel project.

## How Samuel uses OpenAI

You can run Samuel in one of two modes:

- **Bring-your-own-key (BYOK).** You paste an OpenAI API key into
  Settings. The app talks directly to OpenAI using your key. You pay
  OpenAI's metered API rates for whatever you use. Samuel applies no
  caps; you do.
- **Trial mode.** If you have not provided a key, the app routes a
  small set of OpenAI endpoints through the Samuel proxy. The proxy
  uses a key paid for by the Samuel project, with daily per-installation
  rate limits and a global daily cost cap. Trial mode is offered as-is
  and may be paused, throttled, or removed at any time without notice.

## Acceptable use

Don't use Samuel to:

- Break the law, including laws on harassment, fraud, hate speech,
  child sexual abuse material, or unauthorized access to systems.
- Generate content that violates [OpenAI's usage policies](https://openai.com/policies/usage-policies/).
- Try to defeat the trial proxy's rate limits, drain its budget, scrape
  it, or use it as a free OpenAI relay for non-Samuel apps.
- Reverse-engineer the proxy or impersonate the Samuel project.

If you do, we may suspend trial-mode access for your installation.

## No warranty

Samuel is provided **as is**, without any warranty of any kind, express
or implied, including but not limited to warranties of merchantability,
fitness for a particular purpose, or non-infringement. AI assistants
make mistakes, including confidently wrong ones. Samuel can take actions
on your computer when you turn on Computer Use; the consequences of
those actions are yours.

Do not use Samuel for medical, legal, financial, or safety-critical
decisions, or for anything where a wrong answer or wrong action would
cause real harm. If something Samuel does costs you money or breaks
something on your Mac, that is on you, not on us.

## No liability

To the maximum extent permitted by law, the Samuel project and its
maintainers are not liable for any indirect, incidental, special,
consequential, or punitive damages, or any loss of data, profits,
revenue, or goodwill, arising out of or related to your use of Samuel.
Our total liability under any theory will not exceed what you have paid
us for Samuel — which, today, is zero.

## Privacy

How Samuel handles your data is described in [PRIVACY.md](./PRIVACY.md).
That document is part of these terms.

## Changes

We may update these terms over time. Material changes will be called
out in the release notes. Your continued use of Samuel after a change
means you accept the new terms; if you don't, uninstall the app.

## Termination

You can stop using Samuel at any time by uninstalling it. We can stop
offering the trial proxy at any time. Either of those terminates your
right to use the trial mode but does not affect your right to keep
running the BYOK mode against your own OpenAI account.

## Governing law

These terms are governed by the laws of the State of California, USA,
without regard to conflict-of-law rules.

## Contact

Open an issue at the Samuel GitHub repository for bugs, terms questions,
or anything else.

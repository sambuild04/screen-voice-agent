# Security Policy

Samuel is a desktop AI agent that, when granted permission, can:

- Read the macOS Accessibility tree and take screenshots of any window
- Listen to the system audio buffer
- Drive any application via CGEvent (mouse, keyboard, scroll)
- Store and use OAuth tokens and API keys via the macOS Keychain
- Generate and execute dynamically-written TypeScript plugins
- Browse the web and operate web applications on the user's behalf

The surface area is broad, so vulnerability reports are taken seriously.

## Reporting a vulnerability

**Please do not file security issues as public GitHub Issues or pull requests.**

Use either:

1. GitHub's [Private Vulnerability Reporting](https://github.com/sambuild04/screen-voice-agent/security/advisories/new) (preferred), or
2. Email **boshenfeng@gmail.com** with `Samuel security` in the subject line.

Expect an initial acknowledgement within 5 business days. Samuel is currently
a 0.1.0 project maintained by one person, so fix timelines are best-effort.
Coordinated disclosure is appreciated.

## Supported versions

Only the latest release on `main` is supported. Older versions may contain
known issues; please update before reporting.

## Scope

In scope:

- Privilege escalation, RCE, or sandbox escape via plugins or computer-use tools
- Leakage of API keys, OAuth tokens, audio buffer contents, or screen contents
  beyond what the user has explicitly consented to
- Bypass of the consent and approval flows (`listen_in_background`,
  `set_screen_observation`, plugin approval, OAuth grants, etc.)
- Prompt-injection vectors via the AX tree, screen contents, audio buffer, or
  generated plugin code that would coerce Samuel into actions the user did
  not request

Out of scope:

- Vulnerabilities in upstream dependencies (OpenAI, third-party MCP servers,
  Electron, Node packages) — please report those upstream
- Social engineering of the user
- Physical access attacks on an unlocked Mac
- Issues that require the attacker to already have arbitrary code execution
  on the user's machine

## Acknowledgements

Reporters who responsibly disclose vulnerabilities will be acknowledged in
release notes if they wish. Inclusion is opt-in.

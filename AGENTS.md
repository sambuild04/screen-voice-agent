# Samuel — Agent Guidelines

This is the books-reader / Samuel codebase: a voice-first AI desktop assistant
built on the OpenAI Realtime API and the OpenAI Agents SDK
(`@openai/agents-realtime`). Tools and prompts live in `src/lib/samuel.ts`;
the live session, context-injection pipeline, and SAY-DO guard live in
`src/hooks/useRealtime.ts`. Backend handlers (Electron main process) live in
`electron/handlers/`.

## OpenAI Documentation

Always use the OpenAI developer documentation MCP server (the
`openaiDeveloperDocs` MCP, exposing `search_openai_docs`, `fetch_openai_doc`,
`list_openai_docs`, `list_api_endpoints`, `get_openapi_spec`) when you need
to work with anything in the OpenAI ecosystem — without me having to ask.
Specifically: any task that touches

- the OpenAI API (Responses, Chat Completions, Realtime, Audio, Images,
  Embeddings, Files, Vector Stores, Assistants, Batch, Fine-tuning, etc.);
- the Realtime API (`gpt-realtime-2`, `gpt-realtime-1.5`,
  `gpt-realtime-whisper`, `gpt-realtime-translate`, ephemeral
  `client_secrets`, WebRTC / WebSocket transports, session config,
  reasoning effort, tools, MCP, audio formats, turn detection, guardrails);
- the OpenAI Agents SDK (`@openai/agents`, `@openai/agents-core`,
  `@openai/agents-realtime`, `@openai/agents-openai`);
- the ChatGPT Apps SDK and MCP server building (Apps SDK, `Apps`/connectors);
- Codex (`@openai/codex`, `~/.codex/config.toml`, hooks, skills, subagents,
  CLI flags);
- model selection, snapshots, pricing, capabilities, deprecations, and
  migration guides;
- prompting guides (Realtime 2.0, GPT-5.x, Codex);

…you should call the docs MCP **first** to ground claims in the live docs,
quote exact field names and shapes, and verify schemas/limits/edge cases.
Pattern: `search_openai_docs` → pick the most relevant URL →
`fetch_openai_doc` (with `anchor` when applicable) for the exact text. For
endpoint shapes prefer `get_openapi_spec` so you get the canonical request
schema and code samples. Treat training-data knowledge of OpenAI APIs as
stale by default — the surface moves fast.

If a claim about the OpenAI API/SDK in this codebase isn't grounded by a
docs-MCP fetch in the same task, mark it as unverified and run the fetch
before merging.

## Realtime session conventions (this repo)

- Model: `gpt-realtime-2` (set in `src/hooks/useRealtime.ts` and
  `electron/handlers/config.ts`). Keep both in sync.
- Reasoning effort: `low` is the default, passed via `config.providerData.reasoning.effort`
  because the Agents SDK 0.8.x type doesn't yet expose `reasoning` on
  `RealtimeSessionConfigCommon`. `providerData` is forwarded verbatim into
  the session payload (`openaiRealtimeBase.js:418`). Bump to `medium` only
  if evals show regressions on multi-step tool flows.
- Transcription: `gpt-4o-transcribe` for in-session transcripts. Do not
  switch to `gpt-realtime-whisper` without an A/B because short noisy clips
  regress; see comments in `useRealtime.ts` near the transcription config.
- Context injection (AX tree + screenshot) lives in `decideAndRespond` in
  `useRealtime.ts`. Hash on the full AX payload; truncate after hashing.
  Skip injection when the AX hash matches a recent inject.
- SAY-DO guard (`looksLikeUnactedCommitment`) must exclude memory acks
  (`SAYDO_MEMORY_ACK_RE`) so reactive feedback turns ("I'll remember this")
  don't trigger duplicate response.create calls.

## Build / Test

- Install deps: `npm install`
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- Run dev: `npm run dev` (Vite + Electron via `concurrently`)

## House style

- TypeScript ESM. Avoid `any`; use existing types and `(string & {})`-style
  open unions when an SDK literal lags behind a new model name.
- No comments that just narrate the next line; comments should explain
  trade-offs, non-obvious failure modes, or doc links.
- When adding a workspace `AGENTS.md`, also add a `CLAUDE.md` symlink:
  `ln -s AGENTS.md CLAUDE.md`.

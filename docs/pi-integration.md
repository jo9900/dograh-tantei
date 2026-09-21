# Embedded Pi integration

The backend embeds `@earendil-works/pi-coding-agent@0.86.0` in its local Node process. No Pi CLI installation, MCP server, remote application server, or database is required. Node 22.19 or newer is required by the application. Real model requests still use the connected provider's network service and billing/usage limits.

## Application interface

`server/pi.ts` exports `PiService`:

```ts
const pi = new PiService({
  dataDir,
  environmentApiKey: environment.piOpenaiApiKey,
  environmentAnthropicApiKey: environment.piAnthropicApiKey,
  emit: (event) => broadcast(event),
  tools: [
    {
      name: 'get_workflow',
      description: 'Read the selected workflow',
      parameters: {
        type: 'object',
        properties: { workflowId: { type: 'integer' } },
        required: ['workflowId'],
        additionalProperties: false,
      },
      execute: async (args, { signal }) => dograh.readWorkflow(args.workflowId, signal),
    },
  ],
});
```

| Method                                                | Result / behavior                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `status()`                                            | App-owned provider connection metadata, selected model, busy/login state and chat session ID; never credentials |
| `listModels(provider?)`                               | Installed catalog entries for OpenAI, OpenAI Codex, and Anthropic; no inference                                 |
| `configureApiKey(key, provider = 'openai')`           | Stores a literal API key via Pi's provider login; OpenAI and Anthropic supported                                |
| `setModel(provider, id)`                              | Validates catalog membership and saves model choice locally                                                     |
| `startLogin(provider = 'openai-codex')`               | Returns `{loginId}` immediately; OAuth continues through events                                                 |
| `answerLogin(promptId, value)`                        | Answers one current OAuth prompt                                                                                |
| `cancelLogin()`                                       | Aborts OAuth and rejects pending UI prompts                                                                     |
| `chat(text, context?, contextKey = 'workbench')`      | Continues the domain-tool session for the selected context; returns `{text, sessionId}`                         |
| `complete(prompt, signal?)`                           | Separate in-memory, tool-free completion using the selected provider/model; returns text                        |
| `structuredPrompt(instruction, evidence, timeoutMs?)` | Convenience JSON-object parser over `complete`; caller must still validate the schema                           |
| `abort()`                                             | Stops only the operator chat; independent background analysis continues                                         |
| `dispose()`                                           | Cancels login, aborts chat and all active analysis, releases session listeners                                  |

`complete` is suitable for compiling natural-language test requirements or independently judging recorded calls. It cannot edit workflows and does not share the operator chat history. Its text is untrusted model output; the caller must validate it before scheduling work or recording a verdict. Precise response-delay measurements belong to the audio/testing engine, not Pi's estimate.

## Events and OAuth UI

Every event has a `type` and ISO `at` timestamp. Main event shapes:

- `pi.text.delta`: `{contextKey, runId, delta}`
- `pi.tool`: `{runId, event}` containing the SDK's `tool_execution_start/update/end` event
- `pi.chat.started`: `{contextKey, runId, sessionId}`
- `pi.chat.complete`: `{contextKey, runId, text, sessionId}`
- `pi.chat.error`: `{contextKey, runId, message}`
- `pi.auth.notify`: `{loginId, provider, event}`; event types include `auth_url`, `device_code`, `progress`, and `info`
- `pi.auth.prompt`: `{loginId, promptId, prompt}`; prompt types include `select`, `text`, `secret`, and `manual_code`
- `pi.auth.prompt.closed`: `{promptId, loginId?}`
- `pi.auth.complete/error/cancelled`: completion/failure metadata
- `pi.model.changed`: `{model: {provider, id}}`

Render OAuth links and device codes in the UI; post prompt answers to `answerLogin`. On cancellation call `cancelLogin`. Do not persist OAuth URLs, codes, or prompt answers in an audit log. The actual OAuth flow runs in the local Node process. Codex browser login normally receives a loopback callback on port 1455; the provider also offers a device-code flow. No tokens are copied from the Codex app or global Pi state.

## Local state and scope

The module uses only `<dataDir>/pi/` for its credential, model-selection, model-catalog and session files. Pi's auth storage creates credential files with mode `0600`. New directories use mode `0700`. Interactive session transcripts are persisted as Pi JSONL files under `sessions/`; standalone completions use `SessionManager.inMemory`. The workbench (`workbench`) and each task (`task:<id>`) have separate sessions under `sessions/scope-<sha256(contextKey)>/`. Switching context reuses the corresponding session; after a server restart, `SessionManager.continueRecent` resumes its saved history. Browser message lists are kept in memory and are not restored on page refresh.

`deleteTaskConversation(taskId)` disposes the matching cached session and removes only its scoped session directory. The task deletion route invokes this cleanup after checking that calls, reviews, and Pi operations are idle. Other task and workbench conversations remain intact.

The custom resource loader discovers no extensions, packages, skills, context files or prompt templates. It does not read `~/.pi/agent`, project `.pi` resources, or global `AGENTS.md`. An explicit tool allowlist contains only the injected domain tools; shell and general filesystem tools are unavailable. PiService requires a locally stored credential or its explicit `environmentApiKey` option before inference; it does not discover ambient credentials itself.

The application automatically loads the project `.env` at startup. `PI_OPENAI_API_KEY`, falling back to `OPENAI_API_KEY`, and the independent `PI_ANTHROPIC_API_KEY` are validated and passed explicitly to `PiService`. They use the SDK's `setRuntimeApiKey` and override the corresponding provider's stored credential only in memory. They are never copied to Pi's auth file. Public status exposes `environmentApiKeySet`, `environmentAnthropicApiKeySet` and each provider's `authSource`, not keys; attempts to replace an environment-managed key from the UI are rejected with a restart hint.

Default models are `gpt-5.6-sol` for OpenAI and Codex, and `claude-opus-5` for Anthropic, verified in the installed catalogs. Existing saved provider/model choices are preserved. An installation with only a Claude key selects Anthropic; adding a second provider does not replace a saved selection. Missing catalog entries produce `modelError` and block inference until a valid model is selected, rather than silently selecting the first model.

Pi itself is not an operating-system sandbox. The injected domain tool implementations are trusted application code and must enforce workflow scope, version matching, write authorization, and rollback snapshots. A system prompt is not a substitute for those checks. Tool results and arguments must exclude credentials. Feedback and call transcripts are evidence, not instructions authorizing writes.

OpenAI API keys and Codex subscription OAuth are separate providers. GPT-Live and Pi can share the explicitly configured OpenAI API key, or use separate keys. Codex OAuth is local to the installation and is not exported in `.env`. This module does not attempt to use Codex subscription authentication for realtime audio.

## Verification and remaining live checks

Unit tests exercise runtime-path isolation, inference refusal without an app connection, domain tool restrictions, independent no-tool completion, API-key redaction, OAuth prompts/cancellation/stale answers, and stop during session creation. The real SDK types are checked by `npm run typecheck`. These tests do not authenticate any account or run paid inference. Actual account login, selected-model availability, rate limits, and Dograh write operations need an authorized live check in the local application.

Official references: [Pi SDK](https://pi.dev/docs/latest/sdk), [providers](https://pi.dev/docs/latest/providers), [security](https://pi.dev/docs/latest/security), [current official repository](https://github.com/earendil-works/pi).

# Dograh connection contract

This adapter is based on public Dograh commit [`cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8`](https://github.com/dograh-hq/dograh/tree/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8), dated 2026-09-19. The user's deployment may differ. No authenticated production requests are made by the unit tests.

## Connection and authentication

The workbench UI and settings API use login Token authentication only. `DOGRAH_BASE_URL` and `DOGRAH_LOGIN_TOKEN` may be configured in the project `.env`; they are loaded at startup and stay server-side. The adapter's older API-key interface remains available internally for compatibility, but it is not exposed as a workbench authentication choice.

```ts
import { DograhClient } from './server/dograh.ts';

const dograh = new DograhClient({
  baseUrl: process.env.DOGRAH_BASE_URL!,
  authMode: 'token',
  loginToken: process.env.DOGRAH_LOGIN_TOKEN!,
});
```

`baseUrl` may be a backend origin, such as `https://dograh.example`, or an explicit API base such as `https://dograh.example/backend/api/v1`. Origin and root `/workflow` page URLs normalize to `/api/v1`. Other paths are treated as explicit API bases; proxy prefixes are not guessed. If the frontend and backend use different domains, enter the backend domain. The adapter rejects API redirects so credentials cannot travel to a different service. The server must store this configuration and never return the saved credentials to the browser.

Choose one authentication mode. API key mode sends only `X-API-Key`; token mode sends only `Authorization: Bearer <normalized-token>`, even if the configuration object contains both credential fields. Missing credentials in the selected mode fail explicitly; there is no silent fallback to another account or authentication method. Existing `new DograhClient({baseUrl, apiKey})` calls continue to work unchanged.

Token normalization is shared in `server/dograh-auth.ts`. `normalizeLoginToken(value)` accepts a raw token, a single `Bearer <token>` header value, or a single `dograh_auth_token=<token>` cookie assignment. It accepts JWT and opaque bearer formats. It rejects complete curl commands, Cookie lists, quotes, embedded whitespace, line breaks and control characters without echoing the input. `normalizeDograhCredential(mode, credential)` exposes the same validation for settings and other adapters. The client never extracts browser storage or cookies itself.

Login tokens follow the Dograh browser session's validity and organization context. The adapter does not assume that opaque tokens are JWTs or validate unsigned expiry claims locally. Dograh validates the token; a `401` produces a reconnect hint asking the user to log in again and update the saved token. It does not refresh the browser session automatically. API keys remain organization-scoped credentials created in the Dograh Developer Portal.

Upstream error bodies and native network exception text are discarded because either can echo credentials. Public media URLs may point to object storage; media downloads attach the selected authentication header only on the exact configured Dograh origin, reevaluating each redirect. Neither Bearer tokens nor API keys are forwarded to a different origin. Object-storage keys such as `recordings/12.wav` are not download URLs; use the run's `recording_public_url`, `user_recording_public_url`, or `bot_recording_public_url`.

## Verified HTTP routes

| Method | Route after the API base                                 | Adapter method                                                   |
| ------ | -------------------------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/workflow/fetch`                                        | `listWorkflows({status?})`                                       |
| GET    | `/workflow/fetch/{id}`                                   | `getWorkflow(id)`                                                |
| POST   | `/workflow/{id}/runs` with `{mode: 'smallwebrtc', name}` | `createVoiceRun(id, name)`                                       |
| GET    | `/workflow/{id}/runs/{runId}`                            | `getRun(id, runId)`                                              |
| GET    | `/workflow/{id}/runs?page=N&limit=N`                     | `listRuns(id, {limit?, maxPages?})`                              |
| POST   | `/workflow/{id}/text-chat/sessions`                      | `createTextSession(id, {name?, initial_context?, annotations?})` |
| GET    | `/workflow/{id}/text-chat/sessions/{runId}`              | `getTextSession(id, runId)`                                      |
| POST   | `/workflow/{id}/text-chat/sessions/{runId}/messages`     | `sendTextMessage(id, runId, text, expectedRevision?)`            |
| POST   | `/workflow/{id}/text-chat/sessions/{runId}/end`          | `endTextSession(id, runId, expectedRevision?)`                   |
| PUT    | `/workflow/{id}` with complete `workflow_definition`     | `applyPromptChanges(snapshot, changes)`                          |

`/workflow/fetch` returns the complete, **unpaginated** workflow array. There is no documented first-page limit to work around; the adapter does not invent pagination arguments or silently accept incompatible response envelopes. Run history is paginated and `listRuns` consumes all reported pages, refusing to return a partial result if the safety cap is exceeded. Concurrent new runs can shift offset pages; use a fixed test batch's returned run IDs for authoritative results.

Sources: [workflow routes](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/routes/workflow.py), [text session routes](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/routes/workflow_text_chat.py), [authentication](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/services/auth/depends.py).

## Voice transport is separate from creating a run

`createVoiceRun` creates the record; it does **not** establish an audio call. A media worker must connect to `wss://<backend>/<api-prefix>/ws/signaling/{workflowId}/{runId}` with exactly one authentication query parameter: `api_key=<key>` in API key mode, or `token=<normalized-token>` in login token mode. URL-encode the value; do not include a `Bearer ` prefix in the `token` query value. Exchange `offer` and `ice-candidate` messages and establish an independent WebRTC peer for each run. The signaling WebSocket does not accept raw PCM audio; sound travels on the WebRTC media track. Keep this socket URL server-side because it contains a credential, and redact it in infrastructure access logs.

Media workers can bridge a real-time tester model's audio to the Dograh track with proper resampling and real-time pacing. Record both directions and a monotonic sample clock. Run creation time is not recording offset zero. Upstream records aligned mixed/user/bot audio and logs with speech timestamps, turn IDs and node IDs, but client-heard timing still needs calibration.

Sources: [signaling](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/routes/webrtc_signaling.py#L836), [recording tracks](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/services/pipecat/in_memory_buffers.py#L89).

## Reviewable prompt edits

`snapshotWorkflow(id)` creates `{workflowId, hash, createdAt, workflow}`. `listPromptFields(workflow)` finds string fields named `prompt`, `system_prompt`, or `qa_system_prompt` directly in node data. Each result includes `{nodeId, nodeName, path, value}`. Paths are JSON Pointers relative to `workflow_definition`, for example `/nodes/0/data/prompt`. No arbitrary path is writable.

Changes have `{nodeId, path, before, after}`. `previewPromptChanges(snapshot, changes)` checks the exact original value, node identity, permitted path and snapshot integrity, then returns a complete copied definition plus the field diff. Graph edges, node IDs, positions, other prompts, nested data and unknown extension fields are preserved.

Only after the UI shows and authorizes the exact diff should the server call `applyPromptChanges`. The caller must persist the complete baseline snapshot before invoking it. The method fetches the current workflow again, rejects stale edit-relevant state, PUTs only `workflow_definition`, and reads it back to compare with the reviewed definition. It never calls publish and never performs automatic rollback. A readback mismatch is reported as `POST_APPLY_VERIFICATION_FAILED`: a write has already occurred, so the saved draft and baseline need inspection.

If a deployment does not return the modern `version_status` and `version_number` metadata, automatic writes are refused with `UNSUPPORTED_DRAFTS`. A legacy PUT must not be assumed to create a separate draft.

**Upstream does not expose an atomic ETag / compare-and-swap precondition for this PUT.** The last read and write can race with another editor. This adapter reduces the stale-write risk but cannot guarantee absence of concurrent overwrites. Pause simultaneous editing during apply; a production implementation requiring a hard guarantee needs a server-side conditional-update endpoint. The result explicitly exposes `atomic: false`.

Snapshot hashes cover definitions, version identity, prompts, relevant configuration, template variables, disposition configuration, name and status. Run counts are excluded so conducting tests does not invalidate an otherwise unchanged baseline. GET responses mask provider credentials; upstream merges those masked node fields with the stored credentials when saving. The adapter does not send unrelated top-level configurations or template variables in its PUT.

## Version and capacity

Workflow GET, voice tests and text tests select the draft when one exists; SIP inbound uses the published workflow. Record `definition_id` and the snapshot hash with every batch. The upstream organization's concurrent call limit defaults to 10 but can be overridden; a 10-call batch can occupy all capacity. Capacity also depends on provider limits and server resources. The adapter does not raise concurrency limits or modify workflows to enable testing.

Sources: [draft resolution](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/services/workflow/run_creation.py), [concurrency defaults](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/constants.py#L207).

## Local verification

```sh
npx vitest run server/dograh.test.ts
```

Tests use injected fake HTTP and require no real credentials, network or live mutation. They cover complete workflow lists, run pagination, both authentication modes, normalization and header injection rejection, actual text/voice request shapes, immutable prompt previews, stale-update rejection, exact-field preservation, readback verification, sanitized errors, reconnect hints and cross-origin media credential isolation.

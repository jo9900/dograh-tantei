# Headless speech bridge

One process connects one pre-created Dograh `smallwebrtc` run to one `gpt-live-1`
caller. It uses no microphone, speaker, browser, or OS loopback device. Python
3.12 is tested; pinned wheels are in `requirements.txt`.

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r audio_worker/requirements.txt
.venv/bin/python -m unittest audio_worker.test_worker -v
```

The integration test uses a real local aiortc WebRTC peer and fake Live and
Dograh signaling servers. It verifies both audio directions, resampling,
timeout-before-response, final usage, and WAV artifacts. It makes no API calls.
Actual deployed Dograh compatibility and paid GPT-Live access remain unverified.

## Process contract

From the repository root, spawn `.venv/bin/python -m audio_worker.worker` with
stdin/stdout pipes. Write **one JSON object followed by a newline** to stdin:

```json
{
  "dograhBaseUrl": "<DOGRAH_BASE_URL>",
  "dograhAuthMode": "apiKey",
  "dograhApiKey": "provided securely at runtime",
  "workflowId": 123,
  "runId": 456,
  "openaiApiKey": "provided securely at runtime",
  "instructions": "あなたはタクシーを予約したい日本語の利用者です。...",
  "voice": "marin",
  "maxDurationSeconds": 120,
  "responseTimeoutSeconds": 10,
  "outputDir": "/absolute/path/to/a/fresh/run-directory"
}
```

Replace `<DOGRAH_BASE_URL>` with your deployment address before sending this
configuration to the worker.

`runId` is the Dograh run ID returned by the parent creating
`POST /api/v1/workflow/{workflowId}/runs` with `mode: smallwebrtc`. Each worker
requires a distinct run and directory. The worker never creates, updates, or
publishes workflows. Keep stdin open. Send `{"type":"stop"}\n` to cancel.
SIGINT/SIGTERM also cancel; stdin EOF stops the call if the parent exits.
`dograhAuthMode` defaults to `apiKey`, preserving the original process contract.
For an existing Dograh login token, set `dograhAuthMode` to `token`, supply
`dograhLoginToken` instead of `dograhApiKey`, and omit the API-key field. Only the
selected credential is required and transmitted:

| Mode               | Credential field   | TURN REST header          | Signaling query |
| ------------------ | ------------------ | ------------------------- | --------------- |
| `apiKey` (default) | `dograhApiKey`     | `X-API-Key`               | `api_key`       |
| `token`            | `dograhLoginToken` | `Authorization: Bearer …` | `token`         |

The worker accepts raw credentials, strips surrounding ordinary spaces, and
rejects internal whitespace, controls, non-ASCII header characters, and unknown
auth modes before opening any provider connection or evidence files. The Node
controller must strip a pasted Bearer prefix/cookie wrapper before sending the
raw token; the Python worker does not reinterpret those formats. Credentials
are never silently substituted between modes.

No secrets are passed in command-line arguments or written to configuration
files. The worker never prints the credential-bearing signaling URL. Raw and
URL-encoded supplied credentials are redacted from event values, and token/
credential fields are removed before stdout and JSONL output. Third-party
logging is disabled. The tests use invented credentials only, including a real
local WebRTC exchange entered through the real JSON-line stdin reader with
`dograhAuthMode: "token"`, and token-mode request/header assertions.

Example Node lifecycle (credentials must already be available in server memory):

```js
const child = spawn(pythonPath, ['-m', 'audio_worker.worker'], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.write(JSON.stringify(config) + '\n');
// Parse stdout one line at a time; retain partial lines across data events.
// Cancellation:
child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
// Allow up to 20 s to finalize usage and WAVs before escalating a stuck process.
```

Stdout and `events.jsonl` contain flushed JSONL events with `type`, `atMs`, and
`runId`. `atMs` is milliseconds since worker startup, backed by a monotonic
clock. The initial `state` event includes `startedAt` UTC for cross-log lookup.

| Event                            | Relevant fields                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                          | `state`: connecting, connected, closing; `reason` when closing                                                                               |
| `provider_session`               | `provider`, `sessionId`, `model`                                                                                                             |
| `transcript`                     | `speaker`: caller/agent, `text` delta, `source`, `transcriptOrigin`, `audioVerified: false`, `afterStop`, `providerStartMs`, `providerEndMs` |
| `speech_started`, `speech_ended` | `speaker`, `startMs`, `endMs`, `evidenceSource`                                                                                              |
| `response_wait_started`          | `startMs`, `turn`, `thresholdMs`                                                                                                             |
| `finding`                        | `code: response_timeout`, `title`, `severity`, `startMs`, `endMs`, `thresholdMs`, `elapsedMs`, `turn`, `confidence`                          |
| `metric`                         | `name: response_latency_ms`, `value`, `startMs`, `endMs`, `priorTimeout`, `exceedsThreshold`, `overlap`, `turn`                              |
| `audio_status`                   | `callerQueueMs`, `agentQueueMs`, speaking flags                                                                                              |
| `usage`                          | `usage`, `cumulative: true`, `final` — replace snapshots, do not add                                                                         |
| `diagnostic`, `error`            | `code`, sanitized details; an `error` stops the worker                                                                                       |
| `dograh_event`                   | `eventType`, sanitized provider `payload`                                                                                                    |
| `artifacts`                      | `files`, `sampleRate`, `durationMs`                                                                                                          |
| `completed`                      | `reason`, `finalUsageConfirmed`, latest `usage`, `sessionId`                                                                                 |

Transcript timestamps remain explicitly on the **provider session clock**;
do not use them as local WAV offsets. Caller text has `transcriptOrigin:
"model_output"`; agent text has `transcriptOrigin: "input_audio_transcription"`.
Neither has been verified against the recorded audio, so `audioVerified` is
always `false`. `afterStop` is true when a transcript arrives after the stop
signal or during cleanup. These transcripts are retained for audit; automated
judgments must exclude `afterStop: true` text. Text received before stop can
also describe audio still queued, so `afterStop: false` does not prove playback.

The final `diagnostic` event with `code: "caller_audio_delivery"` records
`sampleRate`, `generatedSamples`, `sentSamples`, `unsentSamples`,
`ignoredSamples`, and `cutoffReason`. `generatedSamples` counts complete PCM16
samples successfully decoded from Live output, including audio ignored after
stop. `sentSamples` counts source samples consumed by the local outbound track;
silence padding is excluded, while silence present in source PCM is included.
`unsentSamples = generatedSamples - sentSamples`. `ignoredSamples` is a subset
of unsent samples that never entered the queue (after stop/cleanup or on queue
overflow); the remaining unsent samples stayed queued. `cutoffReason` is the
worker stop reason, even when no samples were left unsent. These are local
delivery counters, not remote receipt acknowledgments or word/audio alignment.

Local acoustic events use sample positions
in the WAVs. Audio artifacts are 24 kHz mono PCM16: `caller.wav` contains audio
actually pulled by the outbound WebRTC track; `agent.wav` contains decoded audio
received at the bridge; `mixed.wav` combines both at half gain. Initial gaps and
short queue underflows are silence-padded. Queues are bounded, overflow stops
the run, and pacing does not burst after event-loop stalls. The recorder refuses
to overwrite existing run artifacts.

## Measurement limits

Rejected WebSocket handshakes emit `live_handshake_failed` or
`dograh_handshake_failed`, with `provider`, `stage`, `httpStatus`, an allowlisted
`providerCode`, and an actionable message. Raw response bodies, headers and
credential-bearing URLs are never logged. Authentication failures are not
retried automatically; the scheduler pauses the task.

The first version uses an RMS threshold of 400 / 32768 and 300 ms silence
hangover. End times refer to the last detected audible sample, not the delayed
hangover event. A separate 20 ms monitor reports the timeout even if no reply
ever arrives, and a late response still receives its latency measurement.
Later caller prompts do not postpone an unanswered deadline.
Set `responseTimeoutSeconds` to `null` to disable timeout findings while retaining
acoustic activity and latency measurements.

This is acoustic activity detection, **not** semantic speech detection or
substantive task completion. Noise, quiet speech, acknowledgments, and overlapping
speech need audio review. A currently audible agent can produce a zero-latency
overlap measurement. Transport and jitter-buffer delay are included. With no
server telemetry, this cannot identify STT, LLM, or TTS as the root cause.

The bridge tries Dograh's TURN credentials endpoint and falls back to STUN/direct
ICE when TURN is unavailable; relay-only deployments and NAT must be tested with
the actual server. `maxDurationSeconds` covers the entire session starting at
worker initialization, including connection setup: connecting does not reset
the time budget. Initial connection is also bounded to 75 s, or the remaining
session budget when shorter. Cancellation allows 5 s for the
Live `session.closed` event before reporting unconfirmed final usage, then
closes transports and finalizes WAVs. The caller uses client delegation and
no external tools or backend model; delegated requests receive a role reminder.

## Protocol sources checked

- [OpenAI Live server WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live): `wss://api.openai.com/v1/live/sessions`, `session.start`, continuous paced `session.input_audio.append`, `session.output_audio.delta`, and graceful close.
- [OpenAI Live delegation](https://developers.openai.com/api/docs/guides/live-delegation): client delegation and `session.thinking.append`.
- [Dograh upstream signaling](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/routes/webrtc_signaling.py): WS exchanges SDP/ICE; PCM travels over WebRTC.
- [Dograh upstream authentication](https://github.com/dograh-hq/dograh/blob/cdf2e4bc41c5d93960b58b3678bbb23b449b2fd8/api/services/auth/depends.py): `api_key` query for signaling and `X-API-Key` for REST.

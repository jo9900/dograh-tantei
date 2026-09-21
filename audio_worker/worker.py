"""A single paid-call worker. No sound devices are used; credentials enter via stdin.

The WebRTC track is the actual caller playback clock, not model generation time.
Acoustic timing is diagnostic RMS activity, not proof of a substantive answer.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import math
from pathlib import Path
import signal
import sys
import time
import uuid
import wave
from datetime import datetime, timezone
from fractions import Fraction
from urllib.error import HTTPError
from urllib.parse import quote, quote_plus, urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

import av
import numpy as np
from aiortc import AudioStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from aiortc.sdp import candidate_from_sdp
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

RATE = 24000
FRAME_SAMPLES = 480
FRAME_MS = 20
SILENCE = bytes(FRAME_SAMPLES * 2)
LIVE_URL = "wss://api.openai.com/v1/live/sessions"


class HandshakeFailure(Exception):
    """Preserve actionable transport metadata without logging URLs, headers or bodies."""
    def __init__(self, provider: str, response):
        status = response.status_code
        self.http_status = status if isinstance(status, int) and 100 <= status <= 599 else None
        self.provider = provider
        self.provider_code = None
        body = response.body
        if isinstance(body, (bytes, bytearray)) and len(body) <= 16_384:
            try:
                error = json.loads(body).get("error", {})
                code = error.get("code") if isinstance(error, dict) else None
                # Upstream fields are untrusted: even a 'code' could contain a credential.
                if isinstance(code, str) and code in {"invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "model_not_found", "permission_denied"}:
                    self.provider_code = code
            except (ValueError, AttributeError):
                pass
        label = "GPT-Live 1 / OpenAI" if provider == "openai" else "Dograh"
        detail = f"HTTP {self.http_status}" if self.http_status is not None else "HTTP 状态未知"
        if self.provider_code:
            detail += f" / {self.provider_code}"
        if self.http_status == 401:
            hint = "OpenAI API Key 认证失败，请检查项目 .env 中的 OPENAI_API_KEY，更新后重启。" if provider == "openai" else "Dograh 登录 Token 认证失败，请重新登录并更新 Token。"
        elif self.provider_code == "insufficient_quota":
            hint = "API 额度不足，请检查该账号的余额及用量限制。"
        elif self.http_status == 429:
            hint = "请求或并发受到限制，请检查账号额度、降低并发后重试。"
        elif self.http_status == 403:
            hint = "访问被拒绝，请检查模型或服务的访问权限。"
        elif self.http_status == 404:
            hint = "语音连接接口不存在，请检查服务地址和接口配置。"
        elif self.http_status is not None and self.http_status >= 500:
            hint = "远端服务暂时异常，请稍后重试。"
        else:
            hint = "服务拒绝了语音连接，请检查连接配置。"
        super().__init__(f"{label} WebSocket 握手失败（{detail}）。{hint}")

    def event(self):
        return {"code": "live_handshake_failed" if self.provider == "openai" else "dograh_handshake_failed",
                "provider": self.provider, "stage": "websocket_handshake", "httpStatus": self.http_status,
                "providerCode": self.provider_code, "message": str(self)}


async def connect_socket(url: str, *, provider: str, **options):
    try:
        return await connect(url, **options)
    except InvalidStatus as exc:
        raise HandshakeFailure(provider, exc.response) from None


def api_base(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("dograhBaseUrl must be an HTTP(S) API origin")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("dograhBaseUrl cannot contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    if path in {"", "/api", "/workflow"} or path.startswith("/workflow/"):
        path = "/api/v1"
    # Keep an explicit reverse-proxy API prefix, matching the Node adapter.
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def normalize_credential(value, field="credential") -> str:
    """Accept raw ASCII credentials, trim surrounding spaces, never echo them."""
    if not isinstance(value, str) or not value.strip(" "):
        raise ValueError(f"{field} is required")
    result = value.strip(" ")
    # Reject internal whitespace, CR/LF, other controls and non-ASCII header text.
    # In particular, do not silently reinterpret an entire Authorization header.
    if any(ord(char) < 33 or ord(char) > 126 for char in result):
        raise ValueError(f"{field} must be one raw credential without whitespace or control characters")
    return result


def dograh_auth(credential, auth_mode="apiKey") -> str:
    if not isinstance(auth_mode, str) or auth_mode not in {"apiKey", "token"}:
        raise ValueError("dograhAuthMode must be apiKey or token")
    field = "dograhApiKey" if auth_mode == "apiKey" else "dograhLoginToken"
    return normalize_credential(credential, field)


def dograh_headers(credential, auth_mode="apiKey") -> dict[str, str]:
    credential = dograh_auth(credential, auth_mode)
    return {"X-API-Key": credential} if auth_mode == "apiKey" else {"Authorization": f"Bearer {credential}"}


def signaling_url(base: str, workflow_id: int, run_id: int, key: str, auth_mode="apiKey") -> str:
    credential = dograh_auth(key, auth_mode)
    parsed = urlsplit(api_base(base))
    return urlunsplit(("wss" if parsed.scheme == "https" else "ws", parsed.netloc,
                       f"{parsed.path}/ws/signaling/{workflow_id}/{run_id}",
                       urlencode({"api_key" if auth_mode == "apiKey" else "token": credential}), ""))


class Clock:
    def __init__(self):
        self.origin = time.monotonic()

    def ms(self) -> float:
        return (time.monotonic() - self.origin) * 1000


class Events:
    def __init__(self, directory: Path, run_id, clock: Clock, secrets=(), stream=None):
        self.clock, self.run_id = clock, run_id
        self.stream = sys.stdout if stream is None else stream
        self.secrets = sorted({v for s in secrets if isinstance(s, str) and s
                               for raw in (s, s.strip(" ")) if raw
                               for v in (raw, quote(raw, safe=""), quote_plus(raw, safe=""))}, key=len, reverse=True)
        self.file = (directory / "events.jsonl").open("x", encoding="utf-8")

    def clean(self, value):
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, "[REDACTED]")
            return value
        if isinstance(value, dict):
            return {k: self.clean(v) for k, v in value.items()
                    if not any(s in k.lower() for s in ("apikey", "api_key", "authorization", "credential", "password", "token"))}
        if isinstance(value, (list, tuple)):
            return [self.clean(v) for v in value]
        return value

    def emit(self, kind: str, **values):
        item = self.clean({"type": kind, "atMs": round(self.clock.ms(), 3), "runId": self.run_id, **values})
        line = json.dumps(item, ensure_ascii=False, allow_nan=False)
        self.file.write(line + "\n")
        self.file.flush()
        print(line, file=self.stream, flush=True)
        return item

    def close(self):
        self.file.close()


class PCMQueue:
    """Bounded ordered PCM, with exact silence padding at the consumer clock."""
    def __init__(self, max_seconds=15):
        self.buffer = bytearray()
        self.limit = int(RATE * 2 * max_seconds)
        self.consumed_samples = 0

    def append(self, pcm: bytes):
        if len(pcm) % 2:
            raise ValueError("PCM16 requires complete samples")
        if len(self.buffer) + len(pcm) > self.limit:
            raise BufferError("audio queue overflow; timing no longer trustworthy")
        self.buffer.extend(pcm)

    def take(self, samples=FRAME_SAMPLES) -> bytes:
        needed = samples * 2
        out = bytes(self.buffer[:needed])
        del self.buffer[:needed]
        self.consumed_samples += len(out) // 2
        return out + bytes(needed - len(out))

    @property
    def milliseconds(self):
        return len(self.buffer) * 1000 / (RATE * 2)


class Recording:
    """Append aligned WAV tracks; never replace existing evidence files."""
    def __init__(self, directory: Path):
        self.directory = directory
        self.files = {}
        self.positions = {"caller": 0, "agent": 0}
        self.closed = False
        for speaker in self.positions:
            # The exclusive OS open also prevents following an existing symlink.
            file = (directory / f"{speaker}.wav").open("xb")
            writer = wave.open(file, "wb")
            writer.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
            self.files[speaker] = (writer, file)

    def write(self, speaker: str, pcm: bytes, start_ms: float):
        desired = max(0, round(start_ms * RATE / 1000))
        start = max(desired, self.positions[speaker])
        writer, _ = self.files[speaker]
        missing = start - self.positions[speaker]
        while missing:
            chunk = min(missing, RATE)
            writer.writeframesraw(bytes(chunk * 2))
            missing -= chunk
        writer.writeframesraw(pcm)
        end = start + len(pcm) // 2
        self.positions[speaker] = end
        return start * 1000 / RATE, end * 1000 / RATE

    def finish(self, end_ms: float):
        if self.closed:
            return
        self.closed = True
        length = max(round(end_ms * RATE / 1000), *self.positions.values())
        for speaker, (writer, file) in self.files.items():
            remaining = length - self.positions[speaker]
            while remaining > 0:
                n = min(remaining, RATE)
                writer.writeframesraw(bytes(n * 2))
                remaining -= n
            writer.close()
            file.close()
        with wave.open(str(self.directory / "caller.wav"), "rb") as caller, \
                wave.open(str(self.directory / "agent.wav"), "rb") as agent, \
                (self.directory / "mixed.wav").open("xb") as file:
            with wave.open(file, "wb") as mixed:
                mixed.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
                while True:
                    a, b = caller.readframes(RATE), agent.readframes(RATE)
                    if not a and not b:
                        break
                    # Half gain preserves overlap without clipping.
                    samples = (np.frombuffer(a, dtype="<i2").astype(np.int32)
                               + np.frombuffer(b, dtype="<i2").astype(np.int32)) // 2
                    mixed.writeframesraw(samples.astype("<i2").tobytes())


class RMSActivity:
    """Conservative energy threshold and 300 ms end hangover; not semantic VAD."""
    def __init__(self, speaker, callback, threshold=400.0, hangover_ms=300):
        self.speaker, self.callback = speaker, callback
        self.threshold, self.hangover_ms = threshold, hangover_ms
        self.active = False
        self.start = self.last_voiced = None

    def feed(self, pcm: bytes, start_ms: float, end_ms: float):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
        rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0
        if rms >= self.threshold:
            if not self.active:
                self.active, self.start = True, start_ms
                self.callback("speech_started", self.speaker, start_ms, start_ms)
            self.last_voiced = end_ms
        else:
            self.advance(end_ms)

    def advance(self, now_ms):
        if self.active and now_ms - self.last_voiced >= self.hangover_ms:
            self.active = False
            self.callback("speech_ended", self.speaker, self.start, self.last_voiced)


class ResponseWatchdog:
    """An autonomous deadline, independent of whether the agent ever replies."""
    def __init__(self, seconds, emit):
        self.threshold_ms = None if seconds is None else float(seconds) * 1000
        self.emit = emit
        self.pending = None
        self.reported = False
        self.agent_active = False
        self.agent_last_start = None
        self.sequence = 0

    def speech(self, kind, speaker, start_ms, end_ms):
        if speaker == "agent":
            self.agent_active = kind == "speech_started"
            if self.agent_active:
                self.agent_last_start = start_ms
                if self.pending is not None:
                    self.responded(start_ms)
        elif kind == "speech_ended" and self.pending is None:
            self.sequence += 1
            self.pending = end_ms
            self.reported = False
            self.emit("response_wait_started", startMs=end_ms, turn=self.sequence,
                      thresholdMs=self.threshold_ms, evidenceSource="local_audio_rms")
            # An agent onset may occur during the caller end detector's hangover.
            if self.agent_last_start is not None and self.agent_last_start >= end_ms:
                self.responded(self.agent_last_start)
            elif self.agent_active:
                self.responded(end_ms, overlap=True)

    def responded(self, when, overlap=False):
        self.emit("metric", name="response_latency_ms", value=max(0, when - self.pending),
                  startMs=self.pending, endMs=max(self.pending, when), turn=self.sequence,
                  exceedsThreshold=self.threshold_ms is not None and when - self.pending > self.threshold_ms,
                  priorTimeout=self.reported, overlap=overlap, evidenceSource="local_audio_rms",
                  interpretation="First audible agent activity; not substantive answer latency")
        self.pending = None

    def tick(self, now_ms):
        if self.threshold_ms is not None and self.pending is not None and not self.reported and now_ms - self.pending >= self.threshold_ms:
            self.reported = True
            self.emit("finding", code="response_timeout", title="Agent audible response exceeded threshold",
                      severity="warning", startMs=self.pending, endMs=now_ms, turn=self.sequence,
                      thresholdMs=self.threshold_ms, elapsedMs=now_ms - self.pending,
                      evidenceSource="local_audio_rms", confidence="diagnostic",
                      description="No agent audio above the RMS threshold after caller audio ended; review both audio tracks.")


class CallerTrack(AudioStreamTrack):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner
        self.pts = 0
        self.next_at = None

    async def recv(self):
        if self.readyState != "live" or self.owner.stop.is_set():
            raise MediaStreamError
        now = time.monotonic()
        if self.next_at is None:
            self.next_at = now
        # Never send a backlog in a burst after event-loop starvation.
        if now - self.next_at > 0.06:
            self.owner.events.emit("diagnostic", code="caller_clock_late", lateMs=(now-self.next_at)*1000)
            self.next_at = now
        await asyncio.sleep(max(0, self.next_at - now))
        if self.owner.stop.is_set():
            raise MediaStreamError
        self.next_at += FRAME_MS / 1000
        pcm = self.owner.caller_queue.take()
        start, end = self.owner.recording.write("caller", pcm, self.owner.clock.ms())
        self.owner.activities["caller"].feed(pcm, start, end)
        frame = av.AudioFrame.from_ndarray(np.frombuffer(pcm, dtype="<i2").reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate, frame.pts, frame.time_base = RATE, self.pts, Fraction(1, RATE)
        self.pts += FRAME_SAMPLES
        return frame


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch_turn(base, key, auth_mode="apiKey"):
    request = Request(api_base(base) + "/turn/credentials", headers=dograh_headers(key, auth_mode))
    try:
        with build_opener(NoRedirect()).open(request, timeout=8) as response:
            return json.loads(response.read(65536))
    except HTTPError as exc:
        if exc.code in {404, 503}:
            return None
        raise RuntimeError(f"Dograh TURN configuration HTTP {exc.code}") from None


class Worker:
    def __init__(self, config, *, event_stream=None):
        config = dict(config)
        self.config = config
        raw_secrets = (config.get("dograhApiKey"), config.get("dograhLoginToken"), config.get("openaiApiKey"))
        self.auth_mode = config.get("dograhAuthMode", "apiKey")
        field = "dograhApiKey" if self.auth_mode == "apiKey" else "dograhLoginToken"
        self.dograh_credential = dograh_auth(config.get(field), self.auth_mode)
        config["dograhAuthMode"], config[field] = self.auth_mode, self.dograh_credential
        config.pop("dograhLoginToken" if self.auth_mode == "apiKey" else "dograhApiKey", None)
        config["openaiApiKey"] = normalize_credential(config.get("openaiApiKey"), "openaiApiKey")
        for field in ("instructions", "outputDir"):
            if not isinstance(config.get(field), str) or not config[field].strip():
                raise ValueError(f"{field} is required")
        config["dograhBaseUrl"] = api_base(config["dograhBaseUrl"])
        for field in ("workflowId", "runId"):
            value = int(config[field])
            if value <= 0:
                raise ValueError(f"{field} must be a positive integer")
            config[field] = value
        self.duration = float(config.get("maxDurationSeconds", 120))
        raw_threshold = config.get("responseTimeoutSeconds", 10)
        threshold = None if raw_threshold is None else float(raw_threshold)
        if not math.isfinite(self.duration) or not 1 <= self.duration <= 3600:
            raise ValueError("maxDurationSeconds must be 1–3600")
        if threshold is not None and (not math.isfinite(threshold) or not 0.1 <= threshold <= 300):
            raise ValueError("responseTimeoutSeconds must be null or 0.1–300")
        self.directory = Path(config["outputDir"]).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        if any((self.directory / name).exists() for name in ("events.jsonl", "caller.wav", "agent.wav", "mixed.wav")):
            raise ValueError("outputDir already contains audio evidence; use a fresh run directory")
        self.clock = Clock()
        self.events = Events(self.directory, config["runId"], self.clock,
                             (*raw_secrets, self.dograh_credential, config["openaiApiKey"]), event_stream)
        self.recording = Recording(self.directory)
        self.stop, self.connected, self.live_started, self.live_closed = (asyncio.Event() for _ in range(4))
        self.caller_queue, self.agent_queue = PCMQueue(15), PCMQueue(2)
        self.caller_generated_samples = 0
        self.caller_ignored_samples = 0
        self.watchdog = ResponseWatchdog(threshold, self.events.emit)
        self.activities = {s: RMSActivity(s, self.on_speech) for s in ("caller", "agent")}
        self.pc = self.live = self.signaling = None
        self.tasks = []
        self.reason = "unknown"
        self.stop_at_ms = None
        self.usage = None
        self.live_session_id = None
        self.closing = False

    def on_speech(self, kind, speaker, start, end):
        self.events.emit(kind, speaker=speaker, startMs=start, endMs=end, evidenceSource="local_audio_rms")
        self.watchdog.speech(kind, speaker, start, end)

    def request_stop(self, reason="cancelled"):
        if not self.stop.is_set():
            self.reason = reason
            self.stop_at_ms = self.clock.ms()
            self.stop.set()

    def task(self, coroutine, name):
        async def guarded():
            try:
                await coroutine
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not self.closing:
                    self.events.emit("error", code=f"{name}_failed", message=type(exc).__name__)
                    self.request_stop(f"{name}_failed")
        task = asyncio.create_task(guarded(), name=name)
        self.tasks.append(task)
        return task

    async def send_live(self, event):
        await asyncio.wait_for(self.live.send(json.dumps(event)), timeout=5)

    async def receive_live(self):
        async for raw in self.live:
            event = json.loads(raw)
            kind = event.get("type", "unknown")
            if kind == "session.started":
                self.live_session_id = event.get("session", {}).get("id")
                self.live_started.set()
                self.events.emit("provider_session", provider="openai", sessionId=self.live_session_id, model="gpt-live-1")
            elif kind == "session.output_audio.delta":
                pcm = base64.b64decode(event["delta"], validate=True)
                if len(pcm) % 2:
                    raise ValueError("PCM16 requires complete samples")
                samples = len(pcm) // 2
                self.caller_generated_samples += samples
                if self.closing or self.stop.is_set():
                    self.caller_ignored_samples += samples
                else:
                    try:
                        self.caller_queue.append(pcm)
                    except BufferError:
                        self.caller_ignored_samples += samples
                        raise
            elif kind in {"session.input_transcript.delta", "session.output_transcript.delta"}:
                self.events.emit("transcript", speaker="agent" if "input_transcript" in kind else "caller",
                                 text=event.get("delta", ""), source="gpt-live-1",
                                 transcriptOrigin="input_audio_transcription" if "input_transcript" in kind else "model_output",
                                 audioVerified=False, afterStop=self.closing or self.stop.is_set(),
                                 providerStartMs=event.get("start_ms"), providerEndMs=event.get("end_ms"),
                                 timingBasis="provider_session; use local audio events for evidence timing")
            elif kind in {"session.usage.updated", "session.closed"}:
                self.usage = event.get("usage", self.usage)
                self.events.emit("usage", provider="openai", cumulative=True, usage=self.usage,
                                 final=kind == "session.closed")
                if kind == "session.closed":
                    self.live_closed.set()
                    self.request_stop("live_session_closed")
                    return
            elif kind == "error":
                error = event.get("error", {})
                self.events.emit("error", code="live_api_error", providerCode=error.get("code"),
                                 message=str(error.get("message", "Live API rejected the session"))[:500])
                self.request_stop("live_api_error")
            elif kind == "session.delegation.created":
                delegation = event.get("delegation", {})
                self.events.emit("diagnostic", code="caller_delegation", delegationId=delegation.get("id"))
                # The test caller needs no backend tools or extra paid reasoning model.
                # Return the authored role context without manufacturing business facts.
                await self.send_live({"type": "session.thinking.append", "delegation_id": delegation.get("id"),
                                      "content": "You are the simulated caller. No backend action is available. Continue the authored caller scenario and ask the other party for missing facts."})
            elif kind == "response.event":
                self.events.emit("provider_event", provider="openai", eventType=event.get("event", {}).get("type"))
        if not self.live_closed.is_set():
            self.events.emit("diagnostic", code="live_final_usage_unconfirmed")
            self.request_stop("live_connection_closed")

    async def receive_signaling(self):
        async for raw in self.signaling:
            event = json.loads(raw)
            kind, payload = event.get("type"), event.get("payload", {})
            if kind == "answer":
                await asyncio.wait_for(self.pc.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"], type="answer")), 15)
            elif kind == "ice-candidate":
                candidate = payload.get("candidate")
                if candidate and candidate.get("candidate"):
                    parsed = candidate_from_sdp(candidate["candidate"].removeprefix("candidate:"))
                    parsed.sdpMid, parsed.sdpMLineIndex = candidate.get("sdpMid"), candidate.get("sdpMLineIndex")
                    await self.pc.addIceCandidate(parsed)
            elif kind == "error":
                self.events.emit("error", code="dograh_signaling_error", providerCode=payload.get("error_type"),
                                 message=str(payload.get("message", "Dograh signaling failed"))[:500])
                self.request_stop("dograh_signaling_error")
            elif kind == "call-ended":
                self.request_stop("dograh_call_ended")
                return
            else:
                self.events.emit("dograh_event", eventType=kind, payload=payload)
        self.request_stop("dograh_signaling_closed")

    async def receive_agent(self, track):
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        try:
            while not self.stop.is_set():
                frame = await track.recv()
                if self.stop.is_set():
                    return
                converted = resampler.resample(frame)
                for audio in converted:
                    pcm = audio.to_ndarray().astype("<i2", copy=False).tobytes()
                    start, end = self.recording.write("agent", pcm, self.clock.ms())
                    self.activities["agent"].feed(pcm, start, end)
                    self.agent_queue.append(pcm)
        except MediaStreamError:
            self.request_stop("dograh_audio_ended")

    async def send_agent_audio(self):
        await self.connected.wait()
        next_at = time.monotonic()
        while not self.stop.is_set():
            now = time.monotonic()
            if now - next_at > 0.06:
                self.events.emit("diagnostic", code="input_clock_late", lateMs=(now-next_at)*1000)
                next_at = now
            await asyncio.sleep(max(0, next_at-now))
            next_at += FRAME_MS / 1000
            pcm = self.agent_queue.take()
            await self.send_live({"type": "session.input_audio.append", "audio": base64.b64encode(pcm).decode("ascii")})

    async def monitor(self):
        await self.connected.wait()
        last_meter = 0
        while not self.stop.is_set():
            now = self.clock.ms()
            for activity in self.activities.values():
                activity.advance(now)
            self.watchdog.tick(now)
            if now-last_meter >= 1000:
                self.events.emit("audio_status", callerQueueMs=self.caller_queue.milliseconds,
                                 agentQueueMs=self.agent_queue.milliseconds,
                                 callerSpeaking=self.activities["caller"].active,
                                 agentSpeaking=self.activities["agent"].active)
                last_meter = now
            await asyncio.sleep(0.02)

    async def setup(self):
        self.events.emit("state", state="connecting", startedAt=datetime.now(timezone.utc).isoformat(),
                         sampleRate=RATE, model="gpt-live-1", workflowId=self.config["workflowId"])
        self.live = await connect_socket(LIVE_URL, provider="openai",
                                  additional_headers={"Authorization": f"Bearer {self.config['openaiApiKey']}"},
                                  open_timeout=15, close_timeout=5, ping_interval=20, ping_timeout=20,
                                  max_size=4*1024*1024, proxy=None)
        self.task(self.receive_live(), "live_receiver")
        await self.send_live({"type": "session.start", "session": {
            "model": "gpt-live-1", "instructions": self.config["instructions"] + "\n接続完了のアプリ指示が届くまでは発話せず待ってください。",
            "audio": {"format": {"type": "audio/pcm", "rate": RATE}, "output": {"voice": self.config.get("voice", "marin")}},
            "delegation": {"type": "client"},
        }})
        await asyncio.wait_for(self.live_started.wait(), 15)
        ice_servers = [RTCIceServer(urls="stun:stun.l.google.com:19302")]
        try:
            turn = await asyncio.to_thread(fetch_turn, self.config["dograhBaseUrl"], self.dograh_credential, self.auth_mode)
            if turn:
                ice_servers.append(RTCIceServer(urls=turn["uris"], username=turn["username"], credential=turn["password"]))
            self.events.emit("diagnostic", code="turn_available" if turn else "turn_unavailable")
        except Exception as exc:
            self.events.emit("diagnostic", code="turn_lookup_failed", message=type(exc).__name__)
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
        self.pc.addTrack(CallerTrack(self))

        @self.pc.on("track")
        def on_track(track):
            if track.kind == "audio":
                self.task(self.receive_agent(track), "agent_audio")

        @self.pc.on("connectionstatechange")
        def connection_state():
            state = self.pc.connectionState
            self.events.emit("transport_state", transport="dograh_webrtc", state=state)
            if state == "connected":
                self.connected.set()
            elif state in {"failed", "closed"} and not self.closing:
                self.request_stop(f"webrtc_{state}")

        self.signaling = await connect_socket(signaling_url(self.config["dograhBaseUrl"], self.config["workflowId"],
                                                    self.config["runId"], self.dograh_credential, self.auth_mode),
                                       provider="dograh",
                                       open_timeout=15, close_timeout=5, ping_interval=20, ping_timeout=20,
                                       max_size=2*1024*1024, proxy=None)
        self.task(self.receive_signaling(), "dograh_signaling")
        # aiortc gathers complete ICE candidates in setLocalDescription; no trickle race.
        await asyncio.wait_for(self.pc.setLocalDescription(await self.pc.createOffer()), 15)
        await asyncio.wait_for(self.signaling.send(json.dumps({"type": "offer", "payload": {
            "pc_id": str(uuid.uuid4()), "sdp": self.pc.localDescription.sdp, "type": "offer",
        }})), 5)
        await asyncio.wait_for(self.connected.wait(), 25)
        self.events.emit("state", state="connected")
        self.task(self.send_agent_audio(), "live_audio_sender")
        self.task(self.monitor(), "watchdog")
        await self.send_live({"type": "session.instructions.append", "delegation_id": None,
                              "content": "通話先に接続しました。相手の挨拶を短く待ち、指定された利用者の役割とシナリオに従って指定された言語で会話を始めてください。"})

    async def cleanup(self):
        self.closing = True
        self.events.emit("state", state="closing", reason=self.reason)
        # Keep the Live receiver running until final usage arrives.
        if self.live and self.live_started.is_set() and not self.live_closed.is_set():
            try:
                await self.send_live({"type": "session.close"})
                await asyncio.wait_for(self.live_closed.wait(), 5)
            except Exception:
                self.events.emit("diagnostic", code="live_final_usage_unconfirmed")
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for resource in (self.pc, self.signaling, self.live):
            if resource:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(resource.close(), 5)
        # Usage finalization may take seconds; it must not inflate response latency
        # or create a timeout after the user has already cancelled the call.
        end = self.stop_at_ms if self.stop_at_ms is not None else self.clock.ms()
        for activity in self.activities.values():
            activity.advance(end + 301)
        self.watchdog.tick(end)
        self.recording.finish(end)
        sent_samples = self.caller_queue.consumed_samples
        self.events.emit("diagnostic", code="caller_audio_delivery", sampleRate=RATE,
                         generatedSamples=self.caller_generated_samples, sentSamples=sent_samples,
                         unsentSamples=self.caller_generated_samples - sent_samples,
                         ignoredSamples=self.caller_ignored_samples, cutoffReason=self.reason,
                         evidenceSource="local_outbound_track",
                         interpretation="Source PCM consumed locally; excludes padding, does not confirm remote receipt or align transcript words")
        duration_ms = max(end, max(self.recording.positions.values()) * 1000 / RATE)
        self.events.emit("artifacts", sampleRate=RATE, durationMs=duration_ms, files={
            "caller": "caller.wav", "agent": "agent.wav", "mixed": "mixed.wav", "events": "events.jsonl"})
        self.events.emit("completed", reason=self.reason, finalUsageConfirmed=self.live_closed.is_set(),
                         usage=self.usage, sessionId=self.live_session_id)

    async def run(self):
        # The reservation includes all connection work: Live opens before ICE.
        # Do not grant a fresh full-duration budget after WebRTC connects.
        setup = asyncio.create_task(asyncio.wait_for(self.setup(), timeout=75))
        stopped = asyncio.create_task(self.stop.wait())
        deadline = asyncio.create_task(asyncio.sleep(max(0, self.duration - self.clock.ms()/1000)))
        try:
            done, _ = await asyncio.wait((setup, stopped, deadline), return_when=asyncio.FIRST_COMPLETED)
            if deadline in done:
                if not self.connected.is_set():
                    self.events.emit("error", code="connection_budget_exhausted", message="Session duration budget elapsed before WebRTC connected")
                    self.request_stop("connection_budget_exhausted")
                else:
                    self.request_stop("max_duration")
            elif setup in done:
                await setup
                done, _ = await asyncio.wait((stopped, deadline), return_when=asyncio.FIRST_COMPLETED)
                if deadline in done:
                    self.request_stop("max_duration")
        except TimeoutError:
            self.events.emit("error", code="startup_timeout", message="Connection setup exceeded 75 seconds")
            self.request_stop("startup_timeout")
        except HandshakeFailure as exc:
            self.events.emit("error", **exc.event())
            self.request_stop(exc.event()["code"])
        except Exception as exc:
            self.events.emit("error", code="startup_failed", message=type(exc).__name__)
            self.request_stop("startup_failed")
        finally:
            setup.cancel()
            stopped.cancel()
            deadline.cancel()
            await asyncio.gather(setup, stopped, deadline, return_exceptions=True)
            try:
                await self.cleanup()
            finally:
                self.events.close()


async def stdin_lines():
    reader = asyncio.StreamReader(limit=1024*1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    try:
        while line := await reader.readline():
            yield line
    finally:
        transport.close()


async def main():
    # Third-party connection errors can contain credential-bearing URLs.
    # Only explicitly sanitized JSONL events leave this worker.
    logging.disable(logging.CRITICAL)
    lines = stdin_lines()
    worker = None
    listener = None
    try:
        raw = await anext(lines)
        config = json.loads(raw)
        worker = Worker(config)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, worker.request_stop, "cancelled")

        async def controls():
            async for line in lines:
                try:
                    command = json.loads(line)
                    if command.get("type") == "stop":
                        worker.request_stop("cancelled")
                    else:
                        worker.events.emit("diagnostic", code="unknown_control")
                except (ValueError, AttributeError):
                    worker.events.emit("diagnostic", code="invalid_control")
            # A parent exiting must not leave a paid session behind.
            worker.request_stop("stdin_closed")

        listener = asyncio.create_task(controls())
        await worker.run()
        return 0 if worker.reason in {"max_duration", "cancelled", "stdin_closed", "dograh_call_ended", "live_session_closed", "dograh_audio_ended"} else 1
    except Exception as exc:
        # Invalid configuration must never echo its raw stdin or exception values.
        print(json.dumps({"type": "error", "atMs": 0, "code": "worker_initialization_failed", "message": type(exc).__name__}), flush=True)
        return 1
    finally:
        if listener:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)
        await lines.aclose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

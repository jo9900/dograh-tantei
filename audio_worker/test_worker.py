"""No credentials or external network. Includes a real in-process WebRTC pair."""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import wave
from fractions import Fraction
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, quote, quote_plus, urlsplit

import av
import numpy as np
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response

from audio_worker.worker import (
    Clock, Events, FRAME_SAMPLES, PCMQueue, RATE, Recording, ResponseWatchdog,
    RMSActivity, SILENCE, Worker, CallerTrack, HandshakeFailure, api_base, signaling_url, fetch_turn, dograh_headers, main,
)


def tone(samples=FRAME_SAMPLES, amplitude=3000):
    return (np.sin(np.arange(samples) * 2*np.pi*440/RATE)*amplitude).astype("<i2").tobytes()


class AudioPrimitivesTest(unittest.TestCase):
    def test_handshake_details_exclude_untrusted_bodies_headers_and_error_codes(self):
        for status, code in ((401, "invalid_api_key"), (403, "secret-from-server"), (429, "insufficient_quota"), (503, None)):
            with self.subTest(status=status):
                response = Response(status, "secret-reason", Headers({"Authorization": "secret-header"}),
                                    body=json.dumps({"error": {"code": code, "message": "secret-body"}}).encode())
                details = HandshakeFailure("openai", response).event()
                self.assertEqual(details["httpStatus"], status)
                self.assertEqual(details["providerCode"], code if code in {"invalid_api_key", "insufficient_quota"} else None)
                self.assertIn(f"HTTP {status}", details["message"])
                self.assertNotIn("secret", json.dumps(details))
        for body in (b"<html>secret</html>", b"[]", b"null", b"secret"*4000):
            failure = HandshakeFailure("dograh", Response(403, "Forbidden", Headers(), body=body))
            self.assertIn("Dograh", str(failure))
            self.assertIsNone(failure.provider_code)
            self.assertNotIn("secret", str(failure))

    def test_pcm_queue_preserves_order_and_pads_silence(self):
        queue = PCMQueue(1)
        queue.append(b"\x01\x00\x02\x00")
        self.assertEqual(queue.take(3), b"\x01\x00\x02\x00\x00\x00")
        self.assertEqual(queue.consumed_samples, 2)
        self.assertEqual(queue.take(1), b"\x00\x00")
        self.assertEqual(queue.consumed_samples, 2, "padding must not count as consumed source audio")
        with self.assertRaises(ValueError):
            queue.append(b"\x01")
        with self.assertRaises(BufferError):
            queue.append(bytes(RATE*2+2))

    def test_tracks_align_to_one_clock_and_do_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = Recording(Path(directory))
            self.assertEqual(recorder.write("caller", tone(), 100), (100, 120))
            self.assertEqual(recorder.write("agent", tone(), 140), (140, 160))
            recorder.finish(200)
            for name in ("caller", "agent", "mixed"):
                with wave.open(str(Path(directory)/f"{name}.wav")) as wav:
                    self.assertEqual(wav.getframerate(), RATE)
                    self.assertEqual(wav.getnframes(), RATE//5)
                    samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
                    self.assertTrue(np.all(samples[:RATE//10] == 0))
                    self.assertGreater(np.max(np.abs(samples)), 0)
            with self.assertRaises(FileExistsError):
                Recording(Path(directory))

    def test_rms_end_is_last_audible_sample_not_hangover_time(self):
        events = []
        activity = RMSActivity("caller", lambda *a: events.append(a))
        activity.feed(tone(), 100, 120)
        activity.feed(tone(), 120, 140)
        activity.feed(SILENCE, 140, 160)
        activity.advance(439)
        self.assertEqual(len(events), 1)
        activity.advance(440)
        self.assertEqual(events[-1], ("speech_ended", "caller", 100, 140))

    def test_watchdog_fires_without_reply_and_later_records_latency(self):
        events = []
        watchdog = ResponseWatchdog(10, lambda kind, **v: events.append({"type": kind, **v}))
        watchdog.speech("speech_ended", "caller", 0, 1000)
        watchdog.tick(10999)
        self.assertFalse(any(e["type"] == "finding" for e in events))
        watchdog.tick(11000)
        watchdog.tick(12000)
        findings = [e for e in events if e["type"] == "finding"]
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["startMs"], 1000)
        # Repeated caller prompts must not postpone an already missed deadline.
        watchdog.speech("speech_ended", "caller", 11500, 12000)
        watchdog.speech("speech_started", "agent", 13000, 13000)
        self.assertEqual(events[-1]["value"], 12000)
        self.assertTrue(events[-1]["priorTimeout"])

    def test_null_timeout_disables_findings_but_preserves_latency_evidence(self):
        events = []
        watchdog = ResponseWatchdog(None, lambda kind, **v: events.append({"type": kind, **v}))
        watchdog.speech("speech_ended", "caller", 0, 1000)
        watchdog.tick(999999)
        watchdog.speech("speech_started", "agent", 1000000, 1000000)
        self.assertFalse(any(e["type"] == "finding" for e in events))
        self.assertEqual(events[-1]["value"], 999000)
        self.assertFalse(events[-1]["exceedsThreshold"])

    def test_agent_onset_during_hangover_is_not_missed(self):
        events = []
        watchdog = ResponseWatchdog(10, lambda kind, **v: events.append({"type": kind, **v}))
        watchdog.speech("speech_started", "agent", 1100, 1100)
        watchdog.speech("speech_ended", "caller", 0, 1000)
        self.assertEqual(events[-1]["type"], "metric")
        self.assertEqual(events[-1]["value"], 100)
        watchdog.tick(12000)
        self.assertFalse(any(e["type"] == "finding" for e in events))

    def test_base_url_and_credentials_are_not_exposed(self):
        self.assertEqual(api_base("https://example.test/api/v1/"), "https://example.test/api/v1")
        self.assertIn("/api/v1/ws/signaling/2/3?api_key=a%2Bb", signaling_url("https://example.test", 2, 3, "a+b"))
        self.assertEqual(api_base("https://example.test/workflow"), "https://example.test/api/v1")
        self.assertEqual(api_base("https://example.test/backend/api/v1"), "https://example.test/backend/api/v1")
        with self.assertRaises(ValueError):
            api_base("https://username:password@example.test")
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            event = Events(Path(directory), 1, Clock(), ["secret/+"], output)
            event.emit("error", message="secret/+ and secret%2F%2B", nested={"api_key": "other"})
            event.close()
            self.assertNotIn("secret", output.getvalue())
            self.assertNotIn("api_key", output.getvalue())

    def test_selected_auth_uses_exactly_one_query_and_one_http_header(self):
        for mode, credential, query, headers in (
                ("apiKey", "key/+?", "api_key", {"X-API-Key": "key/+?"}),
                ("token", "session/+?", "token", {"Authorization": "Bearer session/+?"})):
            with self.subTest(mode=mode):
                url = signaling_url("https://dograh.test/backend/api/v1", 2, 3, f" {credential} ", mode)
                self.assertEqual(parse_qs(urlsplit(url).query), {query: [credential]})
                self.assertEqual(dograh_headers(f" {credential} ", mode), headers)
                response = Mock()
                response.read.return_value = b'{"uris": [], "username": "turn-user", "password": "turn-secret"}'
                opener = Mock()
                opener.open.return_value.__enter__ = Mock(return_value=response)
                opener.open.return_value.__exit__ = Mock(return_value=False)
                with patch("audio_worker.worker.build_opener", return_value=opener):
                    result = fetch_turn("https://dograh.test/backend/api/v1", credential, mode)
                request = opener.open.call_args.args[0]
                self.assertEqual(request.full_url, "https://dograh.test/backend/api/v1/turn/credentials")
                self.assertEqual({key.lower(): value for key, value in request.header_items()},
                                 {key.lower(): value for key, value in headers.items()})
                self.assertEqual(result["username"], "turn-user")

    def test_invalid_auth_fails_before_creating_evidence(self):
        invalid = [
            {"dograhAuthMode": "invalid", "dograhApiKey": "key"},
            {"dograhAuthMode": "loginToken", "dograhLoginToken": "session"},
            {"dograhAuthMode": None, "dograhApiKey": "key"},
            {"dograhAuthMode": ["apiKey"], "dograhApiKey": "key"},
            {"dograhAuthMode": "token", "dograhApiKey": "unused-key"},
            {"dograhLoginToken": "unused-token"},
            {"dograhAuthMode": "token", "dograhLoginToken": " "},
            {"dograhAuthMode": "token", "dograhLoginToken": "Bearer session"},
            {"dograhAuthMode": "token", "dograhLoginToken": "session\r\nInjected:header"},
            {"dograhApiKey": "key\tpart"},
            {"dograhApiKey": "key part"},
            {"dograhApiKey": "key\x00part"},
            {"dograhApiKey": "日本語"},
        ]
        for auth in invalid:
            with self.subTest(auth_mode=auth.get("dograhAuthMode", "default")), tempfile.TemporaryDirectory() as directory:
                output_dir = Path(directory)/"not-created"
                config = {"dograhBaseUrl": "https://dograh.test", "workflowId": 1, "runId": 2,
                          "openaiApiKey": "openai-test", "instructions": "test caller",
                          "outputDir": str(output_dir), **auth}
                with self.assertRaises(ValueError):
                    Worker(config, event_stream=io.StringIO())
                self.assertFalse(output_dir.exists())

    def test_token_fields_and_raw_encoded_credential_variants_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            token, inactive_key = "session/+?secret", "inactive/+?key"
            raw = f" {token} "
            events = Events(Path(directory), 1, Clock(), [raw, inactive_key], output)
            events.emit("error", message=f"{token} {quote(token, safe='')} {quote(raw, safe='')} {quote_plus(raw, safe='')} {inactive_key}",
                        payload={"dograhLoginToken": "other-value", "token": "different", "access_token": "third", "refreshToken": "fourth", "safe": "retained"})
            events.close()
            saved = (Path(directory)/"events.jsonl").read_text()
            self.assertEqual(saved, output.getvalue())
            for credential in (token, inactive_key, quote(token, safe=""), quote(raw, safe=""), quote_plus(raw, safe="")):
                self.assertNotIn(credential, saved)
            self.assertEqual(json.loads(saved)["payload"], {"safe": "retained"})


class FakeSocket:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return json.dumps(item)

    async def close(self):
        self.closed = True
        await self.queue.put(None)


class FakeLive(FakeSocket):
    def __init__(self):
        super().__init__()
        self.frames = 0
        self.heard_agent = False
        self.started_payload = None

    async def send(self, raw):
        event = json.loads(raw)
        if event["type"] == "session.start":
            self.started_payload = event
            await self.queue.put({"type": "session.started", "session": {"id": "live_test"}})
        elif event["type"] == "session.input_audio.append":
            self.frames += 1
            pcm = base64.b64decode(event["audio"])
            self.heard_agent |= bool(np.any(np.abs(np.frombuffer(pcm, dtype="<i2")) > 500))
            if self.frames <= 25:
                await self.queue.put({"type": "session.output_audio.delta", "delta": base64.b64encode(tone()).decode()})
            if self.frames == 1:
                await self.queue.put({"type": "session.output_transcript.delta", "delta": "渋谷駅までお願いします。", "start_ms": 0, "end_ms": 500})
        elif event["type"] == "session.close":
            await self.queue.put({"type": "session.closed", "usage": {"seconds": 2}, "reason": "close_requested"})


class AgentToneTrack(AudioStreamTrack):
    def __init__(self):
        super().__init__()
        self.frame_count = 0

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        await asyncio.sleep(0.02)
        self.frame_count += 1
        pcm = tone() if 58 <= self.frame_count <= 70 else SILENCE
        frame = av.AudioFrame.from_ndarray(np.frombuffer(pcm, dtype="<i2").reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate, frame.pts, frame.time_base = RATE, (self.frame_count-1)*FRAME_SAMPLES, Fraction(1, RATE)
        return frame


class FakeSignaling(FakeSocket):
    def __init__(self):
        super().__init__()
        self.peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.peer.addTrack(AgentToneTrack())
        self.heard_caller = False
        self.readers = []

        @self.peer.on("track")
        def track_received(track):
            async def consume():
                try:
                    while True:
                        frame = await track.recv()
                        self.heard_caller |= bool(np.any(np.abs(frame.to_ndarray().astype(np.int32)) > 500))
                except MediaStreamError:
                    pass
            self.readers.append(asyncio.create_task(consume()))

    async def send(self, raw):
        event = json.loads(raw)
        if event["type"] == "offer":
            payload = event["payload"]
            assert payload["pc_id"]
            await self.peer.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"], type="offer"))
            await self.peer.setLocalDescription(await self.peer.createAnswer())
            await self.queue.put({"type": "answer", "payload": {"sdp": self.peer.localDescription.sdp, "type": "answer", "pc_id": payload["pc_id"]}})

    async def close(self):
        await super().close()
        await self.peer.close()
        for reader in self.readers:
            reader.cancel()
        await asyncio.gather(*self.readers, return_exceptions=True)


class WorkerIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejected_handshakes_identify_provider_and_http_status_without_leaking(self):
        for provider, status in (("openai", 401), ("dograh", 403)):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as directory:
                output = io.StringIO()
                worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhAuthMode": "token", "dograhLoginToken": "dograh-test-secret",
                                 "workflowId": 2, "runId": 3, "openaiApiKey": "openai-test-secret",
                                 "instructions": "caller", "outputDir": directory}, event_stream=output)
                attempts = []
                async def rejected(url, **kwargs):
                    attempts.append(url)
                    if provider == "dograh" and "api.openai.com" in url:
                        return FakeLive()
                    response = Response(status, "secret-reason", Headers({"authorization": "unknown-secret-header"}),
                                        body=json.dumps({"error": {"code": "invalid_api_key", "message": "unknown-secret-body"}}).encode())
                    raise InvalidStatus(response)
                with patch("audio_worker.worker.connect", side_effect=rejected), patch("audio_worker.worker.fetch_turn", return_value=None):
                    await worker.run()
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                failure = next(event for event in events if event["type"] == "error")
                self.assertEqual(failure["provider"], provider)
                self.assertEqual(failure["httpStatus"], status)
                self.assertEqual(failure["stage"], "websocket_handshake")
                self.assertIn(f"HTTP {status}", failure["message"])
                self.assertEqual(events[-1]["reason"], failure["code"])
                self.assertEqual(len(attempts), 1 if provider == "openai" else 2, "Do not automatically retry auth failures")
                if provider == "openai":
                    self.assertIsNone(events[-1]["sessionId"])
                    self.assertFalse(any(event["type"] == "provider_session" for event in events))
                else:
                    self.assertTrue(any(event["type"] == "transport_state" and event["state"] == "closed" for event in events),
                                    "Peer close must be recorded before the event file is closed")
                self.assertNotIn("secret", output.getvalue())
                self.assertEqual((Path(directory)/"events.jsonl").read_text(), output.getvalue())

    async def test_transcripts_keep_original_text_and_mark_stop_or_cleanup(self):
        for state in ("active", "stop", "closing"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                output = io.StringIO()
                worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "dograh-test",
                                 "workflowId": 2, "runId": 3, "openaiApiKey": "openai-test",
                                 "instructions": "caller", "outputDir": directory}, event_stream=output)
                worker.live = FakeLive()
                if state == "stop":
                    worker.request_stop("cancelled")
                elif state == "closing":
                    worker.closing = True
                for direction, text in (("output", "二箱お願いします。"), ("input", "一箱ですね。")):
                    await worker.live.queue.put({"type": f"session.{direction}_transcript.delta", "delta": text})
                await worker.live.queue.put({"type": "session.closed", "usage": {"seconds": 0}})
                await worker.receive_live()
                await worker.cleanup()
                worker.events.close()
                transcripts = [json.loads(line) for line in output.getvalue().splitlines()
                               if json.loads(line)["type"] == "transcript"]
                self.assertEqual([event["text"] for event in transcripts], ["二箱お願いします。", "一箱ですね。"])
                self.assertEqual([event["speaker"] for event in transcripts], ["caller", "agent"])
                self.assertEqual([event["transcriptOrigin"] for event in transcripts],
                                 ["model_output", "input_audio_transcription"])
                self.assertTrue(all(event["audioVerified"] is False for event in transcripts))
                self.assertTrue(all(event["afterStop"] == (state != "active") for event in transcripts))
                self.assertEqual((Path(directory)/"events.jsonl").read_text(), output.getvalue())

    async def test_delivery_counts_partial_frames_queued_audio_and_late_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "dograh-test",
                             "workflowId": 2, "runId": 3, "openaiApiKey": "openai-test",
                             "instructions": "caller", "outputDir": directory}, event_stream=output)
            track = CallerTrack(worker)
            def audio_event(samples):
                return json.dumps({"type": "session.output_audio.delta", "delta": base64.b64encode(tone(samples)).decode()})
            async def scripted_live():
                yield audio_event(517)
                await track.recv()
                await track.recv()  # Consumes 37 source samples and pads the frame.
                yield audio_event(733)
                await track.recv()  # Leaves 253 source samples queued.
                worker.request_stop("cancelled")
                yield audio_event(47)  # Ignored immediately after stop, before cleanup.
                worker.closing = True
                yield audio_event(31)
                yield json.dumps({"type": "session.closed", "usage": {"seconds": 0}})
            worker.live = scripted_live()
            await worker.receive_live()
            worker.live = None
            await worker.cleanup()
            worker.events.close()
            track.stop()
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            delivery = next(event for event in events if event.get("code") == "caller_audio_delivery")
            self.assertEqual(delivery["generatedSamples"], 1328)
            self.assertEqual(delivery["sentSamples"], 997)
            self.assertEqual(delivery["unsentSamples"], 331)
            self.assertEqual(delivery["ignoredSamples"], 78)
            self.assertEqual(delivery["cutoffReason"], "cancelled")
            self.assertEqual(len(worker.caller_queue.buffer)//2, 253)
            self.assertEqual(sum(event.get("code") == "caller_audio_delivery" for event in events), 1)

    async def test_queue_rejected_audio_is_counted_as_unsent_and_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "dograh-test",
                             "workflowId": 2, "runId": 3, "openaiApiKey": "openai-test",
                             "instructions": "caller", "outputDir": directory}, event_stream=output)
            worker.caller_queue.limit = 4
            worker.live = FakeLive()
            for samples in (2, 1):
                await worker.live.queue.put({"type": "session.output_audio.delta",
                                             "delta": base64.b64encode(tone(samples)).decode()})
            with self.assertRaises(BufferError):
                await worker.receive_live()
            worker.request_stop("live_receiver_failed")
            await worker.cleanup()
            worker.events.close()
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            delivery = next(event for event in events if event.get("code") == "caller_audio_delivery")
            self.assertEqual((delivery["generatedSamples"], delivery["sentSamples"],
                              delivery["unsentSamples"], delivery["ignoredSamples"]), (3, 0, 3, 1))

    async def test_token_stdin_contract_with_real_rtp_and_real_turn_request_construction(self):
        with tempfile.TemporaryDirectory() as directory:
            live, signaling = FakeLive(), FakeSignaling()
            output = io.StringIO()
            token = "test-session/+?value"
            config = {"dograhBaseUrl": "https://dograh.test/backend/api/v1", "dograhAuthMode": "token",
                      "dograhLoginToken": f" {token} ", "workflowId": 2, "runId": 3,
                      "openaiApiKey": "openai-test", "instructions": "日本語のテスト乗客",
                      "maxDurationSeconds": 2, "responseTimeoutSeconds": None,
                      "outputDir": directory}
            connection_urls = []
            turn_requests = []
            async def fake_connect(url, **kwargs):
                connection_urls.append(url)
                if "api.openai.com" in url:
                    self.assertEqual(kwargs["additional_headers"], {"Authorization": "Bearer openai-test"})
                    return live
                # A provider echo must not leak its query credentials to stdout/disk.
                await signaling.queue.put({"type": "auth-diagnostic", "payload": {"url": url, "token": token}})
                return signaling
            response = Mock()
            response.read.return_value = b'{"uris": ["turn:127.0.0.1:3478"], "username": "test", "password": "turn-test"}'
            def fake_open(request, **kwargs):
                turn_requests.append(request)
                context = Mock()
                context.__enter__ = Mock(return_value=response)
                context.__exit__ = Mock(return_value=False)
                return context
            opener = Mock(); opener.open.side_effect = fake_open
            read_fd, write_fd = os.pipe()
            # Exercise the same JSON-line stdin entrypoint as the Node runner.
            # Keep the writer open so EOF does not cancel the session early.
            with os.fdopen(read_fd, "rb", buffering=0) as input_stream, \
                    os.fdopen(write_fd, "wb", buffering=0) as input_writer, \
                    patch("audio_worker.worker.sys.stdin", input_stream), \
                    patch("audio_worker.worker.sys.stdout", output), \
                    patch("audio_worker.worker.logging.disable"), \
                    patch.object(asyncio.get_running_loop(), "add_signal_handler"), \
                    patch("audio_worker.worker.connect", fake_connect), \
                    patch("audio_worker.worker.build_opener", return_value=opener), \
                    patch("audio_worker.worker.RTCConfiguration", lambda **kwargs: RTCConfiguration(iceServers=[])):
                input_writer.write((json.dumps(config) + "\n").encode())
                self.assertEqual(await asyncio.wait_for(main(), 8), 0)
            self.assertTrue(signaling.heard_caller)
            self.assertTrue(live.heard_agent)
            self.assertEqual(parse_qs(urlsplit(connection_urls[1]).query), {"token": [token]})
            self.assertEqual(len(turn_requests), 1)
            self.assertEqual({k.lower(): v for k, v in turn_requests[0].header_items()}, {"authorization": f"Bearer {token}"})
            self.assertNotIn(token, output.getvalue())
            self.assertNotIn(quote(token, safe=""), output.getvalue())
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(any(event["type"] == "error" for event in events))
            self.assertTrue(events[-1]["finalUsageConfirmed"])
            self.assertEqual((Path(directory)/"events.jsonl").read_text(), output.getvalue())

    async def test_connection_time_uses_total_duration_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "dograh-test",
                             "workflowId": 2, "runId": 3, "openaiApiKey": "openai-test", "instructions": "caller",
                             "maxDurationSeconds": 1, "responseTimeoutSeconds": None,
                             "outputDir": directory}, event_stream=output)
            async def blocked_connect(*args, **kwargs):
                await asyncio.Future()
            with patch("audio_worker.worker.connect", blocked_connect):
                await asyncio.wait_for(worker.run(), 1.5)
            self.assertEqual(worker.reason, "connection_budget_exhausted")
            self.assertLess(worker.stop_at_ms, 1200)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(any(e["type"] == "finding" for e in events))
            self.assertTrue(any(e.get("code") == "connection_budget_exhausted" for e in events))

    async def test_finalization_wait_does_not_create_a_cancelled_call_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "dograh-test",
                             "workflowId": 2, "runId": 3, "openaiApiKey": "openai-test", "instructions": "caller",
                             "responseTimeoutSeconds": 2, "outputDir": directory}, event_stream=output)
            with patch.object(worker.clock, "ms", return_value=1000):
                worker.watchdog.speech("speech_ended", "caller", 0, 100)
                worker.request_stop("cancelled")
            with patch.object(worker.clock, "ms", return_value=5000):
                await worker.cleanup()
            worker.events.close()
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(any(e["type"] == "finding" for e in events))
            artifact = next(e for e in events if e["type"] == "artifacts")
            self.assertEqual(artifact["durationMs"], 1000)

    async def test_real_rtp_loopback_with_fake_live_and_dograh_signaling(self):
        with tempfile.TemporaryDirectory() as directory:
            live, signaling = FakeLive(), FakeSignaling()
            output = io.StringIO()
            config = {"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "dograh-secret",
                      "workflowId": 2, "runId": 3, "openaiApiKey": "openai-secret",
                      "instructions": "日本語のテスト乗客", "maxDurationSeconds": 2,
                      "responseTimeoutSeconds": 0.1, "outputDir": directory}
            worker = Worker(config, event_stream=output)

            async def fake_connect(url, **kwargs):
                return live if "api.openai.com" in url else signaling

            # Remove STUN only in this test, so all traffic stays on loopback.
            with patch("audio_worker.worker.connect", fake_connect), \
                    patch("audio_worker.worker.fetch_turn", return_value=None), \
                    patch("audio_worker.worker.RTCConfiguration", lambda **kwargs: RTCConfiguration(iceServers=[])):
                await asyncio.wait_for(worker.run(), 8)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertTrue(signaling.heard_caller, "WebRTC peer must receive real caller RTP")
            self.assertTrue(live.heard_agent, "Live must receive resampled agent PCM")
            self.assertEqual(live.started_payload["session"]["model"], "gpt-live-1")
            self.assertEqual(worker.reason, "max_duration")
            self.assertTrue(events[-1]["finalUsageConfirmed"])
            self.assertTrue(any(e["type"] == "finding" for e in events))
            self.assertTrue(any(e["type"] == "metric" and e["priorTimeout"] for e in events))
            self.assertNotIn("dograh-secret", output.getvalue())
            self.assertNotIn("openai-secret", output.getvalue())
            for name in ("caller.wav", "agent.wav", "mixed.wav", "events.jsonl"):
                self.assertGreater((Path(directory)/name).stat().st_size, 44)

    async def test_stop_cancels_inflight_startup_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            worker = Worker({"dograhBaseUrl": "http://test.invalid", "dograhApiKey": "d",
                             "workflowId": 2, "runId": 3, "openaiApiKey": "o", "instructions": "caller",
                             "outputDir": directory}, event_stream=output)

            async def blocked_connect(*args, **kwargs):
                await asyncio.Future()

            with patch("audio_worker.worker.connect", blocked_connect):
                task = asyncio.create_task(worker.run())
                await asyncio.sleep(0.02)
                worker.request_stop("cancelled")
                await asyncio.wait_for(task, 1)
            self.assertEqual(worker.reason, "cancelled")
            self.assertTrue((Path(directory)/"mixed.wav").exists())


if __name__ == "__main__":
    unittest.main()

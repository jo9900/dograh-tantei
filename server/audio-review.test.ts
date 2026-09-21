import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioReviewError, transcribeRecording } from './audio-review.js';

const KEY = 'sk-offline-audio-review-secret';
const directories: string[] = [];

function wav(seconds = 1, seed = 300): Buffer {
  const frames = Math.round(seconds * 24_000);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(((i + seed) % 20_000) - 10_000, 44 + i * 2);
  return bytes;
}

async function fixture(caller = wav(), agent = wav(1, 1800)): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'tantei-audio-review-test-'));
  directories.push(directory);
  await Promise.all([
    writeFile(path.join(directory, 'caller.wav'), caller),
    writeFile(path.join(directory, 'agent.wav'), agent),
  ]);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('independent saved-audio transcription', () => {
  it('sends separate track WAVs without expected answers, records exact upload hashes, and preserves originals', async () => {
    const caller = wav(1, 500),
      agent = wav(0.5, 900);
    const directory = await fixture(caller, agent);
    const uploads: Buffer[] = [];
    const filenames: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${KEY}`);
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const form = init?.body as FormData;
      expect([...form.keys()].sort()).toEqual(['file', 'language', 'model', 'response_format']);
      expect(form.get('model')).toBe('gpt-4o-transcribe');
      expect(form.get('language')).toBe('ja');
      expect(form.get('response_format')).toBe('json');
      const file = form.get('file') as File;
      expect(file.type).toBe('audio/wav');
      filenames.push(file.name);
      uploads.push(Buffer.from(await file.arrayBuffer()));
      return Response.json({
        text: file.name.startsWith('caller') ? ' 一箱お願いします。 ' : '一箱で承ります。',
      });
    });
    const result = await transcribeRecording({
      directory,
      apiKey: KEY,
      language: 'ja-JP',
      fetchImpl,
    });
    expect(filenames).toEqual(['caller-1.wav', 'agent-1.wav']);
    expect(uploads[0].equals(caller)).toBe(true);
    expect(uploads[1].equals(agent)).toBe(true);
    expect(result.chunks).toEqual([
      {
        id: 'audio:caller:1',
        track: 'caller',
        startMs: 0,
        endMs: 1000,
        text: '一箱お願いします。',
        audioSha256: createHash('sha256').update(caller).digest('hex'),
      },
      {
        id: 'audio:agent:1',
        track: 'agent',
        startMs: 0,
        endMs: 500,
        text: '一箱で承ります。',
        audioSha256: createHash('sha256').update(agent).digest('hex'),
      },
    ]);
    expect(result.model).toBe('gpt-4o-transcribe');
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
    expect(result.limitations.join(' ')).toContain('不是逐字');
    expect((await readFile(path.join(directory, 'caller.wav'))).equals(caller)).toBe(true);
    expect((await readFile(path.join(directory, 'agent.wav'))).equals(agent)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('uses 60-second chunks with 2-second overlap, correct sample boundaries, and one request at a time', async () => {
    const caller = wav(120.125),
      agent = wav(60);
    const directory = await fixture(caller, agent);
    const uploaded: Array<{ name: string; bytes: Buffer }> = [];
    let active = 0,
      maximumActive = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      const file = (init?.body as FormData).get('file') as File;
      uploaded.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return Response.json({ text: '片段' });
    });
    const result = await transcribeRecording({
      directory,
      apiKey: KEY,
      language: 'JA_jp',
      fetchImpl,
    });
    expect(maximumActive).toBe(1);
    expect(result.chunks.map((chunk) => [chunk.id, chunk.startMs, chunk.endMs])).toEqual([
      ['audio:caller:1', 0, 60_000],
      ['audio:caller:2', 58_000, 118_000],
      ['audio:caller:3', 116_000, 120_125],
      ['audio:agent:1', 0, 60_000],
    ]);
    for (let i = 0; i < uploaded.length; i++) {
      const { bytes } = uploaded[i],
        chunk = result.chunks[i];
      const original = chunk.track === 'caller' ? caller : agent;
      expect(bytes.length).toBeLessThan(25_000_000);
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
      expect(
        bytes
          .subarray(44)
          .equals(original.subarray(44 + chunk.startMs * 48, 44 + chunk.endMs * 48)),
      ).toBe(true);
      expect(chunk.audioSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('keeps empty transcription text as a recorded chunk rather than inventing speech', async () => {
    const directory = await fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ text: '' }));
    const result = await transcribeRecording({ directory, apiKey: KEY, language: 'en', fetchImpl });
    expect(result.chunks).toHaveLength(2);
    expect(
      result.chunks.every((chunk) => chunk.text === '' && chunk.audioSha256.length === 64),
    ).toBe(true);
  });

  it('parses padded metadata chunks and uploads only normalized format and PCM data', async () => {
    const original = wav();
    const metadata = Buffer.from([74, 85, 78, 75, 3, 0, 0, 0, 42, 43, 44, 0]);
    const withMetadata = Buffer.concat([original.subarray(0, 12), metadata, original.subarray(12)]);
    withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
    const directory = await fixture(withMetadata, original);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const file = (init?.body as FormData).get('file') as File;
      expect(Buffer.from(await file.arrayBuffer()).equals(original)).toBe(true);
      return Response.json({ text: '' });
    });
    await transcribeRecording({ directory, apiKey: KEY, language: 'ja', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['not RIFF', (bytes: Buffer) => bytes.write('NOPE', 0)],
    ['wrong RIFF length', (bytes: Buffer) => bytes.writeUInt32LE(80, 4)],
    ['not WAVE', (bytes: Buffer) => bytes.write('NOPE', 8)],
    ['missing format', (bytes: Buffer) => bytes.write('JUNK', 12)],
    ['non-PCM', (bytes: Buffer) => bytes.writeUInt16LE(3, 20)],
    ['stereo', (bytes: Buffer) => bytes.writeUInt16LE(2, 22)],
    ['wrong sample rate', (bytes: Buffer) => bytes.writeUInt32LE(48_000, 24)],
    ['wrong byte rate', (bytes: Buffer) => bytes.writeUInt32LE(42, 28)],
    ['wrong block alignment', (bytes: Buffer) => bytes.writeUInt16LE(4, 32)],
    ['wrong sample size', (bytes: Buffer) => bytes.writeUInt16LE(8, 34)],
    ['missing data', (bytes: Buffer) => bytes.write('JUNK', 36)],
    ['truncated data', (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, 40)],
    ['partial sample', (bytes: Buffer) => bytes.writeUInt32LE(bytes.length - 45, 40)],
  ])('rejects %s in the second track before any paid request', async (_name, mutate) => {
    const invalid = wav();
    (mutate as (bytes: Buffer) => unknown)(invalid);
    const directory = await fixture(wav(), invalid);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      transcribeRecording({ directory, apiKey: KEY, language: 'ja', fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_WAV' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects duplicate data chunks and overlong audio before requesting transcription', async () => {
    const valid = wav();
    const repeated = Buffer.concat([valid, valid.subarray(36)]);
    repeated.writeUInt32LE(repeated.length - 8, 4);
    const directory = await fixture(repeated);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      transcribeRecording({ directory, apiKey: KEY, language: 'ja', fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_WAV' });
    await writeFile(path.join(directory, 'caller.wav'), wav(905 + 1 / 24_000));
    await expect(
      transcribeRecording({ directory, apiKey: KEY, language: 'ja', fetchImpl }),
    ).rejects.toMatchObject({ code: 'AUDIO_TOO_LONG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not follow a track symlink or return a filesystem path in an error', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tantei-audio-review-test-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'original.wav'), wav());
    await symlink(path.join(directory, 'original.wav'), path.join(directory, 'caller.wav'));
    const fetchImpl = vi.fn<typeof fetch>();
    const error = await transcribeRecording({
      directory,
      apiKey: KEY,
      language: 'ja',
      fetchImpl,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(AudioReviewError);
    expect(error.code).toBe('WAV_READ_FAILED');
    expect(error.message).not.toContain(directory);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])(
    'does not retry HTTP %s, follow redirects, or expose the provider error',
    async (status) => {
      const directory = await fixture();
      const response = new Response(JSON.stringify({ error: `provider echoes ${KEY}` }), {
        status,
        headers: { Location: 'https://untrusted.example/upload' },
      });
      const readBody = vi.spyOn(response, 'json');
      const fetchImpl = vi.fn<typeof fetch>(async () => response);
      const error = await transcribeRecording({
        directory,
        apiKey: KEY,
        language: 'ja',
        fetchImpl,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(AudioReviewError);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('provider echoes');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(readBody).not.toHaveBeenCalled();
    },
  );

  it('sanitizes native network errors and malformed response bodies', async () => {
    const directory = await fixture();
    for (const fetchImpl of [
      vi.fn<typeof fetch>(async () => {
        throw new Error(`Authorization: Bearer ${KEY}`);
      }),
      vi.fn<typeof fetch>(async () => new Response(`not JSON ${KEY}`)),
      vi.fn<typeof fetch>(async () => Response.json({ error: KEY })),
    ]) {
      const error = await transcribeRecording({
        directory,
        apiKey: KEY,
        language: 'ja',
        fetchImpl,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(AudioReviewError);
      expect(error.message).not.toContain(KEY);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects missing or injected keys and invalid language without filesystem or network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const apiKey of ['', '   ', `${KEY}\r\nInjected: value`, `Bearer ${KEY}`]) {
      await expect(
        transcribeRecording({ directory: '/does-not-exist', apiKey, language: 'ja', fetchImpl }),
      ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    }
    await expect(
      transcribeRecording({
        directory: '/does-not-exist',
        apiKey: KEY,
        language: 'Japanese',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LANGUAGE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles cancellation before reading or while sending without exposing abort reasons', async () => {
    const controller = new AbortController();
    controller.abort(new Error(KEY));
    const unused = vi.fn<typeof fetch>();
    await expect(
      transcribeRecording({
        directory: '/does-not-exist',
        apiKey: KEY,
        language: 'ja',
        fetchImpl: unused,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(unused).not.toHaveBeenCalled();
    const directory = await fixture();
    const running = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      running.abort(new Error(KEY));
      expect(init?.signal?.aborted).toBe(true);
      throw new Error(KEY);
    });
    const error = await transcribeRecording({
      directory,
      apiKey: KEY,
      language: 'ja',
      fetchImpl,
      signal: running.signal,
    }).catch((error) => error);
    expect(error.code).toBe('ABORTED');
    expect(error.message).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sets a 60-second timeout for each chunk and stops after the first timed-out request', async () => {
    const directory = await fixture();
    const timeout = new AbortController();
    const timedSignal = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      timeout.abort(new Error(KEY));
      expect(init?.signal?.aborted).toBe(true);
      throw new Error(KEY);
    });
    const error = await transcribeRecording({
      directory,
      apiKey: KEY,
      language: 'ja',
      fetchImpl,
    }).catch((error) => error);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).not.toContain(KEY);
    expect(timedSignal).toHaveBeenCalledWith(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcribeRecording, type AudioReviewResult } from './audio-review.js';
import { AudioReviewCacheError, verifyCachedAudioReview } from './audio-review-cache.js';

const directories: string[] = [];

function wav(seconds = 1, seed = 300): Buffer {
  const samples = Math.round(seconds * 24_000);
  const bytes = Buffer.alloc(44 + samples * 2);
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
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(((i + seed) % 20_000) - 10_000, 44 + i * 2);
  return bytes;
}

async function fixture(caller = wav(), agent = wav(1, 1800)) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tantei-audio-cache-test-'));
  directories.push(directory);
  await Promise.all([
    writeFile(path.join(directory, 'caller.wav'), caller),
    writeFile(path.join(directory, 'agent.wav'), agent),
  ]);
  // Obtain the real producer's format, using only a local stub and synthetic audio.
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ text: '合成录音测试' }));
  const result = await transcribeRecording({
    directory,
    apiKey: 'sk-test-local-only',
    language: 'ja',
    fetchImpl,
  });
  return { directory, result, caller, agent };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network is forbidden in cache verification tests');
    }),
  );
});

afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('local independent audio review cache verification', () => {
  it('reuses the legacy producer format with exact chunk hashes, overlap, and fractional sample boundaries', async () => {
    const { directory, result, caller, agent } = await fixture(
      wav(120 + 1 / 24_000),
      wav(60, 1800),
    );
    const original = structuredClone(result);
    const verified = await verifyCachedAudioReview(directory, result);
    expect(verified).toEqual(original);
    expect(verified).not.toBe(result);
    expect(verified.chunks.map((chunk) => [chunk.id, chunk.startMs, chunk.endMs])).toEqual([
      ['audio:caller:1', 0, 60_000],
      ['audio:caller:2', 58_000, 118_000],
      ['audio:caller:3', 116_000, ((120 * 24_000 + 1) * 1000) / 24_000],
      ['audio:agent:1', 0, 60_000],
    ]);
    expect((await readFile(path.join(directory, 'caller.wav'))).equals(caller)).toBe(true);
    expect((await readFile(path.join(directory, 'agent.wav'))).equals(agent)).toBe(true);
    expect(result).toEqual(original);
  });

  it('preserves empty transcription text and reconstructs normalized WAV from padded metadata', async () => {
    const plain = wav();
    const metadata = Buffer.from([74, 85, 78, 75, 3, 0, 0, 0, 42, 43, 44, 0]);
    const withMetadata = Buffer.concat([plain.subarray(0, 12), metadata, plain.subarray(12)]);
    withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
    const { directory, result } = await fixture(withMetadata);
    result.chunks[0].text = '';
    expect((await verifyCachedAudioReview(directory, result)).chunks[0].text).toBe('');
  });

  it.each([
    [
      'wrong track',
      (result: AudioReviewResult) => {
        result.chunks[0].track = 'agent';
      },
    ],
    [
      'wrong hash',
      (result: AudioReviewResult) => {
        result.chunks[0].audioSha256 = '0'.repeat(64);
      },
    ],
    [
      'wrong ID',
      (result: AudioReviewResult) => {
        result.chunks[0].id = 'audio:caller:2';
      },
    ],
    [
      'wrong start',
      (result: AudioReviewResult) => {
        result.chunks[1].startMs = 60_000;
      },
    ],
    [
      'wrong end',
      (result: AudioReviewResult) => {
        result.chunks[0].endMs = 59_000;
      },
    ],
    [
      'missing tail',
      (result: AudioReviewResult) => {
        result.chunks.splice(1, 1);
      },
    ],
    [
      'missing agent',
      (result: AudioReviewResult) => {
        result.chunks = result.chunks.filter((chunk) => chunk.track === 'caller');
      },
    ],
    [
      'duplicate chunk',
      (result: AudioReviewResult) => {
        result.chunks.push({ ...result.chunks[0] });
      },
    ],
    [
      'wrong order',
      (result: AudioReviewResult) => {
        result.chunks.reverse();
      },
    ],
  ])('rejects %s instead of reusing incomplete or mismatched evidence', async (_label, mutate) => {
    const { directory, result } = await fixture(wav(61));
    mutate(result);
    await expect(verifyCachedAudioReview(directory, result)).rejects.toMatchObject({
      code: 'CACHE_MISMATCH',
    });
  });

  it.each([
    undefined,
    null,
    {},
    { model: 'other-model' },
    { generatedAt: 'not-a-date' },
    { limitations: [14] },
    { chunks: [] },
  ])('rejects missing or malformed cache shape %j with a fixed message', async (override) => {
    const { directory, result } = await fixture();
    const value =
      override === undefined || override === null ? override : { ...result, ...override };
    // An empty object by itself is also malformed, rather than a valid override.
    const error = await verifyCachedAudioReview(
      directory,
      override && Object.keys(override).length === 0 ? override : value,
    ).catch((error) => error);
    expect(error).toBeInstanceOf(AudioReviewCacheError);
    expect(error.code).toBe('INVALID_CACHE');
    expect(error.message).toBe('独立录音复核缓存缺失或格式不正确，无法直接复用。');
  });

  it('rejects malformed, oversized, and nonfinite chunk fields', async () => {
    const { directory, result } = await fixture();
    for (const override of [
      { text: 42 },
      { text: 'x'.repeat(131_073) },
      { startMs: Number.NaN },
      { endMs: Infinity },
      { audioSha256: '../private' },
      { track: 'mixed' },
    ]) {
      const value = structuredClone(result);
      Object.assign(value.chunks[0], override);
      await expect(verifyCachedAudioReview(directory, value)).rejects.toMatchObject({
        code: 'INVALID_CACHE',
      });
    }
  });

  it('detects changed audio with the same length and otherwise unchanged cache', async () => {
    const { directory, result, agent } = await fixture();
    agent.writeInt16LE(42, 100);
    await writeFile(path.join(directory, 'agent.wav'), agent);
    await expect(verifyCachedAudioReview(directory, result)).rejects.toMatchObject({
      code: 'CACHE_MISMATCH',
    });
  });

  it.each(['truncated', 'stereo', 'bad length', 'no data'] as const)(
    'rejects %s WAV',
    async (kind) => {
      const { directory, result, caller } = await fixture();
      if (kind === 'stereo') caller.writeUInt16LE(2, 22);
      if (kind === 'bad length') caller.writeUInt32LE(100, 4);
      if (kind === 'no data') caller.write('JUNK', 36);
      await writeFile(
        path.join(directory, 'caller.wav'),
        kind === 'truncated' ? caller.subarray(0, -2) : caller,
      );
      await expect(verifyCachedAudioReview(directory, result)).rejects.toMatchObject({
        code: 'INVALID_WAV',
      });
    },
  );

  it('rejects a missing track without leaking filesystem paths', async () => {
    const { directory, result } = await fixture();
    await rm(path.join(directory, 'agent.wav'));
    const error = await verifyCachedAudioReview(directory, result).catch((error) => error);
    expect(error).toMatchObject({ code: 'WAV_READ_FAILED' });
    expect(error.message).not.toContain(directory);
  });

  it('does not follow track symlinks', async () => {
    const { directory, result, caller } = await fixture();
    await writeFile(path.join(directory, 'original.wav'), caller);
    await rm(path.join(directory, 'caller.wav'));
    await symlink(path.join(directory, 'original.wav'), path.join(directory, 'caller.wav'));
    await expect(verifyCachedAudioReview(directory, result)).rejects.toMatchObject({
      code: 'WAV_READ_FAILED',
    });
  });
});

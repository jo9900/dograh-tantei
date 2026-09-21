import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AudioReviewResult } from './audio-review.js';

// These parameters and the normalized WAV header match audio-review.ts exactly.
const SAMPLE_RATE = 24_000;
const MAX_SAMPLES = 905 * SAMPLE_RATE;
const CHUNK_SAMPLES = 60 * SAMPLE_RATE;
const STRIDE_SAMPLES = 58 * SAMPLE_RATE;
const MAX_FILE_BYTES = MAX_SAMPLES * 2 + 1024 * 1024;

const cacheSchema = z.object({
  model: z.literal('gpt-4o-transcribe'),
  generatedAt: z
    .string()
    .max(100)
    .refine((value) => Number.isFinite(Date.parse(value))),
  chunks: z
    .array(
      z.object({
        id: z.string().max(40),
        track: z.enum(['caller', 'agent']),
        startMs: z.number().finite().min(0).max(905_000),
        endMs: z.number().finite().positive().max(905_000),
        text: z.string().max(131_072),
        audioSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(2)
    .max(32),
  limitations: z.array(z.string().max(4096)).max(32),
});

type CacheErrorCode =
  'INVALID_CACHE' | 'WAV_READ_FAILED' | 'INVALID_WAV' | 'AUDIO_TOO_LONG' | 'CACHE_MISMATCH';

export class AudioReviewCacheError extends Error {
  constructor(
    readonly code: CacheErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AudioReviewCacheError';
  }
}

function invalidWav(): never {
  throw new AudioReviewCacheError(
    'INVALID_WAV',
    '缓存复核需要完整的 PCM16、单声道、24000 Hz RIFF WAV 录音。',
  );
}

function mismatch(): never {
  throw new AudioReviewCacheError(
    'CACHE_MISMATCH',
    '独立录音复核缓存与当前两条录音不一致或片段不完整，无法直接复用。',
  );
}

function parseWav(bytes: Buffer): Buffer {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    invalidWav();
  let formatSeen = false;
  let pcm: Buffer | undefined;
  let position = 12;
  let chunkCount = 0;
  while (position < bytes.length) {
    if (++chunkCount > 4096 || position + 8 > bytes.length) invalidWav();
    const kind = bytes.toString('ascii', position, position + 4);
    const length = bytes.readUInt32LE(position + 4);
    const start = position + 8;
    const end = start + length;
    const next = end + (length % 2);
    if (next > bytes.length) invalidWav();
    if (kind === 'fmt ') {
      if (formatSeen || (length !== 16 && length !== 18)) invalidWav();
      if (
        bytes.readUInt16LE(start) !== 1 ||
        bytes.readUInt16LE(start + 2) !== 1 ||
        bytes.readUInt32LE(start + 4) !== SAMPLE_RATE ||
        bytes.readUInt32LE(start + 8) !== SAMPLE_RATE * 2 ||
        bytes.readUInt16LE(start + 12) !== 2 ||
        bytes.readUInt16LE(start + 14) !== 16 ||
        (length === 18 && bytes.readUInt16LE(start + 16) !== 0)
      )
        invalidWav();
      formatSeen = true;
    } else if (kind === 'data') {
      if (!formatSeen || pcm || !length || length % 2) invalidWav();
      if (length / 2 > MAX_SAMPLES) {
        throw new AudioReviewCacheError(
          'AUDIO_TOO_LONG',
          '缓存复核仅接受不超过 905 秒的单条音轨。',
        );
      }
      pcm = bytes.subarray(start, end);
    }
    position = next;
  }
  if (!formatSeen || !pcm) invalidWav();
  return pcm;
}

async function readTrack(directory: string, track: 'caller' | 'agent'): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path.join(directory, `${track}.wav`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 44 || before.size > MAX_FILE_BYTES) invalidWav();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) invalidWav();
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) invalidWav();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      invalidWav();
    return parseWav(bytes);
  } catch (error) {
    if (error instanceof AudioReviewCacheError) throw error;
    throw new AudioReviewCacheError(
      'WAV_READ_FAILED',
      '无法读取 caller.wav 或 agent.wav，不能验证独立录音复核缓存。',
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

function wavChunk(pcm: Buffer): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

/** Verify saved ASR chunks against both current WAV tracks locally. Never calls a provider. */
export async function verifyCachedAudioReview(
  directory: string,
  value: unknown,
): Promise<AudioReviewResult> {
  const parsed = cacheSchema.safeParse(value);
  if (!parsed.success) {
    throw new AudioReviewCacheError(
      'INVALID_CACHE',
      '独立录音复核缓存缺失或格式不正确，无法直接复用。',
    );
  }
  const result = parsed.data;
  let position = 0;
  for (const track of ['caller', 'agent'] as const) {
    const pcm = await readTrack(directory, track);
    const samples = pcm.length / 2;
    for (let start = 0, index = 1; start < samples; start += STRIDE_SAMPLES, index++) {
      const end = Math.min(start + CHUNK_SAMPLES, samples);
      const chunk = result.chunks[position++];
      if (
        !chunk ||
        chunk.id !== `audio:${track}:${index}` ||
        chunk.track !== track ||
        chunk.startMs !== (start * 1000) / SAMPLE_RATE ||
        chunk.endMs !== (end * 1000) / SAMPLE_RATE
      )
        mismatch();
      const hash = createHash('sha256')
        .update(wavChunk(pcm.subarray(start * 2, end * 2)))
        .digest('hex');
      if (chunk.audioSha256 !== hash) mismatch();
      if (end === samples) break;
    }
  }
  if (position !== result.chunks.length) mismatch();
  return result;
}

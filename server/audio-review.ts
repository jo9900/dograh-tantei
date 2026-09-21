import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MODEL = 'gpt-4o-transcribe';
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
const MAX_SAMPLES = 905 * SAMPLE_RATE;
const CHUNK_SAMPLES = 60 * SAMPLE_RATE;
const STRIDE_SAMPLES = 58 * SAMPLE_RATE;
const MAX_FILE_BYTES = MAX_SAMPLES * BYTES_PER_SAMPLE + 1024 * 1024;

export interface AudioReviewChunk {
  id: string;
  track: 'caller' | 'agent';
  /** Bounds in the saved WAV, not word or utterance alignment. */
  startMs: number;
  endMs: number;
  text: string;
  /** SHA-256 of the exact WAV file bytes submitted for this chunk. */
  audioSha256: string;
}

export interface AudioReviewResult {
  model: string;
  generatedAt: string;
  chunks: AudioReviewChunk[];
  limitations: string[];
}

type ErrorCode =
  | 'INVALID_KEY'
  | 'INVALID_LANGUAGE'
  | 'WAV_READ_FAILED'
  | 'INVALID_WAV'
  | 'AUDIO_TOO_LONG'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE';

export class AudioReviewError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AudioReviewError';
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AudioReviewError('ABORTED', '独立录音复核已取消；已提交的片段可能已产生费用。');
}

function invalidWav(): never {
  throw new AudioReviewError(
    'INVALID_WAV',
    '录音必须是完整的 PCM16、单声道、24000 Hz RIFF WAV 文件。',
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
        bytes.readUInt32LE(start + 8) !== SAMPLE_RATE * BYTES_PER_SAMPLE ||
        bytes.readUInt16LE(start + 12) !== BYTES_PER_SAMPLE ||
        bytes.readUInt16LE(start + 14) !== 16 ||
        (length === 18 && bytes.readUInt16LE(start + 16) !== 0)
      )
        invalidWav();
      formatSeen = true;
    } else if (kind === 'data') {
      if (!formatSeen || pcm || !length || length % BYTES_PER_SAMPLE) invalidWav();
      if (length / BYTES_PER_SAMPLE > MAX_SAMPLES) {
        throw new AudioReviewError('AUDIO_TOO_LONG', '独立录音复核仅接受不超过 905 秒的单条音轨。');
      }
      pcm = bytes.subarray(start, end);
    }
    position = next;
  }
  if (!formatSeen || !pcm) invalidWav();
  return pcm;
}

async function readTrack(
  directory: string,
  track: AudioReviewChunk['track'],
  signal?: AbortSignal,
): Promise<Buffer> {
  checkAbort(signal);
  // Fixed filenames, no symlinks or blocking special files; never read settings.
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path.join(directory, `${track}.wav`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > MAX_FILE_BYTES) invalidWav();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      checkAbort(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) invalidWav();
      offset += result.bytesRead;
    }
    // Reject an unfinished/growing file instead of uploading an incomplete view.
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) invalidWav();
    checkAbort(signal);
    return parseWav(bytes);
  } catch (error) {
    if (error instanceof AudioReviewError) throw error;
    throw new AudioReviewError(
      'WAV_READ_FAILED',
      '无法读取 caller.wav 或 agent.wav，请确认两条完整录音均已保存。',
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

function wavChunk(pcm: Buffer): Buffer<ArrayBuffer> {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  wav.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function transcribeChunk(options: {
  wav: Buffer<ArrayBuffer>;
  filename: string;
  apiKey: string;
  language: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  checkAbort(options.signal);
  const timeout = AbortSignal.timeout(60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = new FormData();
  body.set('model', MODEL);
  body.set('language', options.language);
  body.set('response_format', 'json');
  body.set('file', new Blob([options.wav], { type: 'audio/wav' }), options.filename);
  // Deliberately no prompt, previous transcript, caller instructions or assertions.
  try {
    const response = await options.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body,
      redirect: 'manual',
      signal,
    });
    checkAbort(options.signal);
    if (timeout.aborted)
      throw new AudioReviewError('TIMEOUT', '独立录音复核片段超时；未自动重试，以免重复计费。');
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AudioReviewError(
          'AUTH_FAILED',
          '独立录音复核的 OpenAI API Key 无效或没有转写模型权限。',
        );
      }
      if (response.status === 429)
        throw new AudioReviewError(
          'RATE_LIMITED',
          '独立录音复核遇到 API 配额或速率限制，未自动重试。',
        );
      throw new AudioReviewError('HTTP_ERROR', '独立录音复核请求失败，未自动重试。');
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AudioReviewError('INVALID_RESPONSE', '独立录音复核返回格式不正确。');
    }
    checkAbort(options.signal);
    if (timeout.aborted)
      throw new AudioReviewError('TIMEOUT', '独立录音复核片段超时；未自动重试，以免重复计费。');
    if (
      typeof data !== 'object' ||
      data === null ||
      !('text' in data) ||
      typeof data.text !== 'string'
    ) {
      throw new AudioReviewError('INVALID_RESPONSE', '独立录音复核返回格式不正确。');
    }
    return data.text.trim();
  } catch (error) {
    checkAbort(options.signal);
    if (timeout.aborted)
      throw new AudioReviewError('TIMEOUT', '独立录音复核片段超时；未自动重试，以免重复计费。');
    if (error instanceof AudioReviewError) throw error;
    // Native/network/provider errors can contain request headers or response text.
    throw new AudioReviewError('NETWORK_ERROR', '无法连接独立录音转写服务；未自动重试。');
  }
}

/** Review saved audio independently of the live model's generated transcript. */
export async function transcribeRecording(options: {
  directory: string;
  apiKey: string;
  language: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AudioReviewResult> {
  checkAbort(options.signal);
  if (
    typeof options.apiKey !== 'string' ||
    options.apiKey.length > 16_384 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(options.apiKey) ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(options.apiKey.trim())
  ) {
    throw new AudioReviewError(
      'INVALID_KEY',
      '请先配置有效的 OpenAI API Key，再启用独立录音复核。',
    );
  }
  const language =
    typeof options.language === 'string'
      ? options.language.trim().toLowerCase().split(/[-_]/)[0]
      : '';
  if (!/^[a-z]{2}$/.test(language))
    throw new AudioReviewError(
      'INVALID_LANGUAGE',
      '录音复核语言请使用 ja、en 等两字母语言代码或对应地区代码。',
    );
  const apiKey = options.apiKey.trim();
  // Validate both complete tracks before the first potentially paid request.
  const tracks: Array<{ track: AudioReviewChunk['track']; pcm: Buffer }> = [];
  for (const track of ['caller', 'agent'] as const)
    tracks.push({ track, pcm: await readTrack(options.directory, track, options.signal) });
  const chunks: AudioReviewChunk[] = [];
  for (const { track, pcm } of tracks) {
    const samples = pcm.length / BYTES_PER_SAMPLE;
    for (let start = 0, index = 1; start < samples; start += STRIDE_SAMPLES, index++) {
      checkAbort(options.signal);
      const end = Math.min(start + CHUNK_SAMPLES, samples);
      const wav = wavChunk(pcm.subarray(start * BYTES_PER_SAMPLE, end * BYTES_PER_SAMPLE));
      const text = await transcribeChunk({
        wav,
        filename: `${track}-${index}.wav`,
        apiKey,
        language,
        fetchImpl: options.fetchImpl ?? fetch,
        signal: options.signal,
      });
      chunks.push({
        id: `audio:${track}:${index}`,
        track,
        startMs: (start * 1000) / SAMPLE_RATE,
        endMs: (end * 1000) / SAMPLE_RATE,
        text,
        audioSha256: createHash('sha256').update(wav).digest('hex'),
      });
      if (end === samples) break;
    }
  }
  return {
    model: MODEL,
    generatedAt: new Date().toISOString(),
    chunks,
    limitations: [
      '时间范围是实际录音片段的起止位置，不是逐字或逐句对齐；需要播放片段定位具体发音。',
      '相邻片段重叠 2 秒，同一句可能出现在两份转写中，不应计为重复发言。',
      '独立转写也可能误听或补写内容，尤其是数字、姓名和静音；与原始转写冲突时应试听确认。',
      'caller 轨记录本地发送的声音，agent 轨记录本地收到的声音，不能证明远端系统实际识别或保存了什么。',
    ],
  };
}

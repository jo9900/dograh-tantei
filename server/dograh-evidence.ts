import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CallRecord } from '../shared/types.js';
import type { LocalStore } from './store.js';
import { DograhClient, type WorkflowRun } from './dograh.js';
import { connectionSecrets, dograhClientConfig, settingsFingerprint } from './connection.js';
import type { ParsedEvidence, TranscriptEvidence } from './evaluation-evidence.js';

export interface DograhEvidence {
  transcript: TranscriptEvidence[];
  gatheredContext: unknown;
  recordings: Record<'mixed' | 'caller' | 'agent', boolean>;
  timingBasis: string;
}
const fields = {
  mixed: 'recording_public_url',
  caller: 'user_recording_public_url',
  agent: 'bot_recording_public_url',
} as const;
const pending = new Map<string, Promise<DograhEvidence>>();

/** Provider timestamps are relative to run creation, not the local worker clock. */
export function parseDograhTranscript(text: string, createdAt: string): TranscriptEvidence[] {
  if (text.length > 120_000) throw new Error('Dograh 转写超过评审容量。');
  const start = Date.parse(createdAt);
  if (!Number.isFinite(start)) throw new Error('Dograh 通话起始时间无效。');
  const turns: TranscriptEvidence[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\] (assistant|user):\s*(.*)$/.exec(line);
    if (match) {
      const atMs = Date.parse(match[1]!) - start;
      if (!Number.isFinite(atMs) || atMs < 0 || (turns.length && atMs < turns.at(-1)!.atMs))
        throw new Error('Dograh 转写时间顺序无效。');
      turns.push({
        id: `dograh:${turns.length + 1}`,
        line: null,
        speaker: match[2] === 'user' ? 'caller' : 'agent',
        text: match[3]!,
        atMs,
        source: 'dograh_transcript',
        providerStartMs: atMs,
        providerEndMs: null,
        transcriptOrigin: match[2] === 'user' ? 'dograh_stt' : 'dograh_agent_text',
        audioVerified: false,
      });
    } else if (line.trim()) {
      if (!turns.length || line.startsWith('[')) throw new Error('Dograh 转写格式无法识别。');
      turns.at(-1)!.text += '\n' + line;
    }
  }
  if (!turns.some((t) => t.speaker === 'caller') || !turns.some((t) => t.speaker === 'agent'))
    throw new Error('Dograh 双方转写尚未完整，稍后可重新评审。');
  return turns;
}

export function redactContext(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => redactContext(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /token|password|secret|api.?key|authorization|credential/i.test(k)
          ? '[redacted]'
          : redactContext(v, secrets),
      ]),
    );
  if (typeof value === 'string') {
    for (const secret of secrets)
      if (secret) value = (value as string).split(secret).join('[redacted]');
    return (value as string)
      .replace(/https?:\/\/[^\s"<>]+/g, '[URL omitted]')
      .replace(/sk-[\w-]+/g, '[redacted]');
  }
  return value;
}

/** Only fetch the provider's same-origin public download endpoint; never forward credentials. */
export async function downloadArtifact(
  raw: unknown,
  baseUrl: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (typeof raw !== 'string') throw new Error('Dograh 文件尚未就绪。');
  const url = new URL(raw);
  const base = new URL(baseUrl);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !/^\/(?:backend\/)?api\/v1\/public\/download\/workflow\/[^/]+\/(?:transcript|recording|user_recording|bot_recording)$/.test(
      url.pathname,
    )
  )
    throw new Error('Dograh 文件地址不在允许的下载范围。');
  const timeout = AbortSignal.timeout(60_000);
  let response = await fetch(url, {
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = new URL(response.headers.get('location') ?? '', url);
    if (
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      !/^\/voice-audio\/(?:transcripts\/\d+\.txt|recordings\/\d+(?:\.wav|\/(?:user|bot)\.wav))$/.test(
        target.pathname,
      )
    ) {
      await response.body?.cancel();
      throw new Error('Dograh 下载跳转不在允许范围。');
    }
    await response.body?.cancel();
    response = await fetch(target, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
  if (!response.ok || !response.body)
    throw new Error(`Dograh 文件读取失败（HTTP ${response.status}）。`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Dograh 文件超过读取上限。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

async function savedRun(store: LocalStore, call: CallRecord): Promise<WorkflowRun> {
  let run = await store.read<WorkflowRun | null>(`calls/${call.id}/dograh-run.json`, null);
  if (!run?.is_completed || !run.transcript_public_url) {
    const task = store.tasks.find((t) => t.id === call.taskId);
    if (!call.runId || task?.connectionFingerprint !== settingsFingerprint(store.settings))
      throw new Error('Dograh 连接已更改或通话记录不可用。');
    run = await new DograhClient(dograhClientConfig(store.settings)).getRun(
      call.workflowId,
      call.runId,
    );
    if (
      run.id !== call.runId ||
      (run.workflow_id !== undefined && run.workflow_id !== call.workflowId)
    )
      throw new Error('Dograh 通话记录不匹配。');
    await store.write(`calls/${call.id}/dograh-run.json`, run);
  }
  if (
    run.id !== call.runId ||
    (run.workflow_id !== undefined && run.workflow_id !== call.workflowId)
  )
    throw new Error('Dograh 通话记录不匹配。');
  return run;
}

export async function ensureDograhEvidence(
  store: LocalStore,
  call: CallRecord,
): Promise<DograhEvidence> {
  const key = `${store.dir}:${call.id}`;
  const cached = await store.read<DograhEvidence | null>(
    `calls/${call.id}/dograh-evidence.json`,
    null,
  );
  if (cached) return cached;
  const active = pending.get(key);
  if (active) return active;
  const work = (async () => {
    const run = await savedRun(store, call);
    if (!run.is_completed) throw new Error('Dograh 通话尚未结束，转写正在整理。');
    const bytes = await downloadArtifact(
      run.transcript_public_url,
      store.settings.dograhBaseUrl,
      1_000_000,
    );
    const result: DograhEvidence = {
      transcript: parseDograhTranscript(bytes.toString('utf8'), String(run.created_at)),
      gatheredContext: redactContext(
        run.gathered_context ?? null,
        connectionSecrets(store.settings),
      ),
      recordings: {
        mixed: !!run.recording_public_url,
        caller: !!run.user_recording_public_url,
        agent: !!run.bot_recording_public_url,
      },
      timingBasis: 'Dograh 事件时间相对 Run 创建时间；录音定位为近似值，并非逐字对齐。',
    };
    await store.write(`calls/${call.id}/dograh-evidence.json`, result);
    return result;
  })();
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}

export function dograhParsedEvidence(
  data: DograhEvidence,
  durationSeconds: number,
): ParsedEvidence {
  const end = data.transcript.at(-1)?.atMs ?? 0;
  return {
    events: data.transcript,
    durationMs: Math.max(durationSeconds * 1000, end),
    eventEndMs: end,
    recordingDurationMs: null,
    lineCount: data.transcript.length,
  };
}

export async function ensureDograhRecording(
  store: LocalStore,
  call: CallRecord,
  track: keyof typeof fields,
): Promise<string> {
  const file = path.join(store.callDir(call.id), `dograh-${track}.wav`);
  if (await fs.stat(file).catch(() => null)) return file;
  const run = await savedRun(store, call);
  const bytes = await downloadArtifact(
    run[fields[track]],
    store.settings.dograhBaseUrl,
    180_000_000,
  );
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Dograh 返回的录音不是有效 WAV。');
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  await fs.rename(temporary, file);
  return file;
}

import { z } from 'zod';
import type { CallRecord } from '../shared/types.js';
import { listPromptFields, type DefinitionSnapshot, type PromptField } from './dograh.js';
import type { AudioReviewResult } from './audio-review.js';
import { numericAudioConflicts } from './numeric-evidence.js';

export const EVALUATION_LIMITATIONS = [
  '仅依据转写文本评审业务语义；未通过此评审分析原始音频、STT 准确率、TTS 音质或打断表现。',
  '转写由 GPT-Live 1 提供，可能不完整或有识别错误；语义问题均为待确认候选。',
  '模拟来电者的模型输出文本不等于已发送录音中的实际说法；未启用独立录音转写时，无法自动排除两者不一致。',
  '片段时间来自转写事件到达本地的 atMs，包含回放余量，不是逐字声学对齐；provider 时间单独保存。',
  '精确回应等待由音频执行器单独计时，评审模型不能从转写推断秒数。',
];

export function safeMessage(error: unknown, secrets: string[] = []): string {
  if (error instanceof z.ZodError)
    return '评审或测试草案格式不符合要求，请重新整理；请检查结果分类、处理结论及证据引用（每组最多 512 条）。';
  if (error instanceof SyntaxError)
    return '评审返回的 JSON 格式不完整，请重新评审；没有据此作通过或失败判断。';
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text
    .replace(/sk-[\w-]+/g, '[redacted]')
    .replace(/([?&](?:token|api_key)=)[^\s&]+/gi, '$1[redacted]')
    .slice(0, 1_200);
}

export interface TranscriptEvidence {
  id: string;
  line: number | null;
  speaker: 'agent' | 'caller';
  text: string;
  atMs: number;
  source: string;
  providerStartMs: number | null;
  providerEndMs: number | null;
  transcriptOrigin?: string;
  audioVerified?: boolean;
  afterStop?: boolean;
  recording?: { track: 'caller' | 'agent'; startMs: number; endMs: number; audioSha256: string };
}
export interface ParsedEvidence {
  events: TranscriptEvidence[];
  durationMs: number;
  eventEndMs: number;
  recordingDurationMs: number | null;
  lineCount: number;
}

export function parseTranscriptEvents(jsonl: string): ParsedEvidence {
  const events: TranscriptEvidence[] = [];
  const lines = jsonl.split(/\r?\n/);
  let lastAtMs = 0;
  let recordingDurationMs: number | null = null;
  let textLength = 0;
  let lineCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    lineCount++;
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      event = value as Record<string, unknown>;
    } catch {
      throw new Error(`通话事件第 ${index + 1} 行不完整，无法可靠评审。`);
    }
    if (typeof event.atMs === 'number' && Number.isFinite(event.atMs) && event.atMs >= 0)
      lastAtMs = event.atMs;
    if (
      event.type === 'artifacts' &&
      typeof event.durationMs === 'number' &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0
    ) {
      recordingDurationMs = event.durationMs;
    }
    if (event.type !== 'transcript') continue;
    if (typeof event.text !== 'string') throw new Error(`转写事件第 ${index + 1} 行缺少文本。`);
    if (!event.text.trim()) continue;
    if (
      (event.speaker !== 'agent' && event.speaker !== 'caller') ||
      typeof event.atMs !== 'number' ||
      !Number.isFinite(event.atMs) ||
      event.atMs < 0
    ) {
      throw new Error(`转写事件第 ${index + 1} 行缺少可靠的说话者或本地时间。`);
    }
    const numberOrNull = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    textLength += event.text.length;
    if (events.length >= 5_000 || textLength > 120_000)
      throw new Error('转写超出单次自动评审容量，请缩短通话或人工复核；没有截断后判为通过。');
    events.push({
      id: `event:${index + 1}`,
      line: index + 1,
      speaker: event.speaker,
      text: event.text,
      atMs: event.atMs,
      source: typeof event.source === 'string' ? event.source : 'unspecified',
      providerStartMs: numberOrNull(event.providerStartMs),
      providerEndMs: numberOrNull(event.providerEndMs),
      transcriptOrigin:
        typeof event.transcriptOrigin === 'string'
          ? event.transcriptOrigin
          : event.speaker === 'caller'
            ? 'model_output'
            : 'input_audio_transcription',
      audioVerified: false,
      afterStop: event.afterStop === true,
    });
  }
  if (events.some((event) => event.atMs > lastAtMs))
    throw new Error('转写时间超出最后一个本地事件时间，无法建立可靠片段索引。');
  return {
    events,
    durationMs: recordingDurationMs === null ? lastAtMs : Math.min(lastAtMs, recordingDurationMs),
    eventEndMs: lastAtMs,
    recordingDurationMs,
    lineCount,
  };
}

/** Validate policy against the saved call snapshot, never the current remote workflow. */
export function workflowPromptsForCall(
  savedWorkflow: DefinitionSnapshot | null,
  call: CallRecord,
): PromptField[] {
  let workflowPrompts: PromptField[] = [];
  if (savedWorkflow) {
    if (
      savedWorkflow.workflowId !== call.workflowId ||
      (call.workflowHash && savedWorkflow.hash !== call.workflowHash) ||
      !savedWorkflow.workflow?.workflow_definition
    )
      throw new Error('本次通话的工作流快照不匹配，无法可靠核对处理规则。');
    workflowPrompts = listPromptFields(savedWorkflow.workflow);
    if (JSON.stringify(workflowPrompts).length > 120_000)
      throw new Error('本次工作流提示词超过评审容量，请人工核对异常分支。');
  }
  return workflowPrompts;
}

/** Keep recording evidence separate from model output and exclude speech received after stop. */
export function prepareReviewEvidence(evidence: ParsedEvidence, audioReview?: AudioReviewResult) {
  const eligibleEvents = evidence.events.filter(
    (event) => !event.afterStop && event.atMs <= evidence.durationMs,
  );
  if (
    !eligibleEvents.some((event) => event.speaker === 'caller') ||
    !eligibleEvents.some((event) => event.speaker === 'agent')
  )
    throw new Error('录音时段内双方转写不完整，无法可靠判断。');
  const audioEvents: TranscriptEvidence[] = (audioReview?.chunks ?? [])
    .filter((chunk) => chunk.text.trim())
    .map((chunk) => ({
      id: chunk.id,
      line: null,
      speaker: chunk.track,
      text: chunk.text,
      atMs: chunk.startMs,
      source: 'independent_recording_transcription',
      providerStartMs: null,
      providerEndMs: null,
      transcriptOrigin: 'recorded_audio',
      audioVerified: false,
      recording: {
        track: chunk.track,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        audioSha256: chunk.audioSha256,
      },
    }));
  if (
    audioReview &&
    (!audioEvents.some((event) => event.speaker === 'caller') ||
      !audioEvents.some((event) => event.speaker === 'agent'))
  )
    throw new Error('独立录音转写缺少双方有效语音，无法判断 AI 客服 是否符合要求。');
  const reviewEvidence = [...eligibleEvents, ...audioEvents];
  const numericConflicts = audioReview
    ? numericAudioConflicts(
        eligibleEvents
          .filter((e) => e.speaker === 'caller')
          .map((e) => e.text)
          .join(''),
        audioEvents
          .filter((e) => e.speaker === 'caller')
          .map((e) => e.text)
          .join('\n'),
      )
    : [];
  return { reviewEvidence, numericConflicts };
}

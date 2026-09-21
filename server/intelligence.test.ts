import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, CallRecord, TestTask } from '../shared/types.js';
import {
  evaluateCall,
  cancelEvaluations,
  extractResponseTimeout,
  parseTranscriptEvents,
  planRules,
  type IntelligencePi,
} from './intelligence.js';
import { LocalStore } from './store.js';
import * as audioReview from './audio-review.js';

afterEach(() => vi.restoreAllMocks());

function fakePi(configured = true, response = '{}') {
  return {
    status: vi.fn(async () => ({
      configured,
      environmentApiKeySet: false,
      environmentAnthropicApiKeySet: false,
      modelError: null,
      providers: [],
      model: { provider: 'openai' as const, id: 'test-model' },
      busy: false,
      login: null,
      sessionId: null,
    })),
    complete: vi.fn(async (_prompt: string, _signal?: AbortSignal) => response),
  } satisfies IntelligencePi;
}
const validPlan = {
  callerInstructions:
    'Act as a Japanese taxi customer. Change the pickup entrance once, wait for confirmation, then end the conversation.',
  responseTimeoutSeconds: null,
  assertions: ['更正上车点后，最终确认使用新的上车点。'],
  interpretation: '通过日语改口场景检查最终确认是否包含新地点。',
};
const judgment = (
  status: 'pass' | 'fail' | 'inconclusive' = 'fail',
  evidenceIds = ['event:1', 'event:2'],
) =>
  JSON.stringify({
    summary: '地点确认评审结果。',
    assertions: [
      {
        assertionIndex: 0,
        status,
        category: 'agent_behavior',
        handling: {
          status:
            status === 'fail' ? 'inappropriate' : status === 'pass' ? 'appropriate' : 'uncertain',
          reason: '根据客服的地点复述评估处理。',
          evidenceIds,
        },
        reason: '来电者要求西口，但 AI 客服最终确认东口。',
        evidenceIds,
        severity: 'high',
        problemTitle: 'AI 客服确认了错误的地点',
        scenario: {
          status: 'observed',
          reason: '来电者实际更正为西口。',
          evidenceIds: ['event:1'],
          audioAgreement: 'not_checked',
        },
      },
    ],
  });
const transcript = [
  {
    type: 'transcript',
    atMs: 1_000,
    speaker: 'caller',
    text: '東口ではなく西口にお願いします。',
    source: 'gpt-live-1',
    providerStartMs: 900_000,
    providerEndMs: 901_000,
  },
  {
    type: 'transcript',
    atMs: 2_000,
    speaker: 'agent',
    text: '東口でお待ちください。',
    source: 'gpt-live-1',
    providerStartMs: 920_000,
    providerEndMs: 921_000,
  },
  { type: 'completed', atMs: 3_000 },
];

async function fixture(options: { events?: unknown[]; withTranscript?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tantei-intelligence-test-'));
  const store = new LocalStore(dir);
  await store.init();
  const task: TestTask = {
    id: 'task1',
    name: 'Location correction',
    workflowId: 7,
    workflowName: 'Taxi demo',
    requirement: '修改上车地点之后正确确认',
    language: 'ja-JP',
    concurrency: 5,
    maxCalls: 10,
    maxDurationSeconds: 180,
    maxVoiceMinutes: 30,
    rules: { ...validPlan, source: 'pi' },
    status: 'running',
    createdAt: new Date().toISOString(),
    completedCalls: 1,
    failedCalls: 0,
    consumedSeconds: 3,
  };
  const call: CallRecord = {
    id: 'call1',
    taskId: task.id,
    workflowId: 7,
    status: 'completed',
    startedAt: new Date().toISOString(),
    durationSeconds: 180,
    workflowHash: 'version-a',
  };
  store.tasks.push(task);
  store.calls.push(call);
  const events: AppEvent[] = [];
  const emit = (event: AppEvent) => events.push(event);
  if (options.withTranscript !== false) {
    await mkdir(store.callDir(call.id), { recursive: true });
    await writeFile(
      join(store.callDir(call.id), 'bridge-events.jsonl'),
      (options.events ?? transcript).map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
  }
  return { store, task, call, events, emit };
}

async function cachedAudio(f: Awaited<ReturnType<typeof fixture>>) {
  const wav = Buffer.alloc(44 + 24_000 * 2 * 3);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (const track of ['caller', 'agent'])
    await writeFile(join(f.store.callDir(f.call.id), `${track}.wav`), wav);
  const cache = {
    model: 'gpt-4o-transcribe',
    generatedAt: new Date().toISOString(),
    limitations: ['ASR may mishear'],
    chunks: [
      {
        id: 'audio:caller:1',
        track: 'caller',
        startMs: 0,
        endMs: 3000,
        text: transcript[0]!.text,
        audioSha256: createHash('sha256').update(wav).digest('hex'),
      },
      {
        id: 'audio:agent:1',
        track: 'agent',
        startMs: 0,
        endMs: 3000,
        text: transcript[1]!.text,
        audioSha256: createHash('sha256').update(wav).digest('hex'),
      },
    ],
  };
  f.task.rules.audioReview = true;
  await f.store.write('calls/call1/rules.json', f.task.rules);
  await f.store.write('calls/call1/audio-review.json', cache);
  return cache;
}

function audioJudgment() {
  const raw = JSON.parse(judgment());
  raw.assertions[0].evidenceIds = ['audio:agent:1'];
  raw.assertions[0].handling.evidenceIds = ['audio:agent:1'];
  raw.assertions[0].scenario.evidenceIds = ['audio:caller:1'];
  raw.assertions[0].scenario.audioAgreement = 'consistent';
  return raw;
}

describe('test requirement planning', () => {
  it('keeps only explicit core objectives and places honest exception handling in commentary, not extra checks', async () => {
    const pi = fakePi(
      true,
      JSON.stringify({ ...validPlan, assertions: ['确认变更后的目的地。', '完成预约目标。'] }),
    );
    const result = await planRules(pi, { requirement: '变更目的地并完成订单', language: 'ja' });
    expect(result.assertions).toHaveLength(2);
    expect(pi.complete.mock.calls[0]![0]).toContain('ONE-TO-ONE');
    expect(pi.complete.mock.calls[0]![0]).toContain('TWO core assertions');
    expect(pi.complete.mock.calls[0]![0]).toContain('Never require unconditional success wording');
  });
  it('preserves arbitrary requirements and clearly reports manual limitations when Pi is disconnected', async () => {
    const pi = fakePi(false);
    const result = await planRules(pi, {
      requirement: '这一轮不能中途超过10s还不回答，改口后要使用新地点',
      language: 'ja-JP',
    });
    expect(result.source).toBe('manual');
    expect(result.responseTimeoutSeconds).toBe(10);
    expect(result.assertions).toEqual([]);
    expect(result.callerInstructions).toContain('改口后要使用新地点');
    expect(result.callerInstructions).toContain('ja-JP');
    expect(result.interpretation).toContain('不会自动判断任意业务要求是否通过');
    expect(pi.complete).not.toHaveBeenCalled();
  });

  it('does not mistake unrelated or ambiguous durations for a response threshold', () => {
    expect(extractResponseTimeout('预约10秒后出发')).toBeNull();
    expect(extractResponseTimeout('第一次回答10秒，之后回答5秒')).toBeNull();
    expect(extractResponseTimeout('The agent must respond within 10 seconds.')).toBe(10);
    expect(extractResponseTimeout('応答が10秒を超えないこと')).toBe(10);
    expect(extractResponseTimeout('不要回答超过0秒')).toBeNull();
  });

  it('uses explicit null to disable timing even when Pi or the requirement suggests a threshold', async () => {
    const pi = fakePi(true, JSON.stringify({ ...validPlan, responseTimeoutSeconds: 10 }));
    const result = await planRules(pi, {
      requirement: '测试10秒不回答',
      language: 'ja-JP',
      responseTimeoutSeconds: null,
    });
    expect(result.responseTimeoutSeconds).toBeNull();
    expect(result.source).toBe('pi');
    expect(result.assertions).toEqual(validPlan.assertions);
    expect(result.audioReview).toBe(false);
  });

  it('refuses invalid model output instead of silently running an unvalidated plan', async () => {
    const pi = fakePi(
      true,
      JSON.stringify({ ...validPlan, responseTimeoutSeconds: -10, executeNow: true }),
    );
    await expect(planRules(pi, { requirement: '检查地点修改', language: 'ja-JP' })).rejects.toThrow(
      '尚未启动测试',
    );
  });
});

describe('v3 outcomes, handling and reassessment', () => {
  it('keeps a booking failure separate from appropriate handling and uses only the saved workflow', async () => {
    const f = await fixture();
    await f.store.write('calls/call1/workflow.json', {
      workflowId: 7,
      hash: 'version-a',
      createdAt: 'saved-time',
      workflow: {
        workflow_definition: {
          nodes: [
            {
              id: 'failure',
              data: { prompt: '予約登録が失敗したら謝罪して、後ほどかけ直すよう案内する。' },
            },
          ],
        },
      },
    });
    const raw = JSON.parse(judgment());
    raw.assertions[0].category = 'business_outcome';
    raw.assertions[0].handling = {
      status: 'appropriate',
      reason: '如实告知登记失败并建议稍后重拨。',
      evidenceIds: ['event:2'],
    };
    const pi = fakePi(true, JSON.stringify(raw));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report).toMatchObject({
      version: 3,
      overall: 'fail',
      workflowSnapshot: { hash: 'version-a' },
    });
    expect(report.judgment.assertions[0]).toMatchObject({
      category: 'business_outcome',
      status: 'fail',
      handling: { status: 'appropriate' },
    });
    expect(f.store.findings[0]).toMatchObject({
      category: 'business_outcome',
      handling: { status: 'appropriate' },
    });
    expect(f.store.findings[0]!.detail).not.toContain('不等于客服处理错误');
    expect(f.store.findings[0]!.detail).toContain('如实告知登记失败并建议稍后重拨。');
    expect(pi.complete.mock.calls[0]![0]).toContain('予約登録が失敗したら謝罪して');
  });

  it('downgrades a behavior failure contradicted by appropriate handling and does not call a detail a failure', async () => {
    const f = await fixture();
    const raw = JSON.parse(judgment());
    raw.assertions[0].handling.status = 'appropriate';
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
    let report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.overall).toBe('inconclusive');
    expect(f.store.findings).toHaveLength(0);
    raw.assertions[0].category = 'observation';
    raw.assertions[0].problemTitle = '初始复述省略入口，随后已改为机场。';
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit, {
      force: true,
    });
    report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.judgment.assertions[0]).toMatchObject({
      status: 'inconclusive',
      category: 'observation',
      severity: 'low',
    });
    expect(f.store.findings[0]).toMatchObject({ category: 'observation', severity: 'low' });
  });

  it('validates handling IDs independently and blocks handling claims when scenario evidence is missing', async () => {
    const f = await fixture();
    const raw = JSON.parse(judgment());
    raw.assertions[0].handling.evidenceIds = ['event:999'];
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
    expect(f.task.evaluationError).toContain('客服处理结论引用');
    raw.assertions[0].handling.evidenceIds = ['event:2'];
    raw.assertions[0].scenario.status = 'not_observed';
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.judgment.assertions[0]).toMatchObject({
      status: 'inconclusive',
      handling: { status: 'uncertain' },
    });
  });

  it('requires independent agent audio for handling when audio review is enabled', async () => {
    const f = await fixture();
    await cachedAudio(f);
    const raw = audioJudgment();
    raw.assertions[0].handling.evidenceIds = ['event:2'];
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit, {
      reuseAudioReview: true,
    });
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.judgment.assertions[0]).toMatchObject({
      status: 'inconclusive',
      handling: { status: 'uncertain' },
    });
  });

  it('accepts more than twenty real references and deduplicates only after validating every ID', async () => {
    const events = Array.from({ length: 35 }, (_, index) => ({
      type: 'transcript',
      atMs: index + 1,
      speaker: index === 0 ? 'caller' : 'agent',
      text: `片段${index}`,
    }));
    const f = await fixture({ events: [...events, { type: 'completed', atMs: 100 }] });
    const ids = events.map((_, index) => `event:${index + 1}`);
    await evaluateCall(
      fakePi(true, judgment('fail', [...ids, 'event:1', 'event:2'])),
      f.store,
      f.task,
      f.call,
      f.emit,
    );
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.status).toBe('complete');
    expect(report.judgment.assertions[0].evidenceIds).toHaveLength(35);
    await evaluateCall(
      fakePi(true, judgment('fail', [...ids, 'event:999'])),
      f.store,
      f.task,
      f.call,
      f.emit,
      { force: true },
    );
    expect((await f.store.read<any>('calls/call1/evaluation-attempt.json', null)).status).toBe(
      'failed',
    );
    expect(await f.store.read('calls/call1/evaluation.json', null)).toEqual(report);
  });

  it('reports schema capacity errors in Chinese without serializing model JSON', async () => {
    const f = await fixture();
    const raw = JSON.parse(judgment());
    raw.assertions[0].evidenceIds = Array(513).fill('event:2');
    raw.assertions[0].reason = 'PRIVATE_MODEL_PAYLOAD';
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
    expect(f.task.evaluationError).toContain('每组最多 512 条');
    expect(f.task.evaluationError).not.toContain('PRIVATE_MODEL_PAYLOAD');
    expect(f.task.evaluationError).not.toContain('"code"');
  });

  it('reuses hash-verified recordings for a stopped task without another ASR request', async () => {
    const f = await fixture();
    await cachedAudio(f);
    f.task.status = 'stopped';
    f.call.evaluationStatus = 'unavailable';
    const oldReport = { version: 2, status: 'unavailable', error: 'old limit' };
    await f.store.write('calls/call1/evaluation.json', oldReport);
    const asr = vi.spyOn(audioReview, 'transcribeRecording');
    const pi = fakePi(true, JSON.stringify(audioJudgment()));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit, {
      force: true,
      reuseAudioReview: true,
    });
    expect(asr).not.toHaveBeenCalled();
    expect(f.call.evaluationStatus).toBe('complete');
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.audioReviewReused).toBe(true);
    expect(
      await f.store.read<any>(
        `calls/call1/evaluation-revisions/${report.revisionId}/before.json`,
        null,
      ),
    ).toMatchObject({ evaluation: oldReport });
    expect(await f.store.read<any>('calls/call1/evaluation-attempt.json', null)).toMatchObject({
      status: 'complete',
      preservedPrevious: false,
    });
  });

  it('refuses mismatched cached audio without paying ASR or replacing the previous evaluation', async () => {
    const f = await fixture();
    const cache = await cachedAudio(f);
    cache.chunks[0]!.audioSha256 = '0'.repeat(64);
    await f.store.write('calls/call1/audio-review.json', cache);
    const previous = { version: 2, status: 'complete', overall: 'pass' };
    f.call.evaluationStatus = 'complete';
    await f.store.write('calls/call1/evaluation.json', previous);
    const asr = vi.spyOn(audioReview, 'transcribeRecording');
    const pi = fakePi(true, JSON.stringify(audioJudgment()));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit, {
      force: true,
      reuseAudioReview: true,
    });
    expect(asr).not.toHaveBeenCalled();
    expect(pi.complete).not.toHaveBeenCalled();
    expect(await f.store.read('calls/call1/evaluation.json', null)).toEqual(previous);
    expect(f.call.evaluationStatus).toBe('complete');
    expect(await f.store.read<any>('calls/call1/evaluation-attempt.json', null)).toMatchObject({
      status: 'failed',
      preservedPrevious: true,
    });
  });

  it('preserves manual reviews for the same assertion, replaces judge findings, and leaves timers alone', async () => {
    const f = await fixture();
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit);
    f.store.findings[0]!.state = 'confirmed';
    f.store.findings[0]!.reviewNote = '人工试听已核实。';
    const timer = {
      ...f.store.findings[0]!,
      id: 'timer-one',
      kind: 'response_timeout',
      source: 'timer' as const,
    };
    f.store.findings.push(timer);
    const oldFinding = structuredClone(f.store.findings[0]!);
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit, { force: true });
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(f.store.findings).toHaveLength(2);
    expect(f.store.findings.find((finding) => finding.source === 'judge')).toMatchObject({
      state: 'confirmed',
      reviewNote: '人工试听已核实。',
    });
    expect(f.store.findings.find((finding) => finding.id === 'timer-one')).toEqual(timer);
    expect(
      await f.store.read<any>(
        `calls/call1/evaluation-revisions/${report.revisionId}/before.json`,
        null,
      ),
    ).toMatchObject({ findings: [oldFinding] });
  });

  it('realigns review goals without rewriting original rules or inheriting a different assertion manual verdict', async () => {
    const f = await fixture();
    await f.store.write('calls/call1/rules.json', f.task.rules);
    const originalBytes = await readFile(join(f.store.callDir('call1'), 'rules.json'), 'utf8');
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit);
    f.store.findings[0]!.state = 'dismissed';
    f.store.findings[0]!.reviewNote = '旧检查项人工排除';
    const rules = {
      ...f.task.rules,
      assertions: ['完成预约业务目标。'],
      interpretation: '只检查原用户核心目标。',
      callerInstructions: 'MUST NOT REPLACE ACTUAL CALLER',
      audioReview: true,
      responseTimeoutSeconds: 9,
    };
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit, {
      force: true,
      reviewRules: rules,
    });
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.rules.assertions).toEqual(rules.assertions);
    expect(report.originalRules).toEqual(f.task.rules);
    expect(report.rules.callerInstructions).toBe(f.task.rules.callerInstructions);
    expect(report.rules.audioReview).toBeUndefined();
    expect(report.rules.responseTimeoutSeconds).toBeNull();
    expect(await readFile(join(f.store.callDir('call1'), 'rules.json'), 'utf8')).toBe(
      originalBytes,
    );
    expect(f.store.findings[0]).toMatchObject({ state: 'candidate' });
    expect(f.store.findings[0]!.reviewNote).toBeUndefined();
    expect(
      (
        await f.store.read<any>(
          `calls/call1/evaluation-revisions/${report.revisionId}/after.json`,
          null,
        )
      ).previousManualReviews[0],
    ).toMatchObject({ state: 'dismissed', reviewNote: '旧检查项人工排除' });
  });

  it('keeps all previous results and findings when forced model evaluation fails', async () => {
    const f = await fixture();
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit);
    f.store.findings[0]!.state = 'confirmed';
    const previousFindings = structuredClone(f.store.findings);
    const previous = await f.store.read('calls/call1/evaluation.json', null);
    const pi = fakePi();
    pi.complete.mockRejectedValueOnce(new Error('temporary model failure'));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit, { force: true });
    expect(await f.store.read('calls/call1/evaluation.json', null)).toEqual(previous);
    expect(f.store.findings).toEqual(previousFindings);
    expect(f.call.evaluationStatus).toBe('complete');
    const attempt = await f.store.read<any>('calls/call1/evaluation-attempt.json', null);
    expect(attempt).toMatchObject({ status: 'failed', preservedPrevious: true });
    expect(
      await readdir(join(f.store.callDir('call1'), 'evaluation-revisions', attempt.revisionId)),
    ).toEqual(['before.json', 'error.json']);
  });

  it('matches a retained manual verdict by assertion text when goals are reordered and reduced', async () => {
    const f = await fixture();
    f.task.rules.assertions = ['初始地点复述要求。', '确认最终目的地要求。'];
    await f.store.write('calls/call1/rules.json', f.task.rules);
    const old = JSON.parse(judgment());
    old.assertions.push({ ...structuredClone(old.assertions[0]), assertionIndex: 1 });
    await evaluateCall(fakePi(true, JSON.stringify(old)), f.store, f.task, f.call, f.emit);
    const retained = f.store.findings.find((finding) => finding.kind === 'semantic_assertion_1')!;
    retained.state = 'dismissed';
    retained.reviewNote = '最终目的地人工复核无误';
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit, {
      force: true,
      reviewRules: { ...f.task.rules, assertions: ['确认最终目的地要求。'] },
    });
    expect(f.store.findings).toHaveLength(1);
    expect(f.store.findings[0]).toMatchObject({
      kind: 'semantic_assertion_0',
      state: 'dismissed',
      reviewNote: '最终目的地人工复核无误',
    });
  });

  it('retains cached ASR without requesting fresh transcription when review fails', async () => {
    const f = await fixture();
    const cache = await cachedAudio(f);
    await evaluateCall(
      fakePi(true, JSON.stringify(audioJudgment())),
      f.store,
      f.task,
      f.call,
      f.emit,
      { reuseAudioReview: true },
    );
    const fresh = structuredClone(cache);
    fresh.generatedAt = '2030-01-01T00:00:00.000Z';
    vi.spyOn(audioReview, 'transcribeRecording').mockResolvedValue(
      fresh as audioReview.AudioReviewResult,
    );
    const pi = fakePi();
    pi.complete.mockRejectedValue(new Error('judge unavailable'));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit, { force: true });
    expect(await f.store.read('calls/call1/audio-review.json', null)).toEqual(cache);
    const attempt = await f.store.read<any>('calls/call1/evaluation-attempt.json', null);
    expect(
      await f.store.read(
        `calls/call1/evaluation-revisions/${attempt.revisionId}/audio-review.json`,
        null,
      ),
    ).toBeNull();
    expect(audioReview.transcribeRecording).not.toHaveBeenCalled();
  });

  it('cancels plan generation through the provided signal before it can produce review rules', async () => {
    const controller = new AbortController();
    const pi = fakePi();
    pi.complete.mockImplementation(
      async (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('计划已取消')), { once: true });
        }),
    );
    const pending = planRules(pi, {
      requirement: '变更目的地并完成订单',
      language: 'ja',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(pi.complete).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow('计划已取消');
  });

  it('does not automatically evaluate stopped tasks and rejects forcing an active call', async () => {
    const f = await fixture();
    f.task.status = 'stopped';
    const pi = fakePi(true, judgment());
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(pi.complete).not.toHaveBeenCalled();
    expect(f.call.evaluationStatus).toBe('unavailable');
    f.call.status = 'running';
    await expect(
      evaluateCall(pi, f.store, f.task, f.call, f.emit, { force: true }),
    ).rejects.toThrow('通话尚未结束');
  });
});

describe('independent transcript judging', () => {
  it.each(['contradicted', 'not_observed', 'uncertain'])(
    'does not blame the AI service when the caller scenario is %s',
    async (scenarioStatus) => {
      const f = await fixture({
        events: [
          { type: 'transcript', speaker: 'caller', text: '一箱お願いします。', atMs: 1000 },
          { type: 'transcript', speaker: 'agent', text: '一箱で承ります。', atMs: 2000 },
          { type: 'completed', atMs: 3000 },
        ],
      });
      f.task.rules.callerInstructions = '日本語でいちごを二箱注文してください。';
      f.task.rules.assertions = ['来电者下单两箱后，AI 客服正确确认两箱。'];
      const raw = JSON.parse(judgment());
      raw.assertions[0].scenario = {
        status: scenarioStatus,
        reason: '来电者实际说一箱，没有执行两箱场景。',
        evidenceIds: ['event:1'],
        audioAgreement: 'not_checked',
      };
      await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
      const report = await f.store.read<any>('calls/call1/evaluation.json', null);
      expect(report.overall).toBe('inconclusive');
      expect(report.judgment.assertions[0].status).toBe('inconclusive');
      expect(report.rawJudgment.assertions[0].status).toBe('fail');
      expect(f.store.findings).toHaveLength(0);
      expect(report.judgment.summary).toContain('0 项客服行为候选问题');
    },
  );

  it('requires actual caller evidence for a claimed observed premise instead of inferring it from the agent', async () => {
    const f = await fixture();
    const raw = JSON.parse(judgment());
    raw.assertions[0].scenario.evidenceIds = ['event:2'];
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.overall).toBe('inconclusive');
    expect(report.judgment.assertions[0].scenario.status).toBe('uncertain');
    expect(f.store.findings).toHaveLength(0);
  });

  it('reuses cached recording transcription and refuses agent blame when Live text says two but recorded speech says one', async () => {
    const f = await fixture({
      events: [
        { type: 'transcript', speaker: 'caller', text: '二箱お願いします。', atMs: 1000 },
        { type: 'transcript', speaker: 'agent', text: '一箱で承ります。', atMs: 2000 },
        { type: 'completed', atMs: 3000 },
      ],
    });
    f.task.rules.audioReview = true;
    f.task.rules.callerInstructions = '日本語でいちごを二箱注文してください。';
    f.task.rules.assertions = ['来电者两箱的订单被正确受理。'];
    const cache = await cachedAudio(f);
    cache.chunks[0]!.text = '一箱お願いします。';
    cache.chunks[1]!.text = '一箱で承ります。';
    await f.store.write('calls/call1/audio-review.json', cache);
    const asr = vi.spyOn(audioReview, 'transcribeRecording');
    const raw = JSON.parse(judgment());
    raw.assertions[0].evidenceIds = ['audio:agent:1'];
    raw.assertions[0].scenario = {
      status: 'observed',
      reason: 'Live写二箱，录音独立转写写一箱。',
      evidenceIds: ['event:1', 'audio:caller:1'],
      audioAgreement: 'conflicting',
    };
    const pi = fakePi(true, JSON.stringify(raw));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(asr).not.toHaveBeenCalled();
    expect(pi.complete.mock.calls[0]?.[0]).toContain('一箱お願いします。');
    expect(report.overall).toBe('inconclusive');
    expect(report.judgment.assertions[0].scenario.audioAgreement).toBe('conflicting');
    expect(report.version).toBe(3);
    expect(report.audioReview.chunks).toHaveLength(2);
    expect(f.store.findings).toHaveLength(0);
  });

  it('overrides a judge that incorrectly calls one-box versus two-box audio evidence consistent and unconditional', async () => {
    const f = await fixture({
      events: [
        { type: 'transcript', speaker: 'caller', text: '二箱お願いします。', atMs: 1000 },
        { type: 'transcript', speaker: 'agent', text: '一箱で承ります。', atMs: 2000 },
        { type: 'completed', atMs: 3000 },
      ],
    });
    f.task.rules.audioReview = true;
    f.task.rules.assertions = ['顧客のいちご2箱の注文が受け付けられる。'];
    const cache = await cachedAudio(f);
    cache.chunks[0]!.text = '一箱お願いします。';
    cache.chunks[1]!.text = '一箱で承ります。';
    await f.store.write('calls/call1/audio-review.json', cache);
    const raw = JSON.parse(judgment());
    raw.assertions[0].evidenceIds = ['audio:agent:1'];
    raw.assertions[0].scenario = {
      status: 'not_applicable',
      reason: 'Incorrect model assumption',
      evidenceIds: [],
      audioAgreement: 'consistent',
    };
    await evaluateCall(fakePi(true, JSON.stringify(raw)), f.store, f.task, f.call, f.emit);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.overall).toBe('inconclusive');
    expect(report.judgment.assertions[0].scenario.audioAgreement).toBe('conflicting');
    expect(report.numericConflicts).toHaveLength(1);
    expect(f.store.findings).toHaveLength(0);
  });

  it('uses saved Dograh evidence and context without local events or additional ASR', async () => {
    const f = await fixture({ withTranscript: false });
    f.call.runId = 821;
    f.task.rules.audioReview = true;
    await f.store.write('calls/call1/dograh-evidence.json', {
      transcript: [
        {
          id: 'dograh:1',
          speaker: 'caller',
          text: '西口をお願いします。',
          atMs: 1000,
          source: 'dograh_transcript',
        },
        {
          id: 'dograh:2',
          speaker: 'agent',
          text: '東口でお待ちください。',
          atMs: 2000,
          source: 'dograh_transcript',
        },
      ],
      gatheredContext: { destination: '西口' },
      recordings: { mixed: true, caller: true, agent: true },
      timingBasis: 'provider time',
    });
    const raw = JSON.parse(judgment());
    raw.assertions[0].evidenceIds = ['dograh:2'];
    raw.assertions[0].handling.evidenceIds = ['dograh:2'];
    raw.assertions[0].scenario.evidenceIds = ['dograh:1'];
    const pi = fakePi(true, JSON.stringify(raw));
    const asr = vi.spyOn(audioReview, 'transcribeRecording');
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(asr).not.toHaveBeenCalled();
    expect(pi.complete.mock.calls[0]?.[0]).toContain('"gatheredContext":{"destination":"西口"}');
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.status).toBe('complete');
    expect(report.source).toBe('pi_dograh_transcript_judge');
    expect(report.audioReview).toBeUndefined();
  });

  it('never submits a new transcription when a legacy audio cache is missing', async () => {
    const f = await fixture();
    f.task.rules.audioReview = true;
    const pi = fakePi(true, judgment());
    const asr = vi.spyOn(audioReview, 'transcribeRecording');
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(asr).not.toHaveBeenCalled();
    expect(pi.complete).not.toHaveBeenCalled();
    expect(f.call.evaluationStatus).toBe('unavailable');
  });

  it('does not silently fall back to Live-generated text if requested audio transcription fails', async () => {
    const f = await fixture();
    f.task.rules.audioReview = true;
    const pi = fakePi(true, judgment());
    vi.spyOn(audioReview, 'transcribeRecording').mockRejectedValue(new Error('独立录音转写不可用'));
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(pi.complete).not.toHaveBeenCalled();
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(f.store.findings).toHaveLength(0);
  });

  it('excludes text arriving after stop from automatic evidence while preserving it in parsed events', async () => {
    const f = await fixture({
      events: [
        ...transcript.slice(0, 2),
        {
          type: 'transcript',
          speaker: 'caller',
          atMs: 2500,
          text: '二箱に変えます。',
          afterStop: true,
        },
        { type: 'completed', atMs: 3000 },
      ],
    });
    const pi = fakePi(true, judgment());
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(pi.complete.mock.calls[0]?.[0]).not.toContain('二箱に変えます。');
    const parsed = parseTranscriptEvents(
      JSON.stringify({
        type: 'transcript',
        speaker: 'caller',
        atMs: 2500,
        text: '二箱に変えます。',
        afterStop: true,
      }),
    );
    expect(parsed.events[0]?.afterStop).toBe(true);
    expect(parsed.events[0]?.transcriptOrigin).toBe('model_output');
  });

  it('creates only candidate semantic findings grounded in real local events and bounds playback by the final event', async () => {
    const f = await fixture();
    const pi = fakePi(true, judgment());
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(f.call.evaluationStatus).toBe('complete');
    expect(f.store.findings).toHaveLength(1);
    const finding = f.store.findings[0]!;
    expect(finding.source).toBe('judge');
    expect(finding.state).toBe('candidate');
    expect(finding.startMs).toBe(0);
    expect(finding.endMs).toBe(3_000);
    expect(finding.endMs).toBeLessThan(f.call.durationSeconds * 1_000);
    expect(finding.evidence?.[0]).toContain('bridge-events.jsonl#L1');
    expect(finding.evidence?.[0]).toContain('providerStartMs=900000');
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.overall).toBe('fail');
    expect(report.durationBoundMs).toBe(3_000);
    expect(report.limitations.join('')).toContain('未通过此评审分析原始音频');
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(pi.complete).toHaveBeenCalledOnce();
    expect(f.store.findings).toHaveLength(1);
  });

  it('rejects hallucinated event IDs without publishing a finding or a pass', async () => {
    const f = await fixture();
    await evaluateCall(
      fakePi(true, judgment('fail', ['event:999'])),
      f.store,
      f.task,
      f.call,
      f.emit,
    );
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(f.store.findings).toEqual([]);
    expect(f.task.evaluationError).toContain('不存在');
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.overall).toBeNull();
    expect(f.events.some((event) => event.type === 'evaluation.complete')).toBe(false);
  });

  it('caps playback by WAV artifact duration even if usage finalization finishes much later', async () => {
    const f = await fixture({
      events: [
        ...transcript.slice(0, 2),
        { type: 'artifacts', atMs: 12_000, durationMs: 2_500 },
        { type: 'completed', atMs: 12_010 },
      ],
    });
    await evaluateCall(fakePi(true, judgment()), f.store, f.task, f.call, f.emit);
    expect(f.call.evaluationStatus).toBe('complete');
    expect(f.store.findings[0]!.endMs).toBe(2_500);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.durationBoundMs).toBe(2_500);
    expect(report.eventEndMs).toBe(12_010);
    expect(report.recordingDurationMs).toBe(2_500);
  });

  it('does not pass when every supporting Agent transcript arrives after the audio has ended', async () => {
    const f = await fixture({
      events: [
        transcript[0],
        { ...transcript[1], atMs: 6_000 },
        { type: 'artifacts', atMs: 10_000, durationMs: 3_000 },
        { type: 'completed', atMs: 10_010 },
      ],
    });
    await evaluateCall(fakePi(true, judgment('pass')), f.store, f.task, f.call, f.emit);
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(f.task.evaluationError).toContain('录音时段内双方转写不完整');
    expect(f.store.findings).toEqual([]);
  });

  it('rejects references to late legacy text instead of allowing mixed in-bound and after-recording evidence', async () => {
    const f = await fixture({
      events: [
        ...transcript.slice(0, 2),
        { ...transcript[1], atMs: 6_000, text: '追加の確認です。' },
        { type: 'artifacts', atMs: 10_000, durationMs: 3_000 },
        { type: 'completed', atMs: 10_010 },
      ],
    });
    await evaluateCall(
      fakePi(true, judgment('fail', ['event:2', 'event:3'])),
      f.store,
      f.task,
      f.call,
      f.emit,
    );
    expect(f.store.findings).toHaveLength(0);
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(f.task.evaluationError).toContain('不存在');
  });

  it('refuses to pass an assertion without agent evidence or when results omit an assertion', async () => {
    const f = await fixture();
    await evaluateCall(
      fakePi(true, judgment('pass', ['event:1'])),
      f.store,
      f.task,
      f.call,
      f.emit,
    );
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(f.task.evaluationError).toContain('Agent 发言证据');
    await evaluateCall(
      fakePi(true, JSON.stringify({ summary: 'All good', assertions: [] })),
      f.store,
      f.task,
      f.call,
      f.emit,
    );
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(f.task.evaluationError).toContain('漏掉');
  });

  it('marks missing connections or transcript data unavailable without sending paid evaluation requests', async () => {
    const f = await fixture({ withTranscript: false });
    const connected = fakePi();
    await evaluateCall(connected, f.store, f.task, f.call, f.emit);
    expect(f.call.evaluationStatus).toBe('unavailable');
    expect(connected.complete).not.toHaveBeenCalled();
    const disconnected = fakePi(false);
    await evaluateCall(disconnected, f.store, f.task, f.call, f.emit);
    expect(f.task.evaluationError).toContain('Pi 未连接');
    expect(disconnected.complete).not.toHaveBeenCalled();
  });

  it('does not invoke semantic evaluation for timer-only tasks', async () => {
    const f = await fixture();
    f.task.rules.assertions = [];
    const pi = fakePi();
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    expect(pi.status).not.toHaveBeenCalled();
    expect(pi.complete).not.toHaveBeenCalled();
    expect(f.call.evaluationStatus).toBeUndefined();
  });

  it('limits global evaluation concurrency to two while keeping additional calls queued', async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => fixture()));
    const pi = fakePi();
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    pi.complete.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return judgment('pass');
    });
    const calls = fixtures.map((f) => evaluateCall(pi, f.store, f.task, f.call, f.emit));
    await vi.waitFor(() => expect(pi.complete).toHaveBeenCalledTimes(2));
    expect(fixtures.every((f) => f.call.evaluationStatus === 'pending')).toBe(true);
    releases.shift()!();
    await vi.waitFor(() => expect(pi.complete).toHaveBeenCalledTimes(3));
    releases.shift()!();
    await vi.waitFor(() => expect(pi.complete).toHaveBeenCalledTimes(4));
    releases.shift()!();
    await vi.waitFor(() => expect(pi.complete).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());
    await Promise.all(calls);
    expect(maximum).toBe(2);
    expect(fixtures.every((f) => f.call.evaluationStatus === 'complete')).toBe(true);
  });

  it('redacts provider errors before writing local evaluation failures', async () => {
    const f = await fixture();
    f.store.settings.dograhApiKey = 'dograh-secret-value';
    const pi = fakePi();
    pi.complete.mockRejectedValueOnce(
      new Error('Failed using dograh-secret-value and sk-openai-secret'),
    );
    await evaluateCall(pi, f.store, f.task, f.call, f.emit);
    const report = await f.store.read<any>('calls/call1/evaluation.json', null);
    expect(report.error).not.toContain('dograh-secret-value');
    expect(report.error).not.toContain('sk-openai-secret');
    expect(f.call.evaluationStatus).toBe('unavailable');
  });

  it('rejects malformed transcript events and keeps provider clocks separate', () => {
    expect(() => parseTranscriptEvents('{"type":"transcript"')).toThrow('不完整');
    const result = parseTranscriptEvents(
      transcript.map((event) => JSON.stringify(event)).join('\n'),
    );
    expect(result.durationMs).toBe(3_000);
    expect(result.events[0]!.atMs).toBe(1_000);
    expect(result.events[0]!.providerStartMs).toBe(900_000);
    expect(() =>
      parseTranscriptEvents(
        JSON.stringify({ type: 'transcript', text: 'missing time', speaker: 'agent' }),
      ),
    ).toThrow('本地时间');
  });
});

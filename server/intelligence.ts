import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppEvent, CallRecord, Finding, TestRules, TestTask } from '../shared/types.js';
import type { DefinitionSnapshot } from './dograh.js';
import type { LocalStore } from './store.js';
import type { AudioReviewResult } from './audio-review.js';
import { ensureDograhEvidence, dograhParsedEvidence } from './dograh-evidence.js';
import { verifyCachedAudioReview } from './audio-review-cache.js';
import type { IntelligencePi } from './test-planning.js';
import {
  EVALUATION_LIMITATIONS,
  parseTranscriptEvents,
  prepareReviewEvidence,
  safeMessage,
  workflowPromptsForCall,
} from './evaluation-evidence.js';
import {
  assessEvaluation,
  buildEvaluationPrompt,
  parseEvaluationResponse,
  preserveManualReviews,
  rulesForEvaluation,
} from './evaluation-judgment.js';

// Keep the original module as the stable API for the application and existing integrations.
export {
  extractResponseTimeout,
  planRules,
  type IntelligencePi,
  type PlanRulesInput,
} from './test-planning.js';
export { parseTranscriptEvents, type TranscriptEvidence } from './evaluation-evidence.js';

let activeEvaluations = 0;
const evaluationQueue: Array<() => void> = [];
const inFlight = new Map<string, Promise<void>>();
const evaluationControllers = new Map<
  string,
  { storeDir: string; taskId: string; controller: AbortController }
>();
export function cancelEvaluations(store: LocalStore, taskId?: string): void {
  for (const item of evaluationControllers.values())
    if (item.storeDir === store.dir && (!taskId || item.taskId === taskId))
      item.controller.abort(new Error('评审已取消；已提交的模型请求可能已经产生费用。'));
}

async function withEvaluationSlot(work: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const acquire = () => {
      activeEvaluations++;
      resolve();
    };
    if (activeEvaluations < 2) acquire();
    else evaluationQueue.push(acquire);
  });
  try {
    await work();
  } finally {
    activeEvaluations--;
    evaluationQueue.shift()?.();
  }
}

function publish(emit: (event: AppEvent) => void, event: AppEvent): void {
  try {
    emit(event);
  } catch {
    /* UI disconnection does not invalidate persisted evidence. */
  }
}

export interface EvaluationOptions {
  force?: boolean;
  reuseAudioReview?: boolean;
  reviewRules?: TestRules;
}

/** Schedule semantic judging independently from the audio scheduler; global concurrency is two. */
export function evaluateCall(
  pi: IntelligencePi,
  store: LocalStore,
  task: TestTask,
  call: CallRecord,
  emit: (event: AppEvent) => void,
  options: EvaluationOptions = {},
): Promise<void> {
  const key = `${store.dir}:${call.id}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  if (!options.force && (!task.rules.assertions.length || call.evaluationStatus === 'complete'))
    return Promise.resolve();
  if (options.force && ['connecting', 'running'].includes(call.status))
    return Promise.reject(new Error('通话尚未结束，不能重新评审。'));
  const previousCall = structuredClone(call);
  const revisionId = randomUUID();
  const revisionPath = `calls/${call.id}/evaluation-revisions/${revisionId}`;
  let previousEvaluation: any = null;
  let previousAudioReview: unknown = null;
  let previousFindings: Finding[] = [];
  let reportReplaced = false;
  let findingsReplaced = false;
  const controller = new AbortController();
  const signal = controller.signal;
  evaluationControllers.set(key, { storeDir: store.dir, taskId: task.id, controller });
  const promise = (async () => {
    call.evaluationStatus = 'pending';
    await store.persist();
    publish(emit, { type: 'call.updated', call });
    await withEvaluationSlot(async () => {
      const generatedAt = new Date().toISOString();
      try {
        previousEvaluation = await store.read(`calls/${call.id}/evaluation.json`, null);
        previousFindings = structuredClone(
          store.findings.filter(
            (finding) => finding.callId === call.id && finding.source === 'judge',
          ),
        );
        if (options.force) {
          previousAudioReview = await store.read(`calls/${call.id}/audio-review.json`, null);
          await store.write(`${revisionPath}/before.json`, {
            revisionId,
            generatedAt,
            call: previousCall,
            evaluation: previousEvaluation,
            findings: previousFindings,
            audioReview: previousAudioReview,
          });
        }
        signal.throwIfAborted();
        if (!options.force && task.status === 'stopped')
          throw new Error('任务已停止，本次评审未继续提交模型请求。');
        const initialPiStatus = await pi.status();
        if (!initialPiStatus.configured)
          throw new Error('Pi 未连接，业务语义评审不可用；这不是通过结果。');
        const dograh = call.runId ? await ensureDograhEvidence(store, call) : null;
        let evidence;
        if (dograh) {
          evidence = dograhParsedEvidence(dograh, call.durationSeconds);
        } else {
          const filename = join(store.callDir(call.id), 'bridge-events.jsonl');
          let size: number;
          try {
            size = (await stat(filename)).size;
          } catch {
            throw new Error('缺少通话转写事件，业务语义评审不可用。');
          }
          if (size > 20_000_000) throw new Error('事件文件超过自动评审容量，未作通过判断。');
          evidence = parseTranscriptEvents(await readFile(filename, 'utf8'));
        }
        if (
          !evidence.events.length ||
          !evidence.events.some((event) => event.speaker === 'agent') ||
          !evidence.events.some((event) => event.speaker === 'caller')
        ) {
          throw new Error('双方转写不完整，业务语义评审不可用。');
        }
        const originalRules = await store.read<TestRules>(
          `calls/${call.id}/rules.json`,
          task.rules,
        );
        const rules = rulesForEvaluation(originalRules, options.reviewRules);
        if (!rules.assertions.length)
          throw new Error('该通话快照没有业务语义断言，不能按后来修改的规则判定。');
        const savedWorkflow = await store.read<DefinitionSnapshot | null>(
          `calls/${call.id}/workflow.json`,
          null,
        );
        const workflowPrompts = workflowPromptsForCall(savedWorkflow, call);
        let audioReview: AudioReviewResult | undefined;
        // Legacy calls can reuse verified cached ASR; never submit a new transcription.
        if (!dograh && rules.audioReview) {
          audioReview = await verifyCachedAudioReview(
            store.callDir(call.id),
            await store.read(`calls/${call.id}/audio-review.json`, null),
          );
        }
        const { reviewEvidence, numericConflicts } = prepareReviewEvidence(evidence, audioReview);
        const prompt = buildEvaluationPrompt({
          gatheredContext: dograh?.gatheredContext,
          rules,
          language: task.language,
          workflowPrompts,
          savedWorkflow,
          audioReview: !!audioReview,
          numericConflicts,
          reviewEvidence,
        });
        signal.throwIfAborted();
        const rawJudgment = parseEvaluationResponse(
          await pi.complete(prompt, AbortSignal.any([signal, AbortSignal.timeout(90_000)])),
        );
        signal.throwIfAborted();
        const { judgment, findings, overall } = assessEvaluation(rawJudgment, {
          task,
          call,
          rules,
          generatedAt,
          durationMs: evidence.durationMs,
          reviewEvidence,
          audioReview: !!audioReview,
          numericConflicts,
        });
        const limitations = [
          ...(dograh
            ? [
                '依据 Dograh 保存的转写和通话上下文评审。',
                dograh.timingBasis,
                'Gathered Context 是 Dograh 保存的上下文，不等于外部订单系统的持久化结果。',
              ]
            : EVALUATION_LIMITATIONS),
          ...(audioReview?.limitations ?? []),
          savedWorkflow
            ? '本次工作流快照仅用于核对处理规则，不能证明工具实际调用、后台失败原因或订单写入结果。'
            : '缺少本次通话的工作流快照，未核对预期异常分支；没有读取当前工作流替代。',
        ];
        const oldAssertions: string[] = Array.isArray(previousEvaluation?.rules?.assertions)
          ? previousEvaluation.rules.assertions
          : [];
        const currentOldFindings = store.findings.filter(
          (finding) => finding.callId === call.id && finding.source === 'judge',
        );
        const previousManualReviews = preserveManualReviews(
          findings,
          currentOldFindings,
          oldAssertions,
          rules.assertions,
        );
        const report = {
          version: 3,
          status: 'complete',
          overall,
          generatedAt,
          revisionId,
          source: dograh
            ? 'pi_dograh_transcript_judge'
            : audioReview
              ? 'pi_recording_crosscheck'
              : 'pi_transcript_judge',
          gatheredContext: dograh?.gatheredContext,
          modelSelectionAtStart: initialPiStatus.model,
          modelSelectionAtFinish: (await pi.status()).model,
          workflowHash: call.workflowHash ?? null,
          durationBoundMs: evidence.durationMs,
          eventEndMs: evidence.eventEndMs,
          recordingDurationMs: evidence.recordingDurationMs,
          timingBasis: dograh
            ? 'dograh_run_relative_timestamps'
            : audioReview
              ? 'audio_clip_bounds_and_local_transcript_arrival'
              : 'local_transcript_event_arrival',
          limitations,
          rules,
          originalRules,
          judgment,
          rawJudgment,
          evidence: reviewEvidence,
          findings,
          audioReview,
          numericConflicts,
          workflowSnapshot: savedWorkflow
            ? { hash: savedWorkflow.hash, createdAt: savedWorkflow.createdAt }
            : null,
          audioReviewReused: !!audioReview,
        };
        signal.throwIfAborted();
        if (options.force)
          await store.write(`${revisionPath}/after.json`, {
            revisionId,
            generatedAt,
            evaluation: report,
            findings,
            previousManualReviews,
          });
        await store.write(`calls/${call.id}/evaluation.json`, report);
        reportReplaced = true;
        previousFindings = structuredClone(currentOldFindings);
        store.findings = [
          ...findings,
          ...store.findings.filter(
            (finding) => finding.callId !== call.id || finding.source !== 'judge',
          ),
        ];
        findingsReplaced = true;
        call.evaluationStatus = 'complete';
        call.evaluationOverall = overall;
        task.resultRevision = (task.resultRevision ?? 0) + 1;
        if (task.evaluationError?.startsWith(`[${call.id}]`)) delete task.evaluationError;
        await store.persist();
        await store.write(`calls/${call.id}/evaluation-attempt.json`, {
          version: 3,
          revisionId,
          status: 'complete',
          generatedAt,
          completedAt: new Date().toISOString(),
          preservedPrevious: false,
        });
        for (const finding of findings) publish(emit, { type: 'finding.created', finding });
        publish(emit, { type: 'state.changed' });
        publish(emit, {
          type: 'evaluation.complete',
          taskId: task.id,
          callId: call.id,
          overall,
          summary: judgment.summary,
          limitations,
        });
        publish(emit, { type: 'call.updated', call });
      } catch (error) {
        const message = safeMessage(error, [
          store.settings.dograhApiKey,
          store.settings.dograhLoginToken ?? '',
          store.settings.openaiApiKey,
        ]);
        const preservedPrevious =
          !!options.force && (previousEvaluation !== null || previousFindings.length > 0);
        if (options.force && findingsReplaced)
          store.findings = [
            ...previousFindings,
            ...store.findings.filter(
              (finding) => finding.callId !== call.id || finding.source !== 'judge',
            ),
          ];
        if (options.force && reportReplaced && previousEvaluation !== null)
          await store.write(`calls/${call.id}/evaluation.json`, previousEvaluation);
        call.evaluationStatus = preservedPrevious
          ? (previousCall.evaluationStatus ??
            (previousEvaluation?.status === 'complete' ? 'complete' : 'unavailable'))
          : 'unavailable';
        call.evaluationOverall = preservedPrevious ? previousCall.evaluationOverall : undefined;
        if (!preservedPrevious) task.resultRevision = (task.resultRevision ?? 0) + 1;
        task.evaluationError = `[${call.id}] ${message}`;
        const attempt = {
          version: 3,
          revisionId,
          status: 'failed',
          generatedAt,
          completedAt: new Date().toISOString(),
          preservedPrevious,
          error: message,
        };
        await store.write(`calls/${call.id}/evaluation-attempt.json`, attempt);
        if (options.force) await store.write(`${revisionPath}/error.json`, attempt);
        if (!preservedPrevious)
          await store.write(`calls/${call.id}/evaluation.json`, {
            version: 3,
            status: 'unavailable',
            overall: null,
            generatedAt,
            error: message,
            limitations: EVALUATION_LIMITATIONS,
            workflowHash: call.workflowHash ?? null,
          });
        await store.persist();
        publish(emit, {
          type: 'evaluation.unavailable',
          taskId: task.id,
          callId: call.id,
          message,
        });
        publish(emit, { type: 'call.updated', call });
      }
    });
  })().finally(() => {
    inFlight.delete(key);
    evaluationControllers.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

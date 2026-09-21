import type { Express } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppEvent, TestRules } from '../shared/types.js';
import type { LocalStore } from './store.js';
import { listPromptFields, type DefinitionSnapshot } from './dograh.js';
import { connectionSecrets } from './connection.js';
import { safeError } from './runner.js';
import { planRules, evaluateCall, type IntelligencePi } from './intelligence.js';
import { ensureDograhEvidence, ensureDograhRecording } from './dograh-evidence.js';
import { verifyCachedAudioReview } from './audio-review-cache.js';

interface CallRouteDependencies {
  store: LocalStore;
  pi: IntelligencePi;
  emit: (event: AppEvent) => void;
  isClosing: () => boolean;
  settingsFingerprint: () => string;
  /** Shared with task creation, so saved rules have the same accepted shape. */
  ruleSchema: z.ZodType<TestRules>;
}

/** Own call evidence and re-review state; the application owns authentication and shutdown. */
export function createCallRoutes(dependencies: CallRouteDependencies) {
  const { store, pi, emit, isClosing, settingsFingerprint, ruleSchema } = dependencies;
  const reviewLocks = new Set<string>();
  const reviewControllers = new Map<string, { taskId: string; controller: AbortController }>();
  const cancelReviews = (taskId?: string) => {
    for (const review of reviewControllers.values())
      if (!taskId || review.taskId === taskId)
        review.controller.abort(new Error('已停止本次重新评审。'));
  };

  function isReviewing(callId?: string): boolean {
    return callId === undefined ? reviewLocks.size > 0 : reviewLocks.has(callId);
  }

  async function evidence(callId: string) {
    const call = store.calls.find((c) => c.id === callId);
    if (!call) throw new Error('通话不存在。');
    const raw = await fs
      .readFile(path.join(store.callDir(call.id), 'bridge-events.jsonl'), 'utf8')
      .catch(() => '');
    const events = raw
      .split('\n')
      .filter(Boolean)
      .slice(-12000)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const evaluation = await store.read(`calls/${call.id}/evaluation.json`, null);
    const evaluationAttempt = await store.read(`calls/${call.id}/evaluation-attempt.json`, null);
    const manualAudioReview = await store.read(`calls/${call.id}/audio-review-manual.json`, null);
    const task = store.tasks.find((t) => t.id === call.taskId);
    const dograhRunUrl =
      task?.connectionFingerprint === settingsFingerprint() &&
      store.settings.dograhBaseUrl &&
      Number.isSafeInteger(call.workflowId) &&
      call.workflowId > 0 &&
      Number.isSafeInteger(call.runId) &&
      call.runId! > 0
        ? new URL(`/workflow/${call.workflowId}/run/${call.runId}`, store.settings.dograhBaseUrl)
            .href
        : null;
    let dograh = null;
    let dograhError: string | null = null;
    if (call.runId && !['connecting', 'running'].includes(call.status)) {
      try {
        dograh = await ensureDograhEvidence(store, call);
      } catch {
        dograhError = 'Dograh 转写暂不可用；请稍后重新打开通话。';
      }
    }
    return {
      dograh,
      dograhError,
      call,
      events,
      evaluation,
      evaluationAttempt,
      reviewPending: isReviewing(call.id),
      manualAudioReview,
      dograhRunUrl,
      findings: store.findings.filter((f) => f.callId === call.id),
      task,
    };
  }

  /** Register after the application's local-host, origin, CSRF and JSON middleware. */
  function register(app: Express): void {
    app.get('/api/calls/:id', async (req, res) => res.json(await evidence(String(req.params.id))));
    app.post('/api/calls/:id/review', async (req, res) => {
      const input = z
        .object({ realignToRequirement: z.boolean().default(true) })
        .strict()
        .parse(req.body ?? {});
      const call = store.calls.find((c) => c.id === req.params.id);
      if (!call) return res.status(404).json({ error: '通话不存在。' });
      const task = store.tasks.find((t) => t.id === call.taskId);
      if (!task) throw new Error('通话所属任务不存在。');
      if (isClosing()) throw new Error('应用正在停止。');
      if (call.status !== 'completed') throw new Error('仅支持重新评审已完成的通话。');
      if (call.versionIntegrity !== 'checked')
        throw new Error('该通话的工作流版本尚未核对或已发生变化，不能按保存的提示词重新评审。');
      if (isReviewing(call.id) || call.evaluationStatus === 'pending')
        throw new Error('这通电话正在评审，请等待完成。');
      reviewLocks.add(call.id);
      emit({ type: 'state.changed' });
      const controller = new AbortController();
      reviewControllers.set(call.id, { taskId: task.id, controller });
      const generatedAt = new Date().toISOString();
      try {
        const original = ruleSchema.safeParse(
          await store.read(`calls/${call.id}/rules.json`, null),
        );
        if (!original.success) throw new Error('缺少有效的通话测试条件快照，无法重新评审。');
        // Verify that re-review can reuse the exact recording before any model request.
        if (call.runId) await ensureDograhEvidence(store, call);
        if (!call.runId && original.data.audioReview)
          await verifyCachedAudioReview(
            store.callDir(call.id),
            await store.read(`calls/${call.id}/audio-review.json`, null),
          );
        let reviewRules: TestRules = original.data;
        if (input.realignToRequirement) {
          const snapshot = await store.read<DefinitionSnapshot | null>(
            `calls/${call.id}/workflow.json`,
            null,
          );
          if (
            snapshot &&
            (snapshot.workflowId !== call.workflowId ||
              (call.workflowHash && snapshot.hash !== call.workflowHash) ||
              !snapshot.workflow?.workflow_definition)
          )
            throw new Error('通话工作流快照不匹配，无法重新整理检查项。');
          controller.signal.throwIfAborted();
          const planned = await planRules(pi, {
            requirement: task.requirement,
            language: task.language,
            responseTimeoutSeconds: original.data.responseTimeoutSeconds,
            workflowPrompts: snapshot ? listPromptFields(snapshot.workflow) : [],
            signal: controller.signal,
          });
          if (!planned.assertions.length)
            throw new Error('Pi 未生成可评审的业务目标，原报告已保留。');
          reviewRules = {
            ...original.data,
            assertions: planned.assertions,
            interpretation: planned.interpretation,
          };
        }
        if (isClosing()) throw new Error('应用正在停止，未继续评审。');
        controller.signal.throwIfAborted();
        await evaluateCall(pi, store, task, call, emit, {
          force: true,
          reuseAudioReview: true,
          reviewRules,
        });
        const attempt = await store.read<{ status?: string; error?: string } | null>(
          `calls/${call.id}/evaluation-attempt.json`,
          null,
        );
        if (attempt?.status === 'failed')
          return res
            .status(409)
            .json({ error: attempt.error ?? '本次重新评审未完成，原报告已保留。' });
        if (attempt?.status !== 'complete')
          throw new Error('重新评审未生成完整报告，请检查通话证据。');
        res.json({ ok: true });
      } catch (error) {
        const message = safeError(error, connectionSecrets(store.settings));
        await store.write(`calls/${call.id}/evaluation-attempt.json`, {
          version: 3,
          status: 'failed',
          generatedAt,
          completedAt: new Date().toISOString(),
          preservedPrevious: true,
          error: message,
        });
        throw new Error(message);
      } finally {
        reviewLocks.delete(call.id);
        reviewControllers.delete(call.id);
        emit({ type: 'state.changed' });
      }
    });
    app.get('/api/calls/:id/dograh-audio/:track', async (req, res) => {
      const call = store.calls.find((c) => c.id === req.params.id);
      if (!call) return res.status(404).end();
      const track = z.enum(['caller', 'agent', 'mixed']).parse(req.params.track);
      try {
        const file = await ensureDograhRecording(store, call, track);
        res.sendFile(path.basename(file), { root: store.callDir(call.id) }, (error) => {
          if (!error || res.destroyed) return;
          if (res.headersSent) {
            res.end();
            return;
          }
          res.status(500).json({ error: 'Dograh 录音暂时无法读取。' });
        });
      } catch {
        res.status(502).json({ error: 'Dograh 录音暂不可用，可切换到本地录音。' });
      }
    });
    app.get('/api/calls/:id/audio/:track', async (req, res) => {
      const call = store.calls.find((c) => c.id === req.params.id);
      if (!call) return res.status(404).end();
      const track = z.enum(['caller', 'agent', 'mixed']).parse(req.params.track);
      const file = path.join(store.callDir(call.id), `${track}.wav`);
      if (!(await fs.stat(file).catch(() => null)))
        return res.status(404).json({ error: '录音尚未就绪。' });
      // The trusted data root commonly contains .tantei. Resolve only the selected
      // WAV under that root so sendFile doesn't reject a hidden ancestor directory.
      res.sendFile(`${track}.wav`, { root: store.callDir(call.id) }, (error) => {
        if (!error || res.destroyed) return;
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = (error as NodeJS.ErrnoException & { statusCode?: number }).statusCode;
        res
          .status(status === 416 ? 416 : status === 404 ? 404 : 500)
          .json({ error: status === 416 ? '录音请求范围无效。' : '录音暂时无法读取，请重试。' });
      });
    });
  }

  return { register, evidence, isReviewing, cancelReviews };
}

import { JevEvaluator } from './jev.js';
import express, { type Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStore } from './store.js';
import { Scheduler } from './scheduler.js';
import { AudioRunner, audioAvailable, safeError } from './runner.js';
import {
  DograhClient,
  listPromptFields,
  normalizeApiBaseUrl,
  type DefinitionSnapshot,
} from './dograh.js';
import { normalizeDograhCredential } from './dograh-auth.js';
import { environmentFlags, readEnvironmentConfig, type EnvironmentConfig } from './environment.js';
import { PiService, type PiToolSpec } from './pi.js';
import {
  dograhAuthMode,
  dograhCredential,
  dograhClientConfig,
  settingsFingerprint,
  connectionSecrets,
  updateDograhConnection,
} from './connection.js';
import { planRules, evaluateCall, cancelEvaluations } from './intelligence.js';
import { createCallRoutes } from './call-routes.js';
import { generateTaskSummary } from './task-summary.js';
import { MAX_CONFIGURABLE_CONCURRENCY } from '../shared/limits.js';
import type { AppEvent, TestTask } from '../shared/types.js';

const ruleSchema = z.object({
  callerInstructions: z.string().min(10).max(24000),
  responseTimeoutSeconds: z.number().min(1).max(300).nullable(),
  assertions: z.array(z.string().min(1).max(2000)).max(8),
  interpretation: z.string().max(12000),
  source: z.enum(['pi', 'manual']),
  audioReview: z.boolean().optional(),
});
const taskSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workflowId: z.number().int().positive(),
  workflowName: z.string().max(200),
  requirement: z.string().trim().min(1).max(12000),
  language: z.string().min(1).max(60),
  concurrency: z.number().int().min(1).max(MAX_CONFIGURABLE_CONCURRENCY),
  maxCalls: z.number().int().min(1).max(1000),
  maxDurationSeconds: z.number().int().min(20).max(900),
  maxVoiceMinutes: z.number().min(1).max(10000),
  rules: ruleSchema,
});
const changesSchema = z
  .array(
    z.object({
      nodeId: z.string(),
      path: z.string(),
      before: z.string(),
      after: z.string().max(60000),
    }),
  )
  .min(1)
  .max(30);
export interface AppOptions {
  dataDir: string;
  port: number;
  audioCheck?: () => Promise<boolean>;
  environment?: EnvironmentConfig;
}

export async function createWorkbench(options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const store = new LocalStore(options.dataDir);
  await store.init();
  const supplied = options.environment ?? {};
  const environment = readEnvironmentConfig({
    DOGRAH_BASE_URL: supplied.dograhBaseUrl,
    DOGRAH_LOGIN_TOKEN: supplied.dograhLoginToken,
    OPENAI_API_KEY: supplied.openaiApiKey,
    PI_OPENAI_API_KEY: supplied.piOpenaiApiKey,
    PI_ANTHROPIC_API_KEY: supplied.piAnthropicApiKey,
    TYPESAFE_API_KEY: supplied.typesafeApiKey,
  });
  store.configureEnvironment(environment);
  const csrfToken = randomBytes(32).toString('hex');
  const clients = new Set<Response>();
  const emit = (event: AppEvent) => {
    for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  let audioReady = await (options.audioCheck ?? audioAvailable)();
  let editScope: number | undefined;
  let chatRunning = false;
  let closing = false;
  const snapshots = new Map<string, DefinitionSnapshot>();
  const workflowLocks = new Set<number>();
  const summaryLocks = new Set<string>();
  const client = () => new DograhClient(dograhClientConfig(store.settings));
  const changed = () => {
    void store.persist().catch((e) => emit({ type: 'notice', message: safeError(e) }));
    emit({ type: 'state.changed' });
  };
  const assertConnected = () => {
    if (
      !dograhCredential(store.settings) ||
      !store.settings.dograhBaseUrl ||
      !store.settings.openaiApiKey
    )
      throw new Error('请先配置 Dograh 连接与 GPT-Live 1 API Key。');
    if (!audioReady)
      throw new Error('音频依赖尚未就绪，请运行 npm run setup:audio 后重新检查连接。');
  };
  async function startTask(input: z.infer<typeof taskSchema>) {
    if (closing) throw new Error('应用正在停止。');
    assertConnected();
    if (workflowLocks.has(input.workflowId))
      throw new Error('该工作流正在更新，完成后再启动测试。');
    if (input.maxVoiceMinutes * 60 < input.maxDurationSeconds)
      throw new Error('语音分钟上限至少需要容纳一通完整电话。');
    const fingerprint = settingsFingerprint(store.settings);
    const snapshot = await client().snapshotWorkflow(input.workflowId);
    if (fingerprint !== settingsFingerprint(store.settings))
      throw new Error('读取工作流期间连接发生变化，请重试。');
    const task: TestTask = {
      ...input,
      workflowName: snapshot.workflow.name,
      id: randomUUID(),
      status: 'running',
      createdAt: new Date().toISOString(),
      completedCalls: 0,
      failedCalls: 0,
      consumedSeconds: 0,
      workflowHash: snapshot.hash,
      connectionFingerprint: settingsFingerprint(store.settings),
    };
    if (workflowLocks.has(input.workflowId)) throw new Error('该工作流正在更新，请稍后重试。');
    await store.write(`tasks/${task.id}/baseline.json`, snapshot);
    store.tasks.unshift(task);
    await store.persist();
    scheduler.pump();
    return task;
  }
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  const tools: PiToolSpec[] = [
    {
      name: 'get_test_findings',
      description:
        'Read local test tasks, counts and candidate/confirmed findings. Optional task ID filters evidence.',
      parameters: object({ taskId: { type: 'string' } }),
      async execute(args) {
        const tasks = store.tasks.filter((t) => !args.taskId || t.id === args.taskId);
        return {
          tasks,
          findings: store.findings
            .filter((f) => !args.taskId || f.taskId === args.taskId)
            .slice(0, 150),
        };
      },
    },
    {
      name: 'get_call_evidence',
      description:
        'Read time-aligned transcript and timing evidence for one call. Transcript times are local receive times unless explicitly marked. No audio semantic analysis is implied.',
      parameters: object({ callId: { type: 'string' } }, ['callId']),
      async execute(args) {
        const e = await callRoutes.evidence(z.string().parse(args.callId));
        return {
          ...e,
          events: e.events
            .filter((x: any) =>
              [
                'transcript',
                'speech_started',
                'speech_ended',
                'metric',
                'finding',
                'completed',
              ].includes(x.type),
            )
            .slice(-500),
        };
      },
    },
    {
      name: 'read_workflow_prompts',
      description:
        'Read current workflow prompt fields and retain a baseline snapshot for preview/apply. Never returns API credentials.',
      parameters: object({ workflowId: { type: 'integer' } }, ['workflowId']),
      async execute(args) {
        const id = z.number().int().positive().parse(args.workflowId);
        const snapshot = await client().snapshotWorkflow(id);
        const snapshotId = randomUUID();
        snapshots.set(snapshotId, snapshot);
        return {
          snapshotId,
          workflowId: id,
          hash: snapshot.hash,
          name: snapshot.workflow.name,
          fields: listPromptFields(snapshot.workflow),
        };
      },
    },
    {
      name: 'preview_prompt_changes',
      description:
        'Preview precise before/after edits against a retained workflow snapshot. Does not save.',
      parameters: object(
        {
          snapshotId: { type: 'string' },
          changes: {
            type: 'array',
            items: object(
              {
                nodeId: { type: 'string' },
                path: { type: 'string' },
                before: { type: 'string' },
                after: { type: 'string' },
              },
              ['nodeId', 'path', 'before', 'after'],
            ),
          },
        },
        ['snapshotId', 'changes'],
      ),
      async execute(args) {
        const snapshot = snapshots.get(String(args.snapshotId));
        if (!snapshot) throw new Error('请先读取工作流基线。');
        const preview = client().previewPromptChanges(snapshot, changesSchema.parse(args.changes));
        return {
          workflowId: preview.workflowId,
          baselineHash: preview.baselineHash,
          changes: preview.changes,
        };
      },
    },
    {
      name: 'apply_prompt_changes',
      description:
        'Save narrow prompt changes to the explicitly authorized workflow draft. Pauses its tasks and waits for current calls to finish, checks baseline, backs up, verifies readback. Never publishes. Requires this chat turn permission.',
      parameters: object(
        {
          snapshotId: { type: 'string' },
          changes: {
            type: 'array',
            items: object(
              {
                nodeId: { type: 'string' },
                path: { type: 'string' },
                before: { type: 'string' },
                after: { type: 'string' },
              },
              ['nodeId', 'path', 'before', 'after'],
            ),
          },
        },
        ['snapshotId', 'changes'],
      ),
      async execute(args, { signal }) {
        const snapshot = snapshots.get(String(args.snapshotId));
        if (!snapshot) throw new Error('请先读取工作流基线。');
        if (editScope !== snapshot.workflowId)
          throw new Error(
            '本轮对话没有获得修改此工作流草稿的授权。请在界面选中对应任务并开启授权。',
          );
        if (workflowLocks.has(snapshot.workflowId)) throw new Error('该工作流已有更新操作。');
        const changes = changesSchema.parse(args.changes);
        client().previewPromptChanges(snapshot, changes);
        workflowLocks.add(snapshot.workflowId);
        try {
          for (const t of store.tasks)
            if (t.workflowId === snapshot.workflowId && t.status === 'running') {
              t.status = 'paused';
              t.pauseReason = 'Pi 更新前暂停；当前通话完成后保存草稿。更新后请启动新版本回归。';
            }
          changed();
          while (
            store.tasks.some(
              (t) => t.workflowId === snapshot.workflowId && scheduler.count(t.id) > 0,
            )
          ) {
            if (signal?.aborted) throw new Error('修改已取消。');
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (signal?.aborted) throw new Error('修改已取消。');
          const auditId = randomUUID();
          await store.write(`edits/${auditId}/before.json`, snapshot);
          await store.write(`edits/${auditId}/changes.json`, changes);
          const result = await client().applyPromptChanges(snapshot, changes);
          await store.write(`edits/${auditId}/after.json`, result.after);
          snapshots.delete(String(args.snapshotId));
          emit({ type: 'workflow.updated', workflowId: snapshot.workflowId, auditId });
          return {
            workflowId: snapshot.workflowId,
            auditId,
            changes,
            hash: result.after.hash,
            verified: result.verified,
            atomic: result.atomic,
            message:
              '已保存草稿并验证；未发布。旧任务保持暂停，请在界面点「新版本回归」使用原预算创建新任务。',
          };
        } finally {
          workflowLocks.delete(snapshot.workflowId);
        }
      },
    },
  ];
  const pi = new PiService({
    dataDir: store.dir,
    emit,
    tools,
    environmentApiKey: environment.piOpenaiApiKey,
    environmentAnthropicApiKey: environment.piAnthropicApiKey,
  });
  const callRoutes = createCallRoutes({
    store,
    pi,
    emit,
    isClosing: () => closing,
    settingsFingerprint: () => settingsFingerprint(store.settings),
    ruleSchema,
  });
  const jev = new JevEvaluator(store, store.settings.typesafeApiKey, emit);
  const runner = new AudioRunner(store, emit, async (task, call) => {
    await Promise.all([evaluateCall(pi, store, task, call, emit), jev.evaluate(task, call)]);
  });
  const scheduler = new Scheduler({
    tasks: () => store.tasks,
    limit: () => store.settings.maxConcurrency,
    execute: runner.execute.bind(runner),
    onChange: changed,
    onCall: (call) => {
      store.calls.unshift(call);
      emit({ type: 'call.updated', call });
    },
  });
  app.use((req, res, next) => {
    const host = req.headers.host;
    const allowed = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
    if (!host || !allowed.has(host)) return res.status(403).json({ error: '仅支持本机访问。' });
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`]).has(origin)
    )
      return res.status(403).json({ error: '跨站请求已拒绝。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers['x-tantei-token'] !== csrfToken
    )
      return res.status(403).json({ error: '本地会话已更新，请刷新页面。' });
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/state', async (_req, res) =>
    res.json({
      csrfToken,
      tasks: store.tasks,
      calls: store.calls,
      findings: store.findings,
      activeCalls: scheduler.activeCount,
      summaryRunningTaskIds: [...summaryLocks],
      audioReady,
      pi: await pi.status(),
      settings: {
        dograhBaseUrl: store.settings.dograhBaseUrl,
        dograhKeySet: !!dograhCredential(store.settings, 'apiKey'),
        dograhAuthMode: dograhAuthMode(store.settings),
        dograhTokenSet: !!dograhCredential(store.settings, 'token'),
        dograhCredentialSet: !!dograhCredential(store.settings),
        openaiKeySet: !!store.settings.openaiApiKey,
        typesafeKeySet: jev.configured,
        maxConcurrency: store.settings.maxConcurrency,
        voice: store.settings.voice,
        dataDir: store.dir,
        environment: environmentFlags(environment),
      },
    }),
  );
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.add(res);
    res.write('data: {"type":"connected"}\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clients.delete(res);
      clearInterval(heartbeat);
    });
  });
  app.post('/api/settings', async (req, res) => {
    if (
      scheduler.activeCount ||
      workflowLocks.size ||
      summaryLocks.size ||
      chatRunning ||
      callRoutes.isReviewing()
    )
      throw new Error('请先结束当前通话和 Pi 操作，再修改连接。');
    const input = z
      .object({
        dograhBaseUrl: z.string().max(2000),
        dograhAuthMode: z.literal('token').default('token'),
        dograhLoginToken: z.string().max(16384).optional(),
        openaiApiKey: z.string().max(1000).optional(),
        maxConcurrency: z.number().int().min(1).max(MAX_CONFIGURABLE_CONCURRENCY),
        voice: z.enum(['marin', 'cedar']),
      })
      .parse(req.body);
    if (
      environment.dograhBaseUrl &&
      normalizeApiBaseUrl(input.dograhBaseUrl) !== environment.dograhBaseUrl
    )
      throw new Error('Dograh 地址由 .env / 环境变量管理，请修改配置后重启。');
    if (
      environment.dograhLoginToken &&
      store.settings.dograhBaseUrl &&
      normalizeApiBaseUrl(input.dograhBaseUrl) !== normalizeApiBaseUrl(store.settings.dograhBaseUrl)
    )
      throw new Error(
        'Dograh Token 已从 .env / 环境变量加载；更换服务器请一起修改 DOGRAH_BASE_URL 和 DOGRAH_LOGIN_TOKEN 后重启。',
      );
    if (
      environment.dograhLoginToken &&
      input.dograhLoginToken?.trim() &&
      normalizeDograhCredential('token', input.dograhLoginToken) !== environment.dograhLoginToken
    )
      throw new Error('Dograh Token 由 .env / 环境变量管理，请修改配置后重启。');
    if (
      environment.openaiApiKey &&
      input.openaiApiKey?.trim() &&
      input.openaiApiKey.trim() !== environment.openaiApiKey
    )
      throw new Error('GPT-Live 1 API Key 由 .env / 环境变量管理，请修改配置后重启。');
    store.settings = {
      ...updateDograhConnection(store.settings, {
        ...input,
        dograhLoginToken: environment.dograhLoginToken ?? input.dograhLoginToken,
      }),
      openaiApiKey:
        environment.openaiApiKey || input.openaiApiKey?.trim() || store.settings.openaiApiKey,
      maxConcurrency: input.maxConcurrency,
      voice: input.voice,
    };
    snapshots.clear();
    await store.saveSettings();
    emit({ type: 'state.changed' });
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/jev-evaluate', async (req, res) => {
    if (closing) throw new Error('应用正在停止。');
    if (!jev.configured) throw new Error('请先配置 TYPESAFE_API_KEY。');
    const task = store.tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在。' });
    const calls = store.calls.filter(
      (c) => c.taskId === task.id && c.status === 'completed' && c.versionIntegrity === 'checked',
    );
    await Promise.all(calls.map((call) => jev.evaluate(task, call)));
    res.json({ results: calls.map((call) => ({ runId: call.runId, ...call.jevEvaluation })) });
  });
  app.post('/api/settings/jev', async (req, res) => {
    if (jev.busy) throw new Error('请等待 Jev 完成当前评估，再修改设置。');
    const input = z
      .object({ apiKey: z.string().max(16384).optional() })
      .strict()
      .parse(req.body);
    const key = readEnvironmentConfig({ TYPESAFE_API_KEY: input.apiKey }).typesafeApiKey;
    if (environment.typesafeApiKey && key && key !== environment.typesafeApiKey)
      throw new Error('Jev API Key 由 .env / 环境变量管理，请修改配置后重启。');
    if (key && !environment.typesafeApiKey) {
      const previous = store.settings.typesafeApiKey;
      store.settings.typesafeApiKey = key;
      try {
        await store.saveSettings();
      } catch {
        store.settings.typesafeApiKey = previous;
        throw new Error('Jev 设置保存失败，请重试。');
      }
      jev.setApiKey(key);
    }
    res.json({ configured: jev.configured });
  });
  app.post('/api/settings/concurrency', async (req, res) => {
    const input = z
      .object({
        maxConcurrency: z.number().int().min(1).max(MAX_CONFIGURABLE_CONCURRENCY),
      })
      .strict()
      .parse(req.body);
    if (input.maxConcurrency < scheduler.activeCount)
      throw new Error(`当前有 ${scheduler.activeCount} 路正在通话，并发上限不能低于当前占用。`);
    store.settings.maxConcurrency = input.maxConcurrency;
    await store.saveSettings();
    scheduler.pump();
    emit({ type: 'state.changed' });
    res.json({ ok: true, maxConcurrency: input.maxConcurrency });
  });
  app.get('/api/workflows', async (_req, res) =>
    res.json({ workflows: await client().listWorkflows() }),
  );
  app.post('/api/connection/check', async (_req, res) => {
    audioReady = await (options.audioCheck ?? audioAvailable)();
    res.json({ workflows: await client().listWorkflows(), audioReady });
  });
  app.post('/api/audio/check', async (_req, res) => {
    audioReady = await (options.audioCheck ?? audioAvailable)();
    emit({ type: 'state.changed' });
    res.json({ audioReady });
  });
  app.post('/api/tasks/plan', async (req, res) => {
    const input = z
      .object({
        requirement: z.string().min(1).max(12000),
        language: z.string().min(1).max(60),
        workflowId: z.number().int().positive(),
        responseTimeoutSeconds: z.number().min(1).max(300).nullable().optional(),
      })
      .parse(req.body);
    const workflow = await client().getWorkflow(input.workflowId);
    res.json({
      rules: await planRules(pi, { ...input, workflowPrompts: listPromptFields(workflow) }),
    });
  });
  app.post('/api/tasks', async (req, res) => res.json(await startTask(taskSchema.parse(req.body))));
  app.post('/api/tasks/:id/summary', async (req, res) => {
    const task = store.tasks.find((item) => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在。' });
    if (summaryLocks.has(task.id)) throw new Error('Pi 正在生成这项任务的本轮汇总。');
    if (!(await pi.status()).configured) throw new Error('请先连接 Pi，再生成本轮汇总。');
    summaryLocks.add(task.id);
    emit({ type: 'state.changed' });
    try {
      const summary = await generateTaskSummary(pi, task, store.calls, store.findings);
      if (task.summary)
        await store.write(
          `tasks/${task.id}/summary-revisions/${task.summary.revisionId}.json`,
          task.summary,
        );
      await store.write(`tasks/${task.id}/summary.json`, summary);
      task.summary = summary;
      await store.persist();
      emit({ type: 'state.changed' });
      res.json({ summary });
    } finally {
      summaryLocks.delete(task.id);
      emit({ type: 'state.changed' });
    }
  });
  app.post('/api/tasks/:id/action', async (req, res) => {
    const task = store.tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在。' });
    const action = z
      .enum(['pause', 'resume', 'stop', 'cancel', 'regression', 'delete'])
      .parse(req.body.action);
    if (action === 'delete') {
      if (!['completed', 'stopped'].includes(task.status))
        throw new Error('请先停止测试任务，再删除。');
      if (
        chatRunning ||
        summaryLocks.size ||
        callRoutes.isReviewing() ||
        jev.busy ||
        store.calls.some(
          (call) =>
            call.taskId === task.id &&
            (['connecting', 'running'].includes(call.status) ||
              call.evaluationStatus === 'pending'),
        )
      )
        throw new Error('请等待通话和评审结束，再删除任务。');
      await pi.deleteTaskConversation(task.id);
      const previous = { tasks: store.tasks, calls: store.calls, findings: store.findings };
      store.tasks = store.tasks.filter((item) => item.id !== task.id);
      store.calls = store.calls.filter((item) => item.taskId !== task.id);
      store.findings = store.findings.filter((item) => item.taskId !== task.id);
      try {
        await store.persist();
      } catch (error) {
        Object.assign(store, previous);
        throw error;
      }
      emit({ type: 'task.deleted', taskId: task.id });
      return res.json({ deleted: true });
    }
    if (action === 'regression') {
      if (task.connectionFingerprint !== settingsFingerprint(store.settings))
        throw new Error('当前账号连接已改变，请重新选择工作流并创建新任务。');
      return res.json(await startTask(taskSchema.parse({ ...task, name: `${task.name} · 回归` })));
    }
    if (action === 'pause') {
      task.status = 'paused';
      task.pauseReason = '已暂停安排新通话；当前通话继续完成。';
    }
    if (action === 'stop' || action === 'cancel') {
      scheduler.stop(task.id, action === 'cancel');
      callRoutes.cancelReviews(task.id);
      cancelEvaluations(store, task.id);
      jev.cancel(task.id);
    }
    if (action === 'resume') {
      assertConnected();
      if (workflowLocks.has(task.workflowId)) throw new Error('该工作流正在更新。');
      if (task.completedCalls + task.failedCalls >= task.maxCalls)
        throw new Error('次数已用完，请创建回归任务。');
      if (task.connectionFingerprint !== settingsFingerprint(store.settings))
        throw new Error('当前账号连接已改变，请创建新任务。');
      const snapshot = await client().snapshotWorkflow(task.workflowId);
      if (snapshot.hash !== task.workflowHash)
        throw new Error('工作流已变化，请使用「新版本回归」保留版本归属。');
      if (workflowLocks.has(task.workflowId)) throw new Error('该工作流正在更新。');
      task.status = 'running';
      delete task.pauseReason;
    }
    await store.persist();
    scheduler.pump();
    res.json(task);
  });
  app.post('/api/stop', (_req, res) => {
    scheduler.stop(undefined, true);
    callRoutes.cancelReviews();
    cancelEvaluations(store);
    jev.cancel();
    res.json({ ok: true });
  });
  callRoutes.register(app);
  app.patch('/api/findings/:id', async (req, res) => {
    const finding = store.findings.find((f) => f.id === req.params.id);
    if (!finding) return res.status(404).json({ error: '问题不存在。' });
    const input = z
      .object({
        state: z.enum(['candidate', 'confirmed', 'dismissed']),
        reviewNote: z.string().trim().min(1).max(2000).optional(),
      })
      .parse(req.body);
    const wasIncludedInSummary = finding.state !== 'dismissed';
    finding.state = input.state;
    if (input.reviewNote) finding.reviewNote = input.reviewNote;
    const findingTask = store.tasks.find((task) => task.id === finding.taskId);
    if (findingTask && wasIncludedInSummary !== (finding.state !== 'dismissed'))
      findingTask.resultRevision = (findingTask.resultRevision ?? 0) + 1;
    await store.persist();
    emit({ type: 'state.changed' });
    res.json(finding);
  });
  app.get('/api/pi/models', async (req, res) =>
    res.json({
      models: await pi.listModels(
        typeof req.query.provider === 'string' ? req.query.provider : undefined,
      ),
    }),
  );
  app.post('/api/pi/key', async (req, res) => {
    const input = z
      .object({
        key: z.string().min(1).max(1000),
        provider: z.enum(['openai', 'anthropic']).default('openai'),
      })
      .parse(req.body);
    await pi.configureApiKey(input.key, input.provider);
    res.json(await pi.status());
  });
  app.post('/api/pi/model', async (req, res) => {
    const input = z.object({ provider: z.string(), id: z.string() }).parse(req.body);
    await pi.setModel(input.provider, input.id);
    res.json(await pi.status());
  });
  app.post('/api/pi/login', async (_req, res) => res.json(await pi.startLogin()));
  app.post('/api/pi/login/answer', async (req, res) => {
    const input = z.object({ promptId: z.string(), value: z.string() }).parse(req.body);
    await pi.answerLogin(input.promptId, input.value);
    res.json({ ok: true });
  });
  app.post('/api/pi/login/cancel', async (_req, res) => {
    await pi.cancelLogin();
    res.json({ ok: true });
  });
  app.post('/api/pi/chat', async (req, res) => {
    if (chatRunning) throw new Error('Pi 正在处理上一条消息。');
    const input = z
      .object({
        text: z.string().trim().min(1).max(20000),
        taskId: z.string().optional(),
        allowEditWorkflowId: z.number().int().positive().optional(),
      })
      .parse(req.body);
    const task = store.tasks.find((t) => t.id === input.taskId);
    if (input.taskId && !task) throw new Error('测试任务不存在，请重新选择。');
    if (input.allowEditWorkflowId && (!task || task.workflowId !== input.allowEditWorkflowId))
      throw new Error('编辑授权必须与选中任务的工作流一致。');
    if (
      input.allowEditWorkflowId &&
      task?.connectionFingerprint !== settingsFingerprint(store.settings)
    )
      throw new Error('选中任务属于先前的 Dograh 连接，请为当前账号创建任务后授权编辑。');
    chatRunning = true;
    editScope = input.allowEditWorkflowId;
    try {
      res.json(
        await pi.chat(
          input.text,
          {
            scope: task ? 'task' : 'workbench',
            task: task ?? null,
            editPermission: editScope
              ? { workflowId: editScope, scope: 'draft prompts only; this turn only' }
              : null,
            findings: store.findings.filter((f) => task && f.taskId === task.id).slice(0, 60),
          },
          task ? `task:${task.id}` : 'workbench',
        ),
      );
    } finally {
      chatRunning = false;
      editScope = undefined;
    }
  });
  app.post('/api/pi/abort', async (_req, res) => {
    await pi.abort();
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res
        .status(error instanceof z.ZodError ? 400 : 409)
        .json({ error: safeError(error, connectionSecrets(store.settings)) }),
  );
  return {
    app,
    store,
    pi,
    scheduler,
    async close() {
      closing = true;
      scheduler.stop(undefined, true);
      callRoutes.cancelReviews();
      cancelEvaluations(store);
      jev.cancel();
      await jev.settled();
      await pi.dispose();
      for (const c of clients) c.end();
      const deadline = Date.now() + 30000;
      while (scheduler.activeCount && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      await store.persist();
    },
  };
}

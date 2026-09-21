import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createWorkbench } from './app.js';
import { AudioRunner } from './runner.js';
import { hashWorkflowDefinition, type Workflow } from './dograh.js';
import type { EnvironmentConfig } from './environment.js';
import * as intelligence from './intelligence.js';
import type { TestTask, CallRecord, Finding, TaskSummary } from '../shared/types.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const initialWorkflow: Workflow = {
  id: 12,
  name: 'Taxi Ride Demo (dev)',
  version_number: 4,
  current_definition_id: 91,
  version_status: 'draft',
  workflow_definition: {
    nodes: [{ id: 'greet', data: { name: 'Greeting', prompt: '配車の受付をします。' } }],
    edges: [],
  },
};
const taskInput = {
  name: 'Japanese latency',
  workflowId: 12,
  workflowName: 'client supplied name',
  requirement: '10秒以内に応答する',
  language: 'ja',
  concurrency: 2,
  maxCalls: 4,
  maxDurationSeconds: 30,
  maxVoiceMinutes: 2,
  rules: {
    callerInstructions: 'あなたは渋谷駅へ行きたいタクシー利用者です。',
    responseTimeoutSeconds: 10,
    assertions: ['返答する'],
    interpretation: 'wait for audible response',
    source: 'manual',
  },
};

describe('local workbench HTTP integration', () => {
  let directory: string,
    server: Server,
    port: number,
    workbench: Awaited<ReturnType<typeof createWorkbench>>,
    csrf: string;
  let workflow: Workflow;
  const finishes: Array<() => void> = [];
  const fetches: Array<{ url: string; method: string; headers: Headers }> = [];

  async function http(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return await new Promise<{
      status: number;
      json: any;
      text: string;
      bytes: Buffer;
      headers: import('node:http').IncomingHttpHeaders;
    }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: url,
          method,
          headers: {
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': String(Buffer.byteLength(payload)),
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks),
              text = bytes.toString('utf8');
            let json: any;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode!, json, text, bytes, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  const mutate = (url: string, body: unknown) =>
    http('POST', url, body, { 'x-tantei-token': csrf });
  async function reviewFixture() {
    const task: TestTask = {
      ...taskInput,
      rules: { ...taskInput.rules, source: 'manual', audioReview: false },
      id: 'review_task',
      requirement: '变更地址并完成订单',
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedCalls: 1,
      failedCalls: 0,
      consumedSeconds: 30,
    };
    const call: CallRecord = {
      id: 'review_call',
      taskId: task.id,
      workflowId: 12,
      runId: 814,
      status: 'completed',
      startedAt: task.createdAt,
      durationSeconds: 30,
      evaluationStatus: 'complete',
      versionIntegrity: 'checked',
    };
    workbench.store.tasks.push(task);
    workbench.store.calls.push(call);
    await workbench.store.write(`calls/${call.id}/rules.json`, task.rules);
    await workbench.store.write(`calls/${call.id}/workflow.json`, {
      workflowId: 12,
      workflow: initialWorkflow,
    });
    await workbench.store.write(`calls/${call.id}/evaluation.json`, {
      version: 2,
      status: 'complete',
      summary: 'preserved original',
    });
    await workbench.store.write(`calls/${call.id}/dograh-evidence.json`, {
      transcript: [
        { speaker: 'caller', text: '変更します', atMs: 1000 },
        { speaker: 'agent', text: '承りました', atMs: 2000 },
      ],
      gatheredContext: { destination: 'test' },
      recordings: { mixed: true, caller: true, agent: true },
      timingBasis: 'provider time',
    });
    return { task, call };
  }
  async function configure() {
    expect(
      (
        await mutate('/api/settings', {
          dograhBaseUrl: 'https://dograh.test/backend/api/v1',
          dograhAuthMode: 'token',
          dograhLoginToken: 'dograh-private-token',
          openaiApiKey: 'sk-openai-private-key',
          maxConcurrency: 2,
          voice: 'marin',
        })
      ).status,
    ).toBe(200);
  }
  async function withEnvironment(environment: EnvironmentConfig) {
    server.removeListener('request', workbench.app);
    await workbench.close();
    workbench = await createWorkbench({
      dataDir: directory,
      port,
      audioCheck: async () => true,
      environment,
    });
    server.on('request', workbench.app);
    csrf = (await http('GET', '/api/state')).json.csrfToken;
  }

  beforeEach(async () => {
    workflow = structuredClone(initialWorkflow);
    finishes.length = 0;
    fetches.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      fetches.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      if (url === 'https://dograh.test/backend/api/v1/workflow/fetch/12')
        return Response.json(workflow);
      if (url === 'https://dograh.test/backend/api/v1/workflow/fetch')
        return Response.json([workflow]);
      throw new Error('Unexpected external request in offline test');
    });
    vi.spyOn(AudioRunner.prototype, 'execute').mockImplementation(
      async (_task, call, signal) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            call.status = signal.aborted ? 'stopped' : 'completed';
            call.durationSeconds = 3;
            call.finalUsageConfirmed = true;
            signal.removeEventListener('abort', finish);
            resolve();
          };
          signal.addEventListener('abort', finish, { once: true });
          finishes.push(finish);
          if (signal.aborted) finish();
        }),
    );
    directory = await fs.mkdtemp(path.join(tmpdir(), 'tantei-http-test-'));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    workbench = await createWorkbench({ dataDir: directory, port, audioCheck: async () => true });
    server.on('request', workbench.app);
    const state = await http('GET', '/api/state');
    expect(state.status).toBe(200);
    csrf = state.json.csrfToken;
  });
  afterEach(async () => {
    await workbench?.close();
    finishes.forEach((finish) => finish());
    await flush();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it('deletes a completed task and its chat while preserving recordings and other tasks', async () => {
    const { task, call } = await reviewFixture();
    workbench.store.tasks.push({ ...task, id: 'other-task' });
    const cleanup = vi.spyOn(workbench.pi, 'deleteTaskConversation').mockResolvedValue();
    const result = await mutate(`/api/tasks/${task.id}/action`, { action: 'delete' });
    expect(result.status).toBe(200);
    expect(cleanup).toHaveBeenCalledWith(task.id);
    expect(workbench.store.tasks.map((item) => item.id)).toEqual(['other-task']);
    expect(workbench.store.calls).toHaveLength(0);
    expect(await workbench.store.read(`calls/${call.id}/evaluation.json`, null)).not.toBeNull();
    const saved = await workbench.store.read<{ tasks: TestTask[] }>('state.json', { tasks: [] });
    expect(saved.tasks.map((item) => item.id)).toEqual(['other-task']);
  });

  it('refuses to delete running tasks', async () => {
    const { task } = await reviewFixture();
    task.status = 'running';
    const result = await mutate(`/api/tasks/${task.id}/action`, { action: 'delete' });
    expect(result.status).toBe(409);
    expect(workbench.store.tasks).toContain(task);
  });

  it('saves Jev credentials locally without exposing them and retains blank submissions', async () => {
    const key = 'jev-test-credential';
    expect((await mutate('/api/settings/jev', { apiKey: key })).status).toBe(200);
    const state = await http('GET', '/api/state');
    expect(state.json.settings.typesafeKeySet).toBe(true);
    expect(state.text).not.toContain(key);
    expect(
      (
        await workbench.store.read<{ typesafeApiKey: string }>('settings.json', {
          typesafeApiKey: '',
        })
      ).typesafeApiKey,
    ).toBe(key);
    await mutate('/api/settings/jev', {});
    expect(workbench.store.settings.typesafeApiKey).toBe(key);
    expect((await mutate('/api/settings/jev', { apiKey: 'bad key' })).status).not.toBe(200);
    expect(workbench.store.settings.typesafeApiKey).toBe(key);
  });

  it('keeps environment Jev credentials out of saved settings and rejects UI overrides', async () => {
    await withEnvironment({ typesafeApiKey: 'jev-env-credential' });
    expect((await http('GET', '/api/state')).json.settings.typesafeKeySet).toBe(true);
    expect((await mutate('/api/settings/jev', { apiKey: 'replacement-key' })).status).not.toBe(200);
    await workbench.store.saveSettings();
    expect(JSON.stringify(await workbench.store.read('settings.json', {}))).not.toContain(
      'jev-env-credential',
    );
  });

  it('enforces exact local Host, allowed Origin and mutation CSRF token', async () => {
    expect(
      (await http('GET', '/api/state', undefined, { Host: `attacker.test:${port}` })).status,
    ).toBe(403);
    expect(
      (await http('GET', '/api/state', undefined, { Origin: 'https://attacker.test' })).status,
    ).toBe(403);
    expect(
      (await http('GET', '/api/state', undefined, { Origin: `http://localhost:${port}` })).status,
    ).toBe(200);
    expect((await http('POST', '/api/stop', {})).status).toBe(403);
    expect((await http('POST', '/api/stop', {}, { 'x-tantei-token': 'wrong' })).status).toBe(403);
    expect((await mutate('/api/stop', {})).status).toBe(200);
    expect(fetches).toHaveLength(0);
  });

  it('accepts a global concurrency limit up to 30 and rejects larger values', async () => {
    const settings = {
      dograhBaseUrl: 'https://dograh.test/backend/api/v1',
      dograhAuthMode: 'token',
      maxConcurrency: 30,
      voice: 'marin',
    };
    expect((await mutate('/api/settings', settings)).status).toBe(200);
    expect(workbench.store.settings.maxConcurrency).toBe(30);

    expect((await mutate('/api/settings', { ...settings, maxConcurrency: 31 })).status).toBe(400);
    expect(workbench.store.settings.maxConcurrency).toBe(30);
    expect(fetches).toHaveLength(0);
  });

  it('updates the shared concurrency pool while calls are active without interrupting them', async () => {
    await configure();
    const created = await mutate('/api/tasks', taskInput);
    expect(created.status).toBe(200);
    const second = await mutate('/api/tasks', { ...taskInput, name: 'Second queued task' });
    expect(second.status).toBe(200);
    await flush();
    expect(workbench.scheduler.activeCount).toBe(2);

    const raised = await mutate('/api/settings/concurrency', { maxConcurrency: 30 });
    expect(raised).toMatchObject({ status: 200, json: { ok: true, maxConcurrency: 30 } });
    expect(workbench.store.settings.maxConcurrency).toBe(30);
    expect(workbench.scheduler.activeCount).toBe(4);

    const belowActive = await mutate('/api/settings/concurrency', { maxConcurrency: 3 });
    expect(belowActive.status).toBe(409);
    expect(belowActive.text).toContain('不能低于当前占用');
    expect(workbench.store.settings.maxConcurrency).toBe(30);
  });

  it('persists a Pi task summary and archives the previous revision', async () => {
    const { task, call } = await reviewFixture();
    task.resultRevision = 2;
    call.evaluationOverall = 'fail';
    const finding: Finding = {
      id: 'summary-finding',
      taskId: task.id,
      callId: call.id,
      kind: 'semantic_assertion_0',
      title: '地址已修改但订单未完成',
      detail: '客服确认地址后说明当前无法完成订单。',
      severity: 'high',
      startMs: 12_000,
      endMs: 18_000,
      source: 'judge',
      state: 'candidate',
      createdAt: task.createdAt,
      evaluatorVersion: 3,
      category: 'business_outcome',
    };
    workbench.store.findings.push(finding);
    const previous: TaskSummary = {
      version: 1,
      revisionId: 'previous-summary',
      resultRevision: 1,
      generatedAt: '2026-09-20T00:00:00.000Z',
      reviewedCallIds: [call.id],
      findingIds: [finding.id],
      passCallIds: [],
      inconclusiveCallIds: [],
      headline: '旧汇总',
      body: '旧内容',
      points: [],
      groups: [],
    };
    task.summary = previous;
    vi.spyOn(workbench.pi, 'status').mockResolvedValue({
      configured: true,
      environmentApiKeySet: false,
      environmentAnthropicApiKeySet: false,
      providers: [],
      model: { provider: 'openai', id: 'gpt-5.6-sol' },
      modelError: null,
      busy: false,
      login: null,
      sessionId: null,
    });
    vi.spyOn(workbench.pi, 'complete').mockResolvedValue(
      JSON.stringify({
        headline: '1 通已评审，订单未完成',
        body: '地址修改已被接受，但订单没有完成。',
        points: ['分别查看地址修改与订单完成的评审结果。'],
        groups: [
          {
            title: '订单未完成',
            detail: '一通出现。',
            clusterIds: ['cluster:1'],
          },
        ],
      }),
    );

    const response = await mutate(`/api/tasks/${task.id}/summary`, {});
    expect(response.status).toBe(200);
    expect(response.json.summary).toMatchObject({
      resultRevision: 2,
      reviewedCallIds: [call.id],
      findingIds: [finding.id],
      groups: [{ callIds: [call.id], findingIds: [finding.id] }],
    });
    expect(await workbench.store.read(`tasks/${task.id}/summary.json`, null)).toEqual(
      response.json.summary,
    );
    expect(
      await workbench.store.read(
        `tasks/${task.id}/summary-revisions/${previous.revisionId}.json`,
        null,
      ),
    ).toEqual(previous);
    expect((await http('GET', '/api/state')).json.summaryRunningTaskIds).toEqual([]);
  });

  it('serves complete and seekable WAV tracks from a hidden data directory without exposing other files', async () => {
    server.removeListener('request', workbench.app);
    await workbench.close();
    workbench = await createWorkbench({
      dataDir: path.join(directory, '.tantei'),
      port,
      audioCheck: async () => true,
    });
    server.on('request', workbench.app);
    const call = {
      id: 'audio_call',
      taskId: 'audio_task',
      workflowId: 12,
      runId: 807,
      status: 'completed' as const,
      startedAt: '2026-09-20T00:00:00Z',
      durationSeconds: 1,
    };
    workbench.store.calls.push(call);
    const callDirectory = workbench.store.callDir(call.id);
    await fs.mkdir(callDirectory, { recursive: true });
    const wav = Buffer.alloc(48044);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24);
    wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    await fs.writeFile(path.join(callDirectory, 'metadata.json'), 'private metadata');
    for (const track of ['mixed', 'caller', 'agent']) {
      await fs.writeFile(path.join(callDirectory, `${track}.wav`), wav);
      const url = `/api/calls/${call.id}/audio/${track}`;
      const full = await http('GET', url);
      expect(full.status).toBe(200);
      expect(full.bytes.equals(wav)).toBe(true);
      expect(full.headers['content-type']).toMatch(/^audio\//);
      expect(full.headers['accept-ranges']).toBe('bytes');
      const range = await http('GET', url, undefined, { Range: 'bytes=100-199' });
      expect(range.status).toBe(206);
      expect(range.bytes.equals(wav.subarray(100, 200))).toBe(true);
      expect(range.headers['content-range']).toBe(`bytes 100-199/${wav.length}`);
      const head = await http('HEAD', url);
      expect(head.status).toBe(200);
      expect(head.headers['content-length']).toBe(String(wav.length));
      expect(head.bytes.length).toBe(0);
      const pastEnd = await http('GET', url, undefined, { Range: 'bytes=999999-' });
      expect(pastEnd.status).toBe(416);
    }
    expect((await http('GET', `/api/calls/${call.id}/audio/metadata.json`)).status).toBe(400);
    expect((await http('GET', '/api/calls/missing_call/audio/mixed')).status).toBe(404);
    expect(fetches).toHaveLength(0);
  });

  it('keeps login and model credentials out of public state and persists secrets with private permissions', async () => {
    await configure();
    const state = await http('GET', '/api/state');
    expect(state.json.settings).toMatchObject({
      dograhAuthMode: 'token',
      dograhTokenSet: true,
      dograhKeySet: false,
      openaiKeySet: true,
    });
    expect(state.text).not.toContain('dograh-private-token');
    expect(state.text).not.toContain('sk-openai-private-key');
    expect(state.json.settings).not.toHaveProperty('dograhApiKey');
    expect(state.json.settings).not.toHaveProperty('openaiApiKey');
    expect((await fs.stat(path.join(directory, 'settings.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('re-aligns only report objectives using saved workflow and locks duplicate reviews while planning', async () => {
    const { task, call } = await reviewFixture();
    let finishPlan!: (rules: typeof task.rules) => void;
    const plan = vi.spyOn(intelligence, 'planRules').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPlan = resolve;
        }),
    );
    const evaluate = vi
      .spyOn(intelligence, 'evaluateCall')
      .mockImplementation(async (_pi, store, _task, reviewCall) => {
        await store.write(`calls/${reviewCall.id}/evaluation-attempt.json`, { status: 'complete' });
      });
    const first = mutate(`/api/calls/${call.id}/review`, { realignToRequirement: true });
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect((await http('GET', `/api/calls/${call.id}`)).json.reviewPending).toBe(true);
    expect(
      (await mutate(`/api/calls/${call.id}/review`, { realignToRequirement: true })).status,
    ).toBe(409);
    expect(plan.mock.calls[0]?.[1]).toMatchObject({
      requirement: task.requirement,
      responseTimeoutSeconds: 10,
      workflowPrompts: [{ nodeId: 'greet', value: '配車の受付をします。' }],
    });
    finishPlan({
      ...task.rules,
      assertions: ['变更地址', '完成订单'],
      interpretation: '目标独立判断',
      callerInstructions: 'Do not replace the historical caller script',
      audioReview: true,
      responseTimeoutSeconds: 50,
    });
    expect((await first).status).toBe(200);
    expect(evaluate.mock.calls[0]?.[5]).toMatchObject({
      force: true,
      reuseAudioReview: true,
      reviewRules: {
        ...task.rules,
        assertions: ['变更地址', '完成订单'],
        interpretation: '目标独立判断',
      },
    });
    expect(await workbench.store.read(`calls/${call.id}/rules.json`, null)).toEqual(task.rules);
    expect((await http('GET', `/api/calls/${call.id}`)).json.reviewPending).toBe(false);
    expect(fetches).toHaveLength(0);
    expect(workbench.scheduler.activeCount).toBe(0);
  });

  it('preserves old reports on planning failure and rejects active calls without paying for review', async () => {
    const { call } = await reviewFixture();
    const plan = vi.spyOn(intelligence, 'planRules').mockRejectedValue(new Error('Pi 草案不可用'));
    const evaluate = vi.spyOn(intelligence, 'evaluateCall').mockResolvedValue();
    call.status = 'running';
    expect((await mutate(`/api/calls/${call.id}/review`, {})).status).toBe(409);
    expect(plan).not.toHaveBeenCalled();
    call.status = 'completed';
    const failed = await mutate(`/api/calls/${call.id}/review`, {});
    expect(failed.status).toBe(409);
    const detail = (await http('GET', `/api/calls/${call.id}`)).json;
    expect(detail.evaluation).toEqual({
      version: 2,
      status: 'complete',
      summary: 'preserved original',
    });
    expect(detail.evaluationAttempt).toMatchObject({
      status: 'failed',
      preservedPrevious: true,
      error: 'Pi 草案不可用',
    });
    expect(detail.reviewPending).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
    expect((await mutate('/api/calls/missing/review', {})).status).toBe(404);
  });

  it('rejects unverified versions and honours stop while a re-review plan is pending', async () => {
    const { task, call } = await reviewFixture();
    let finishPlan!: (rules: typeof task.rules) => void;
    const plan = vi.spyOn(intelligence, 'planRules').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPlan = resolve;
        }),
    );
    const evaluate = vi.spyOn(intelligence, 'evaluateCall').mockResolvedValue();
    for (const integrity of ['changed', 'unverified', undefined] as const) {
      call.versionIntegrity = integrity;
      expect((await mutate(`/api/calls/${call.id}/review`, {})).status).toBe(409);
    }
    expect(plan).not.toHaveBeenCalled();
    call.versionIntegrity = 'checked';
    const pending = mutate(`/api/calls/${call.id}/review`, {});
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect((await mutate('/api/stop', {})).status).toBe(200);
    expect(plan.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    finishPlan(task.rules);
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.json.error).toContain('停止');
    expect(evaluate).not.toHaveBeenCalled();
    expect((await http('GET', `/api/calls/${call.id}`)).json.reviewPending).toBe(false);
  });

  it('saves normalized login tokens privately and uses Bearer for workflow reads and task setup', async () => {
    await configure();
    const token = 'test_login_token_not_a_real_credential';
    const response = await mutate('/api/settings', {
      dograhBaseUrl: 'https://dograh.test/backend/api/v1',
      dograhAuthMode: 'token',
      dograhLoginToken: `dograh_auth_token=${token}`,
      maxConcurrency: 2,
      voice: 'marin',
    });
    expect(response.status).toBe(200);
    const state = await http('GET', '/api/state');
    expect(state.json.settings).toMatchObject({
      dograhAuthMode: 'token',
      dograhTokenSet: true,
      dograhCredentialSet: true,
      openaiKeySet: true,
      dograhKeySet: false,
    });
    expect(state.text).not.toContain(token);
    expect(state.json.settings).not.toHaveProperty('dograhLoginToken');
    expect((await http('GET', '/api/workflows')).status).toBe(200);
    expect(fetches.at(-1)?.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(fetches.at(-1)?.headers.has('X-API-Key')).toBe(false);
    const task = await mutate('/api/tasks', taskInput);
    expect(task.status).toBe(200);
    await flush();
    expect(workbench.scheduler.activeCount).toBe(2);
    expect(
      fetches.every(
        (f) => f.headers.get('Authorization') === `Bearer ${token}` && !f.headers.has('X-API-Key'),
      ),
    ).toBe(true);
    expect(workbench.store.settings.openaiApiKey).toBe('sk-openai-private-key');
    expect((await fs.stat(path.join(directory, 'settings.json'))).mode & 0o777).toBe(0o600);
  });

  it('loads a portable environment without exposing or persisting its credentials and protects managed fields', async () => {
    await configure();
    const environment = {
      dograhBaseUrl: 'https://dograh.test/backend/api/v1',
      dograhLoginToken: 'environment-token',
      openaiApiKey: 'sk-environment-voice',
      piOpenaiApiKey: 'sk-environment-pi',
    };
    await withEnvironment(environment);
    const state = await http('GET', '/api/state');
    expect(state.json.settings).toMatchObject({
      dograhAuthMode: 'token',
      dograhCredentialSet: true,
      openaiKeySet: true,
      environment: {
        dograhBaseUrl: true,
        dograhLoginToken: true,
        openaiApiKey: true,
        piOpenaiApiKey: true,
      },
    });
    expect(state.json.pi).toMatchObject({
      configured: true,
      environmentApiKeySet: true,
      model: { provider: 'openai', id: 'gpt-5.6-sol' },
    });
    for (const secret of [
      environment.dograhLoginToken,
      environment.openaiApiKey,
      environment.piOpenaiApiKey,
    ])
      expect(state.text).not.toContain(secret);
    expect((await http('GET', '/api/workflows')).status).toBe(200);
    expect(fetches.at(-1)?.headers.get('Authorization')).toBe('Bearer environment-token');
    const update = {
      dograhBaseUrl: environment.dograhBaseUrl,
      dograhAuthMode: 'token',
      dograhLoginToken: '',
      openaiApiKey: '',
      maxConcurrency: 4,
      voice: 'cedar',
    };
    expect((await mutate('/api/settings', update)).status).toBe(200);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
    expect(saved).toMatchObject({
      dograhLoginToken: 'dograh-private-token',
      openaiApiKey: 'sk-openai-private-key',
      maxConcurrency: 4,
      voice: 'cedar',
    });
    expect(JSON.stringify(saved)).not.toContain('environment-');
    for (const patch of [
      { dograhBaseUrl: 'https://other.test' },
      { dograhLoginToken: 'different-token' },
      { openaiApiKey: 'sk-different' },
    ]) {
      const result = await mutate('/api/settings', { ...update, ...patch });
      expect(result.status).toBe(409);
      expect(result.text).toContain('.env');
      expect(result.text).not.toContain('sk-different');
      expect(result.text).not.toContain('different-token');
    }
    const piUpdate = await mutate('/api/pi/key', { provider: 'openai', key: 'sk-different' });
    expect(piUpdate.status).toBe(409);
    expect(piUpdate.text).not.toContain('sk-different');
    const auth = await fs.readFile(path.join(directory, 'pi', 'auth.json'), 'utf8').catch(() => '');
    expect(auth).not.toContain('sk-environment');
    await withEnvironment({});
    expect(workbench.store.settings).toMatchObject({
      dograhLoginToken: 'dograh-private-token',
      openaiApiKey: 'sk-openai-private-key',
      maxConcurrency: 4,
    });
  });

  it('shares the voice environment key with Pi and refuses server changes with a loaded token', async () => {
    await configure();
    await withEnvironment({
      dograhLoginToken: 'environment-token',
      openaiApiKey: 'sk-shared-environment',
    });
    const state = await http('GET', '/api/state');
    expect(state.json.pi.environmentApiKeySet).toBe(true);
    expect(state.json.settings.environment.piOpenaiApiKey).toBe(true);
    const result = await mutate('/api/settings', {
      dograhBaseUrl: 'https://second.test/api/v1',
      dograhLoginToken: '',
      maxConcurrency: 2,
      voice: 'marin',
    });
    expect(result.status).toBe(409);
    expect(result.text).toContain('DOGRAH_BASE_URL');
    expect(fetches).toHaveLength(0);
    await withEnvironment({ dograhLoginToken: 'environment-token' });
    expect(workbench.store.settings.dograhBaseUrl).toBe('https://dograh.test/backend/api/v1');
  });

  it('connects Claude from its own environment key without disclosing or persisting it', async () => {
    await withEnvironment({ piAnthropicApiKey: 'sk-ant-environment-private' });
    const state = await http('GET', '/api/state');
    expect(state.json.settings.environment.piAnthropicApiKey).toBe(true);
    expect(state.json.pi).toMatchObject({
      configured: true,
      environmentAnthropicApiKeySet: true,
      model: { provider: 'anthropic', id: 'claude-opus-5' },
    });
    expect(state.text).not.toContain('sk-ant-environment-private');
    expect(
      (await mutate('/api/pi/key', { provider: 'anthropic', key: 'sk-ant-replacement' })).status,
    ).toBe(409);
    const auth = await fs.readFile(path.join(directory, 'pi', 'auth.json'), 'utf8').catch(() => '');
    expect(auth).not.toContain('sk-ant-environment-private');
  });

  it('only accepts token authentication from the settings API', async () => {
    const result = await mutate('/api/settings', {
      dograhBaseUrl: 'https://dograh.test',
      dograhAuthMode: 'apiKey',
      dograhApiKey: 'unused-legacy-key',
      maxConcurrency: 2,
      voice: 'marin',
    });
    expect(result.status).toBe(400);
    expect(result.text).not.toContain('unused-legacy-key');
    expect(fetches).toHaveLength(0);
  });

  it('keeps missing-token mode unready and rejects pasted curl without returning its credential', async () => {
    await configure();
    workbench.store.settings.dograhLoginToken = '';
    workbench.store.settings.dograhApiKey = 'legacy-unused-key';
    workbench.store.settings.dograhApiKeyBaseUrl = workbench.store.settings.dograhBaseUrl;
    expect(
      (
        await mutate('/api/settings', {
          dograhBaseUrl: 'https://dograh.test/backend/api/v1',
          dograhAuthMode: 'token',
          maxConcurrency: 2,
          voice: 'marin',
        })
      ).status,
    ).toBe(200);
    const state = await http('GET', '/api/state');
    expect(state.json.settings).toMatchObject({
      dograhCredentialSet: false,
      dograhKeySet: true,
      dograhTokenSet: false,
    });
    expect((await mutate('/api/tasks', taskInput)).status).toBe(409);
    expect(fetches).toHaveLength(0);
    const result = await mutate('/api/settings', {
      dograhBaseUrl: 'https://dograh.test/backend/api/v1',
      dograhAuthMode: 'token',
      dograhLoginToken: 'curl --cookie dograh_auth_token=secret_fake_token',
      maxConcurrency: 2,
      voice: 'marin',
    });
    expect(result.status).toBe(409);
    expect(result.text).not.toContain('secret_fake_token');
    expect(workbench.store.settings.dograhLoginToken).toBe('');
  });

  it('validates budget before calls and saves the exact workflow version and rules baseline', async () => {
    await configure();
    const invalid = await mutate('/api/tasks', {
      ...taskInput,
      maxDurationSeconds: 120,
      maxVoiceMinutes: 1,
    });
    expect(invalid.status).toBe(409);
    expect(fetches).toHaveLength(0);
    const response = await mutate('/api/tasks', {
      ...taskInput,
      rules: { ...taskInput.rules, responseTimeoutSeconds: null, audioReview: true },
    });
    expect(response.status).toBe(200);
    const task = response.json;
    await flush();
    expect(task.workflowName).toBe(initialWorkflow.name);
    expect(task.workflowHash).toBe(hashWorkflowDefinition(initialWorkflow));
    expect(task.rules.responseTimeoutSeconds).toBeNull();
    expect(workbench.scheduler.activeCount).toBe(2);
    expect(task.rules.audioReview).toBe(true);
    const baseline = JSON.parse(
      await fs.readFile(path.join(directory, 'tasks', task.id, 'baseline.json'), 'utf8'),
    );
    expect(baseline).toMatchObject({
      workflowId: 12,
      hash: task.workflowHash,
      workflow: { version_number: 4, current_definition_id: 91 },
    });
    expect(fetches.every((request) => request.method === 'GET')).toBe(true);
  });

  it('rejects stale-version resume and cancels all active calls without launching replacements', async () => {
    await configure();
    const created = await mutate('/api/tasks', taskInput);
    const id = created.json.id;
    await flush();
    expect((await mutate(`/api/tasks/${id}/action`, { action: 'pause' })).status).toBe(200);
    workflow.workflow_definition = {
      nodes: [{ id: 'greet', data: { prompt: '改訂した案内' } }],
      edges: [],
    };
    const resumed = await mutate(`/api/tasks/${id}/action`, { action: 'resume' });
    expect(resumed.status).toBe(409);
    expect(resumed.text).toContain('工作流已变化');
    expect((await mutate(`/api/tasks/${id}/action`, { action: 'cancel' })).status).toBe(200);
    await flush();
    expect(workbench.scheduler.activeCount).toBe(0);
    expect(workbench.store.calls).toHaveLength(2);
    expect(workbench.store.tasks[0]).toMatchObject({ status: 'stopped', failedCalls: 2 });
    expect(workbench.store.calls.every((call) => call.status === 'stopped')).toBe(true);
  });

  it('refuses old-task regression after changing Dograh credentials or servers', async () => {
    await configure();
    const created = await mutate('/api/tasks', taskInput);
    const id = created.json.id;
    await flush();
    await mutate(`/api/tasks/${id}/action`, { action: 'cancel' });
    await flush();
    expect(workbench.scheduler.activeCount).toBe(0);
    const saved = await mutate('/api/settings', {
      dograhBaseUrl: 'https://second.test/api/v1',
      dograhAuthMode: 'token',
      dograhLoginToken: 'second_server_test_token',
      maxConcurrency: 2,
      voice: 'marin',
    });
    expect(saved.status).toBe(200);
    fetches.length = 0;
    const result = await mutate(`/api/tasks/${id}/action`, { action: 'regression' });
    expect(result.status).toBe(409);
    expect(result.text).toContain('重新选择工作流');
    expect(fetches).toHaveLength(0);
    expect(workbench.store.tasks).toHaveLength(1);
    expect(workbench.scheduler.activeCount).toBe(0);
  });

  it('links a known Dograh run only while its original connection still matches', async () => {
    await configure();
    const created = await mutate('/api/tasks', taskInput);
    await flush();
    const call = workbench.store.calls[0];
    expect((await http('GET', `/api/calls/${call.id}`)).json.dograhRunUrl).toBeNull();
    call.runId = 807;
    expect((await http('GET', `/api/calls/${call.id}`)).json.dograhRunUrl).toBe(
      'https://dograh.test/workflow/12/run/807',
    );
    await mutate(`/api/tasks/${created.json.id}/action`, { action: 'cancel' });
    await flush();
    expect(
      (
        await mutate('/api/settings', {
          dograhBaseUrl: 'https://different.test/api/v1',
          dograhLoginToken: 'different-login',
          maxConcurrency: 2,
          voice: 'marin',
        })
      ).status,
    ).toBe(200);
    expect((await http('GET', `/api/calls/${call.id}`)).json.dograhRunUrl).toBeNull();
  });

  it('pauses a task after an execution failure rather than exhausting its full batch', async () => {
    await configure();
    vi.mocked(AudioRunner.prototype.execute).mockRejectedValue(new Error('offline test transport'));
    const result = await mutate('/api/tasks', { ...taskInput, concurrency: 1, maxCalls: 20 });
    await flush();
    await flush();
    expect(result.status).toBe(200);
    expect(workbench.store.tasks[0]).toMatchObject({ status: 'paused', failedCalls: 1 });
    expect(workbench.store.calls).toHaveLength(1);
    expect(workbench.scheduler.activeCount).toBe(0);
  });

  it('binds Pi edit authorization to the selected workflow and clears it on the next turn', async () => {
    await configure();
    const created = await mutate('/api/tasks', taskInput);
    const id = created.json.id;
    const chat = vi
      .spyOn(workbench.pi, 'chat')
      .mockResolvedValue({ text: 'offline test reply' } as any);
    const rejected = await mutate('/api/pi/chat', {
      text: '改进提示词',
      taskId: id,
      allowEditWorkflowId: 99,
    });
    expect(rejected.status).toBe(409);
    expect(chat).not.toHaveBeenCalled();
    expect(
      (await mutate('/api/pi/chat', { text: '修改当前草稿', taskId: id, allowEditWorkflowId: 12 }))
        .status,
    ).toBe(200);
    expect(chat.mock.calls[0][1]).toMatchObject({ editPermission: { workflowId: 12 } });
    expect((await mutate('/api/pi/chat', { text: '解释结果', taskId: id })).status).toBe(200);
    expect(chat.mock.calls[1][1]).toMatchObject({ editPermission: null });
  });
});

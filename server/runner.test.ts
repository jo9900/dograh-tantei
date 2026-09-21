import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AudioRunner, connectionFingerprint } from './runner.js';
import { LocalStore } from './store.js';
import { createDefinitionSnapshot, type Workflow } from './dograh.js';
import type { AppEvent, CallRecord, TestTask } from '../shared/types.js';

const workflow: Workflow = {
  id: 7,
  name: 'Taxi',
  version_number: 2,
  version_status: 'draft',
  current_definition_id: 19,
  workflow_definition: { nodes: [{ id: 'a', data: { prompt: '日本語で案内する' } }], edges: [] },
};

describe('Python worker process integration', () => {
  let dir: string, store: LocalStore, task: TestTask, call: CallRecord;
  let events: AppEvent[], requests: Array<{ url: string; method: string; headers: Headers }>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-runner-test-'));
    store = new LocalStore(dir);
    await store.init();
    store.settings = {
      dograhBaseUrl: 'https://dograh.test/backend/api/v1/',
      dograhApiKey: 'dograh-runner-secret',
      openaiApiKey: 'sk-runner-secret',
      maxConcurrency: 1,
      voice: 'marin',
    };
    task = {
      id: 'task_one',
      name: 'Taxi timing',
      workflowId: 7,
      workflowName: 'Taxi',
      requirement: 'test',
      language: 'ja',
      concurrency: 1,
      maxCalls: 1,
      maxDurationSeconds: 20,
      maxVoiceMinutes: 1,
      rules: {
        callerInstructions: 'タクシーの乗客として会話してください。',
        responseTimeoutSeconds: null,
        assertions: [],
        interpretation: 'test',
        source: 'manual',
      },
      status: 'running',
      createdAt: '',
      completedCalls: 0,
      failedCalls: 0,
      consumedSeconds: 0,
      workflowHash: createDefinitionSnapshot(workflow).hash,
      connectionFingerprint: connectionFingerprint(
        store.settings.dograhBaseUrl,
        store.settings.dograhApiKey,
      ),
    };
    call = {
      id: 'call_one',
      taskId: task.id,
      workflowId: 7,
      status: 'connecting',
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
    };
    store.tasks = [task];
    store.calls = [call];
    events = [];
    requests = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      if (url === 'https://dograh.test/backend/api/v1/workflow/fetch/7')
        return Response.json(workflow);
      if (url === 'https://dograh.test/backend/api/v1/workflow/7/runs' && init?.method === 'POST')
        return Response.json({ id: 101, definition_id: 19 });
      if (url === 'https://dograh.test/backend/api/v1/workflow/7/runs/101')
        return Response.json({ id: 101, definition_id: 19, is_completed: true });
      if (url === 'https://dograh.test/backend/api/v1/workflow/7/versions')
        return Response.json([
          {
            id: 19,
            version_number: 2,
            status: 'draft',
            workflow_json: workflow.workflow_definition,
          },
        ]);
      throw new Error('Unexpected network call in offline runner test');
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function shim(mode: 'complete' | 'cancel' | 'incomplete') {
    const file = path.join(dir, 'worker-shim.mjs');
    await fs.writeFile(
      file,
      `#!${process.execPath}\nimport readline from 'node:readline';\nimport fs from 'node:fs';\nimport path from 'node:path';\nlet config;\nconst emit=e=>process.stdout.write(JSON.stringify({runId:101,...e})+'\\n');\nconst done=reason=>{\n for(const track of ['caller','agent','mixed'])fs.writeFileSync(path.join(config.outputDir,track+'.wav'),Buffer.alloc(44));\n emit({type:'artifacts',atMs:7000,durationMs:2000,files:{caller:'caller.wav',agent:'agent.wav',mixed:'mixed.wav'}});\n emit({type:'completed',atMs:7001,reason,finalUsageConfirmed:true,usage:{seconds:1.8}});\n process.exit(0);\n};\nreadline.createInterface({input:process.stdin}).on('line',line=>{\n const item=JSON.parse(line);\n if(!config){config=item;emit({type:'diagnostic',atMs:1,code:'contract',base:config.dograhBaseUrl,nullTimeout:config.responseTimeoutSeconds===null,authMode:config.dograhAuthMode,hasKey:!!config.dograhApiKey,hasLoginCredential:!!config.dograhLoginToken});emit({type:'state',atMs:10,state:'connected'});\n if('${mode}'==='complete'){emit({type:'finding',atMs:1500,code:'response_timeout',title:'late answer',startMs:200,endMs:1400,evidenceSource:'local_audio_rms'});done('max_duration');}\n if('${mode}'==='incomplete')process.exit(0);\n }else if(item.type==='stop')done('cancelled');\n});\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('TANTEI_PYTHON', file);
  }

  it('consumes real JSONL child output, saves evidence and preserves audio duration independent of finalization', async () => {
    await shim('complete');
    const evaluated = vi.fn(async () => {});
    await new AudioRunner(store, (event) => events.push(event), evaluated).execute(
      task,
      call,
      new AbortController().signal,
    );
    expect(call).toMatchObject({
      status: 'completed',
      runId: 101,
      definitionId: 19,
      version: 2,
      durationSeconds: 2,
      finalUsageConfirmed: true,
      usage: { seconds: 1.8 },
      audio: { caller: true, agent: true, mixed: true },
    });
    expect(evaluated).toHaveBeenCalledOnce();
    expect(store.findings[0]).toMatchObject({
      callId: call.id,
      startMs: 200,
      endMs: 1400,
      measuredSeconds: 1.2,
      source: 'timer',
    });
    const bridge = await fs.readFile(
      path.join(store.callDir(call.id), 'bridge-events.jsonl'),
      'utf8',
    );
    expect(bridge).toContain('"base":"https://dograh.test/backend/api/v1"');
    expect(bridge).toContain('"nullTimeout":true');
    expect(bridge).not.toContain('dograh-runner-secret');
    expect(bridge).not.toContain('sk-runner-secret');
    const snapshot = JSON.parse(
      await fs.readFile(path.join(store.callDir(call.id), 'workflow.json'), 'utf8'),
    );
    expect(snapshot.hash).toBe(task.workflowHash);
    const sentInstructions = JSON.parse(
      await fs.readFile(path.join(store.callDir(call.id), 'caller-instructions.json'), 'utf8'),
    );
    expect(sentInstructions.instructions).toContain(task.rules.callerInstructions);
    expect(sentInstructions.instructions).toContain('Do not silently substitute your own quantity');
    expect(
      JSON.parse(await fs.readFile(path.join(store.callDir(call.id), 'metadata.json'), 'utf8'))
        .durationSeconds,
    ).toBe(2);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('passes only the selected login token to the worker and authenticates every workflow request with Bearer', async () => {
    const token = 'offline_runner_login_token';
    store.settings.dograhAuthMode = 'token';
    store.settings.dograhLoginToken = token;
    task.connectionFingerprint = connectionFingerprint(
      store.settings.dograhBaseUrl,
      token,
      'token',
    );
    await shim('complete');
    await new AudioRunner(store, (event) => events.push(event)).execute(
      task,
      call,
      new AbortController().signal,
    );
    expect(call.status).toBe('completed');
    expect(requests.length).toBeGreaterThan(2);
    expect(
      requests.every(
        (request) =>
          request.headers.get('Authorization') === `Bearer ${token}` &&
          !request.headers.has('X-API-Key'),
      ),
    ).toBe(true);
    const bridge = await fs.readFile(
      path.join(store.callDir(call.id), 'bridge-events.jsonl'),
      'utf8',
    );
    expect(bridge).toContain('"authMode":"token"');
    expect(bridge).toContain('"hasKey":false');
    expect(bridge).toContain('"hasLoginCredential":true');
    expect(bridge).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(bridge).not.toContain('dograh-runner-secret');
  });

  it('sends stop over stdin and preserves cancelled artifacts without evaluation', async () => {
    await shim('cancel');
    const controller = new AbortController(),
      evaluated = vi.fn(async () => {});
    const runner = new AudioRunner(
      store,
      (event) => {
        events.push(event);
        if (event.type === 'call.event' && (event.event as any)?.state === 'connected')
          controller.abort();
      },
      evaluated,
    );
    await runner.execute(task, call, controller.signal);
    expect(call.status).toBe('stopped');
    expect(call.audio?.mixed).toBe(true);
    expect(call.finalUsageConfirmed).toBe(true);
    expect(evaluated).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) => event.type === 'call.event' && (event.event as any)?.reason === 'cancelled',
      ),
    ).toBe(true);
  });

  it('treats a clean process exit without a completion event as a failed call', async () => {
    await shim('incomplete');
    await new AudioRunner(store, (event) => events.push(event)).execute(
      task,
      call,
      new AbortController().signal,
    );
    expect(call.status).toBe('error');
    expect(call.error).toContain('未收到完整结束事件');
    expect(call.audio?.mixed).toBe(false);
  });

  it('rejects a changed workflow before creating a run or spawning the worker', async () => {
    task.workflowHash = 'stale';
    vi.stubEnv('TANTEI_PYTHON', path.join(dir, 'does-not-exist'));
    await new AudioRunner(store, (event) => events.push(event)).execute(
      task,
      call,
      new AbortController().signal,
    );
    expect(call.status).toBe('error');
    expect(call.error).toContain('Workflow 已修改');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    expect(call.runId).toBeUndefined();
  });

  it('records a failed executable launch without an uncaught EPIPE or leaking keys', async () => {
    vi.stubEnv('TANTEI_PYTHON', path.join(dir, 'does-not-exist'));
    await new AudioRunner(store, (event) => events.push(event)).execute(
      task,
      call,
      new AbortController().signal,
    );
    expect(call.status).toBe('error');
    expect(call.error).toContain('ENOENT');
    expect(JSON.stringify(events)).not.toContain('dograh-runner-secret');
    expect(
      (await fs.stat(path.join(store.callDir(call.id), 'metadata.json'))).size,
    ).toBeGreaterThan(0);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStore } from './store.js';
import type { TestTask, CallRecord } from '../shared/types.js';
import { dograhCredential, updateDograhConnection } from './connection.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
const task: TestTask = {
  id: 'task_one',
  name: 'Taxi',
  workflowId: 1,
  workflowName: 'Taxi',
  requirement: 'wait',
  language: 'ja',
  concurrency: 2,
  maxCalls: 5,
  maxDurationSeconds: 60,
  maxVoiceMinutes: 10,
  rules: {
    callerInstructions: 'caller',
    responseTimeoutSeconds: null,
    assertions: [],
    interpretation: '',
    source: 'manual',
  },
  status: 'running',
  createdAt: '',
  completedCalls: 1,
  failedCalls: 0,
  consumedSeconds: 20,
};

describe('local evidence recovery', () => {
  it('defaults new installs to token while preserving a saved legacy API key and voice settings', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-store-test-'));
    directories.push(dir);
    const fresh = new LocalStore(dir);
    await fresh.init();
    expect(fresh.settings.dograhAuthMode).toBe('token');
    expect(fresh.settings.maxConcurrency).toBe(10);
    await fresh.write('settings.json', {
      dograhBaseUrl: 'https://old.test/api/v1',
      dograhApiKey: 'dgr_old_key',
      openaiApiKey: 'sk-saved-voice',
      maxConcurrency: 5,
      voice: 'cedar',
    });
    const restored = new LocalStore(dir);
    await restored.init();
    expect(restored.settings).toMatchObject({
      dograhAuthMode: 'apiKey',
      dograhApiKey: 'dgr_old_key',
      openaiApiKey: 'sk-saved-voice',
      maxConcurrency: 5,
      voice: 'cedar',
    });
  });
  it('charges interrupted calls once and preserves their actual recorded duration', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-store-test-'));
    directories.push(dir);
    const store = new LocalStore(dir);
    await store.init();
    store.tasks = [structuredClone(task)];
    store.calls = [
      {
        id: 'call_one',
        taskId: task.id,
        workflowId: 1,
        status: 'running',
        startedAt: '',
        durationSeconds: 8,
      },
      {
        id: 'call_two',
        taskId: task.id,
        workflowId: 1,
        status: 'connecting',
        startedAt: '',
        durationSeconds: 0,
      },
    ] satisfies CallRecord[];
    await store.persist();
    const restored = new LocalStore(dir);
    await restored.init();
    expect(restored.tasks[0]).toMatchObject({
      status: 'paused',
      failedCalls: 2,
      consumedSeconds: 140,
      completedCalls: 1,
    });
    expect(restored.calls.map((c) => c.status)).toEqual(['interrupted', 'interrupted']);
    expect(restored.calls[0].durationSeconds).toBe(8);
    const secondRestart = new LocalStore(dir);
    await secondRestart.init();
    expect(secondRestart.tasks[0]).toMatchObject({ failedCalls: 2, consumedSeconds: 140 });
    expect((await fs.stat(path.join(dir, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects traversal in audio identifiers and retains workflow snapshot paths', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-store-test-'));
    directories.push(dir);
    const store = new LocalStore(dir);
    await store.init();
    expect(() => store.callDir('../../settings')).toThrow('无效通话 ID');
    expect(() => store.callDir('call/one')).toThrow('无效通话 ID');
    await store.write('calls/call_one/workflow.json', { workflowId: 1, hash: 'baseline' });
    expect(
      JSON.parse(await fs.readFile(path.join(store.callDir('call_one'), 'workflow.json'), 'utf8')),
    ).toEqual({ workflowId: 1, hash: 'baseline' });
  });

  it('marks interrupted pending evaluation unavailable without charging a completed call again', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-store-test-'));
    directories.push(dir);
    const store = new LocalStore(dir);
    await store.init();
    store.tasks = [structuredClone(task)];
    store.calls = [
      {
        id: 'completed_call',
        taskId: task.id,
        workflowId: 1,
        status: 'completed',
        startedAt: '',
        durationSeconds: 20,
        evaluationStatus: 'pending',
      },
    ];
    await store.persist();
    const restored = new LocalStore(dir);
    await restored.init();
    expect(restored.calls[0]).toMatchObject({
      status: 'completed',
      evaluationStatus: 'unavailable',
    });
    expect(restored.tasks[0]).toMatchObject({
      completedCalls: 1,
      failedCalls: 0,
      consumedSeconds: 20,
    });
    expect(restored.tasks[0].evaluationError).toContain('评审');
  });
});

describe('runtime environment settings', () => {
  async function localStore() {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-store-env-test-'));
    directories.push(dir);
    const store = new LocalStore(dir);
    await store.init();
    store.settings = {
      dograhBaseUrl: 'https://local.test/api/v1',
      dograhAuthMode: 'apiKey',
      dograhApiKey: 'dgr-local-key',
      dograhLoginToken: 'local-token',
      openaiApiKey: 'sk-local-voice',
      maxConcurrency: 4,
      voice: 'cedar',
    };
    await store.saveSettings();
    return store;
  }

  it('overrides runtime credentials without persisting environment values, preserving edits to other settings', async () => {
    const store = await localStore();
    store.configureEnvironment({
      dograhBaseUrl: 'https://env.test/workflow',
      dograhLoginToken: 'env-token',
      openaiApiKey: 'sk-env-voice',
      piOpenaiApiKey: 'sk-env-pi',
    });
    expect(store.settings).toMatchObject({
      dograhBaseUrl: 'https://env.test/api/v1',
      dograhAuthMode: 'token',
      dograhLoginToken: 'env-token',
      openaiApiKey: 'sk-env-voice',
    });
    expect(dograhCredential(store.settings)).toBe('env-token');
    expect(store.settings).not.toHaveProperty('piOpenaiApiKey');
    store.settings.voice = 'marin';
    store.settings.maxConcurrency = 7;
    await store.saveSettings();
    const raw = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
    expect(raw).not.toContain('env-token');
    expect(raw).not.toContain('sk-env');
    expect(raw).not.toContain('env.test');
    expect(JSON.parse(raw)).toMatchObject({
      dograhBaseUrl: 'https://local.test/api/v1',
      dograhLoginToken: 'local-token',
      dograhApiKey: 'dgr-local-key',
      openaiApiKey: 'sk-local-voice',
      voice: 'marin',
      maxConcurrency: 7,
    });
    expect(store.settings.openaiApiKey).toBe('sk-env-voice');
    const restored = new LocalStore(store.dir);
    await restored.init();
    restored.configureEnvironment({});
    expect(dograhCredential(restored.settings)).toBe('local-token');
    expect(restored.settings.voice).toBe('marin');
  });

  it('does not send a legacy unbound token or key to an environment-selected replacement server', async () => {
    const store = await localStore();
    store.configureEnvironment({ dograhBaseUrl: 'https://replacement.test' });
    expect(store.settings.dograhAuthMode).toBe('token');
    expect(store.settings.dograhLoginToken).toBe('local-token');
    expect(dograhCredential(store.settings)).toBe('');
    expect(dograhCredential(store.settings, 'apiKey')).toBe('');
    await store.saveSettings();
    const saved = await store.read<any>('settings.json', null);
    expect(saved).toMatchObject({
      dograhBaseUrl: 'https://local.test/api/v1',
      dograhLoginToken: 'local-token',
      dograhLoginTokenBaseUrl: 'https://local.test/api/v1',
      dograhApiKeyBaseUrl: 'https://local.test/api/v1',
    });
    store.configureEnvironment({});
    expect(dograhCredential(store.settings)).toBe('local-token');
  });

  it('restores environment-managed fields even if runtime code tries to replace them', async () => {
    const store = await localStore();
    store.configureEnvironment({
      dograhBaseUrl: 'https://env.test',
      dograhLoginToken: 'env-token',
      openaiApiKey: 'sk-env-voice',
    });
    store.settings.dograhBaseUrl = 'https://other.test/api/v1';
    store.settings.dograhLoginToken = 'other-token';
    store.settings.dograhLoginTokenBaseUrl = 'https://other.test/api/v1';
    store.settings.openaiApiKey = 'sk-other';
    store.settings.dograhAuthMode = 'apiKey';
    await store.saveSettings();
    expect(store.settings).toMatchObject({
      dograhBaseUrl: 'https://env.test/api/v1',
      dograhLoginToken: 'env-token',
      dograhLoginTokenBaseUrl: 'https://env.test/api/v1',
      openaiApiKey: 'sk-env-voice',
      dograhAuthMode: 'token',
    });
    expect(await store.read('settings.json', {})).toMatchObject({
      dograhBaseUrl: 'https://local.test/api/v1',
      dograhLoginToken: 'local-token',
      openaiApiKey: 'sk-local-voice',
    });
  });

  it('keeps subsequent local connection and preference changes across saves and environment removal', async () => {
    const store = await localStore();
    store.configureEnvironment({ openaiApiKey: 'sk-env-voice' });
    store.settings = updateDograhConnection(store.settings, {
      dograhBaseUrl: 'https://new-local.test',
      dograhAuthMode: 'token',
      dograhLoginToken: 'new-local-token',
    });
    store.settings.maxConcurrency = 9;
    await store.saveSettings();
    store.settings.voice = 'marin';
    await store.saveSettings();
    store.configureEnvironment({});
    expect(store.settings).toMatchObject({
      dograhBaseUrl: 'https://new-local.test/api/v1',
      dograhLoginToken: 'new-local-token',
      openaiApiKey: 'sk-local-voice',
      maxConcurrency: 9,
      voice: 'marin',
    });
    expect(dograhCredential(store.settings)).toBe('new-local-token');
    expect(dograhCredential(store.settings, 'apiKey')).toBe('');
  });

  it('binds a locally entered token to the environment server without changing the local fallback server', async () => {
    const store = await localStore();
    store.configureEnvironment({ dograhBaseUrl: 'https://env.test' });
    store.settings = updateDograhConnection(store.settings, {
      dograhBaseUrl: store.settings.dograhBaseUrl,
      dograhAuthMode: 'token',
      dograhLoginToken: 'new-server-token',
    });
    expect(dograhCredential(store.settings)).toBe('new-server-token');
    await store.saveSettings();
    const restored = new LocalStore(store.dir);
    await restored.init();
    restored.configureEnvironment({});
    expect(restored.settings.dograhBaseUrl).toBe('https://local.test/api/v1');
    expect(restored.settings.dograhLoginToken).toBe('new-server-token');
    expect(dograhCredential(restored.settings)).toBe('');
    expect(dograhCredential(restored.settings, 'apiKey')).toBe('dgr-local-key');
  });

  it('binds an environment-only token to the existing local server', async () => {
    const store = await localStore();
    store.configureEnvironment({ dograhLoginToken: 'env-token' });
    expect(dograhCredential(store.settings)).toBe('env-token');
    store.settings.dograhBaseUrl = 'https://other.test/api/v1';
    await store.saveSettings();
    expect(dograhCredential(store.settings)).toBe('');
    const saved = await store.read<any>('settings.json', null);
    expect(saved.dograhLoginToken).toBe('local-token');
    expect(saved.dograhLoginTokenBaseUrl).toBe('https://local.test/api/v1');
    expect(dograhCredential(saved)).toBe('');
  });

  it.each([false, true])(
    'only accepts a first server for an environment-only token (fresh store: %s)',
    async (fresh) => {
      const store = await localStore();
      if (fresh) {
        store.settings.dograhBaseUrl = '';
        store.settings.dograhLoginToken = '';
        store.settings.dograhApiKey = '';
        await store.saveSettings();
      }
      store.configureEnvironment({ dograhLoginToken: 'env-token' });
      store.settings = updateDograhConnection(store.settings, {
        dograhBaseUrl: 'https://selected.test/workflow',
        dograhAuthMode: 'token',
        dograhLoginToken: 'env-token',
      });
      await store.saveSettings();
      expect(dograhCredential(store.settings)).toBe(fresh ? 'env-token' : '');
      expect(store.settings.dograhLoginTokenBaseUrl).toBe(
        fresh ? 'https://selected.test/api/v1' : 'https://local.test/api/v1',
      );
      const raw = await fs.readFile(path.join(store.dir, 'settings.json'), 'utf8');
      expect(raw).not.toContain('env-token');
      const saved = JSON.parse(raw);
      expect(saved.dograhBaseUrl).toBe('https://selected.test/api/v1');
      expect(saved.dograhLoginToken).toBe(fresh ? '' : 'local-token');
      expect(dograhCredential(saved)).toBe('');
    },
  );
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_CONCURRENCY } from '../shared/limits.js';
import type { Settings, TestTask, CallRecord, Finding } from '../shared/types.js';
import { normalizeApiBaseUrl } from './dograh.js';
import { readEnvironmentConfig, type EnvironmentConfig } from './environment.js';

export class LocalStore {
  settings: Settings = {
    dograhBaseUrl: '',
    dograhAuthMode: 'token',
    dograhLoginToken: '',
    dograhApiKey: '',
    openaiApiKey: '',
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    voice: 'marin',
  };
  tasks: TestTask[] = [];
  calls: CallRecord[] = [];
  findings: Finding[] = [];
  private writes: Promise<void> = Promise.resolve();
  private localSettings?: Settings;
  private environmentSettings: Partial<Settings> = {};
  constructor(readonly dir: string) {}
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    const saved = await this.read<Partial<Settings>>('settings.json', {});
    this.settings = {
      ...this.settings,
      ...saved,
      dograhAuthMode: saved.dograhAuthMode ?? (saved.dograhApiKey ? 'apiKey' : 'token'),
    };
    const state = await this.read('state.json', { tasks: [], calls: [], findings: [] });
    this.tasks = state.tasks;
    this.calls = state.calls;
    this.findings = state.findings;
    for (const task of this.tasks)
      if (task.status === 'running') {
        task.status = 'paused';
        task.pauseReason = '应用重启后已暂停；确认后恢复测试。';
      }
    for (const call of this.calls)
      if (['connecting', 'running'].includes(call.status)) {
        call.status = 'interrupted';
        call.error = '本地进程中断；此通话不能恢复。';
        call.endedAt = new Date().toISOString();
        // A crashed worker may have consumed its full reservation without a final
        // usage event. Persist this status transition and accounting together;
        // subsequent restarts must not refund or charge the same call again.
        const task = this.tasks.find((task) => task.id === call.taskId);
        if (task) {
          task.failedCalls++;
          task.consumedSeconds += Math.max(task.maxDurationSeconds, call.durationSeconds);
        }
      }
    for (const call of this.calls)
      if (call.evaluationStatus === 'pending') {
        call.evaluationStatus = 'unavailable';
        const task = this.tasks.find((task) => task.id === call.taskId);
        if (task)
          task.evaluationError = '应用重启中断了评审；录音和原始证据仍保留，此通话尚未完成评审。';
      }
    for (const call of this.calls) {
      if (call.jevEvaluation?.status === 'pending')
        call.jevEvaluation = {
          status: 'unavailable',
          generatedAt: new Date().toISOString(),
          error: 'Jev 判断被中断。',
        };
    }
    await this.persist();
  }
  /** Apply runtime-only values after init; keep local credentials bound to their original server. */
  configureEnvironment(input: EnvironmentConfig): void {
    const env = readEnvironmentConfig({
      DOGRAH_BASE_URL: input.dograhBaseUrl,
      DOGRAH_LOGIN_TOKEN: input.dograhLoginToken,
      OPENAI_API_KEY: input.openaiApiKey,
      TYPESAFE_API_KEY: input.typesafeApiKey,
      PI_OPENAI_API_KEY: input.piOpenaiApiKey,
    });
    const local = { ...(this.localSettings ?? this.settings) };
    let localBase = '';
    if (local.dograhBaseUrl) {
      try {
        localBase = normalizeApiBaseUrl(local.dograhBaseUrl);
      } catch {
        /* A malformed old address must never authorize a credential at a new address. */
      }
    }
    if (local.dograhApiKey && local.dograhApiKeyBaseUrl === undefined)
      local.dograhApiKeyBaseUrl = localBase;
    if (local.dograhLoginToken && local.dograhLoginTokenBaseUrl === undefined)
      local.dograhLoginTokenBaseUrl = localBase;
    this.localSettings = local;
    this.environmentSettings = {};
    if (env.dograhBaseUrl) this.environmentSettings.dograhBaseUrl = env.dograhBaseUrl;
    if (env.dograhLoginToken) {
      this.environmentSettings.dograhLoginToken = env.dograhLoginToken;
      this.environmentSettings.dograhLoginTokenBaseUrl = env.dograhBaseUrl ?? localBase;
    }
    if (env.typesafeApiKey) this.environmentSettings.typesafeApiKey = env.typesafeApiKey;
    if (env.openaiApiKey) this.environmentSettings.openaiApiKey = env.openaiApiKey;
    this.settings = { ...local, ...this.environmentSettings, dograhAuthMode: 'token' };
  }
  async read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') return fallback;
      throw new Error(`无法读取本地数据 ${name}，请保留文件后检查格式。`);
    }
  }
  async write(name: string, value: unknown) {
    const serialized = JSON.stringify(value, null, 2);
    const op = this.writes.then(async () => {
      const dest = path.join(this.dir, name);
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const temp = dest + '.tmp';
      await fs.writeFile(temp, serialized, { mode: 0o600 });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, dest);
    });
    this.writes = op.catch(() => {});
    await op;
  }
  persist() {
    return this.write('state.json', {
      tasks: this.tasks,
      calls: this.calls,
      findings: this.findings,
    });
  }
  async saveSettings() {
    if (!this.localSettings) return this.write('settings.json', this.settings);
    // With only an environment token and no initial local address, the settings
    // route may explicitly supply its first server via updateDograhConnection.
    // Once bound, the environment token cannot migrate through local settings.
    if (
      this.environmentSettings.dograhLoginToken &&
      !this.environmentSettings.dograhBaseUrl &&
      this.environmentSettings.dograhLoginTokenBaseUrl === '' &&
      this.settings.dograhLoginToken === this.environmentSettings.dograhLoginToken
    ) {
      let selectedBase = '';
      try {
        if (this.settings.dograhBaseUrl)
          selectedBase = normalizeApiBaseUrl(this.settings.dograhBaseUrl);
      } catch {
        /* Leave an invalid first address unbound. */
      }
      if (selectedBase && this.settings.dograhLoginTokenBaseUrl === selectedBase) {
        this.environmentSettings.dograhLoginTokenBaseUrl = selectedBase;
      }
    }
    // Restore only environment-managed fields to their local baseline. Other
    // runtime edits (voice, concurrency, locally entered keys) remain savable.
    const baseline = this.localSettings as unknown as Record<string, unknown>;
    const restored = Object.fromEntries(
      Object.keys(this.environmentSettings).map((field) => [field, baseline[field]]),
    );
    const local: Settings = { ...this.settings, ...restored, dograhAuthMode: 'token' };
    this.settings = { ...this.settings, ...this.environmentSettings, dograhAuthMode: 'token' };
    await this.write('settings.json', local);
    this.localSettings = local;
  }
  callDir(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效通话 ID');
    return path.join(this.dir, 'calls', id);
  }
}

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ModelRuntime,
  ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import {
  parsePiJson,
  PI_DEFAULT_MODEL_ID,
  PI_DEFAULT_MODELS,
  PiService,
  type PiDependencies,
  type PiEvent,
  type PiSelection,
  type PiToolSpec,
} from './pi.js';

type Interaction = Parameters<ModelRuntime['login']>[2];
const model = { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 1000 };
const alternativeModel = { ...model, id: 'different-first-model', name: 'Different Model' };
const codexModel = { ...model, provider: 'openai-codex' };
const anthropicModel = {
  ...model,
  provider: 'anthropic',
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
};

async function fixture(
  options: {
    connected?: boolean;
    tools?: PiToolSpec[];
    environmentApiKey?: string;
    environmentAnthropicApiKey?: string;
    selection?: PiSelection;
    models?: (typeof model)[];
    credentials?: Array<{ providerId: string; type: 'api_key' | 'oauth' }>;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tantei-pi-test-'));
  if (options.selection) {
    await mkdir(join(dataDir, 'pi'));
    await writeFile(join(dataDir, 'pi', 'selection.json'), JSON.stringify(options.selection));
  }
  const events: PiEvent[] = [];
  const credentials: Array<{ providerId: string; type: 'api_key' | 'oauth' }> =
    options.credentials ??
    (options.connected === false ? [] : [{ providerId: 'openai', type: 'api_key' }]);
  const models = options.models ?? [alternativeModel, model, codexModel, anthropicModel];
  const runtimeKeys = new Map<string, string>();
  const runtime = {
    listCredentials: vi.fn(async () => [
      ...new Map(
        [
          ...credentials,
          ...[...runtimeKeys.keys()].map((providerId) => ({
            providerId,
            type: 'api_key' as const,
          })),
        ].map((item) => [item.providerId, item]),
      ).values(),
    ]),
    setRuntimeApiKey: vi.fn(async (providerId: string, key: string) => {
      runtimeKeys.set(providerId, key);
    }),
    getModels: vi.fn((provider?: string) =>
      models.filter((model) => !provider || model.provider === provider),
    ),
    getModel: vi.fn((provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    ),
    login: vi.fn(
      async (providerId: string, type: 'api_key' | 'oauth', interaction: Interaction) => {
        if (type === 'api_key') await interaction.prompt({ type: 'secret', message: 'API key' });
        credentials.push({ providerId, type });
        return type === 'api_key'
          ? { type, key: 'not-returned-to-the-ui' }
          : { type, access: 'secret', refresh: 'secret', expires: 1 };
      },
    ),
  };
  const sessions: Array<{
    options: CreateAgentSessionOptions;
    sessionId: string;
    messages: Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
      errorMessage?: string;
    }>;
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const dependencies: PiDependencies = {
    createRuntime: vi.fn(async () => runtime as unknown as ModelRuntime),
    createSession: vi.fn(async (sessionOptions) => {
      const session = {
        options: sessionOptions,
        sessionId: `session-${sessions.length}`,
        messages: [] as (typeof sessions)[number]['messages'],
        prompt: vi.fn(async () => {
          session.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: '{"ok":true}' }],
          });
        }),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
        setModel: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
      };
      sessions.push(session);
      return session as unknown as AgentSession;
    }),
    resources: vi.fn(
      async (systemPrompt) => ({ getSystemPrompt: () => systemPrompt }) as ResourceLoader,
    ),
    sessionManager: vi.fn(async () => undefined),
    settings: vi.fn(async () => undefined),
  };
  const service = new PiService({
    dataDir,
    emit: (event) => events.push(event),
    tools: options.tools,
    environmentApiKey: options.environmentApiKey,
    environmentAnthropicApiKey: options.environmentAnthropicApiKey,
    dependencies,
  });
  return { service, events, runtime, runtimeKeys, dependencies, sessions, dataDir };
}

describe('Pi application boundary', () => {
  it('selects Sol explicitly instead of the first catalog model', async () => {
    const f = await fixture();
    expect((await f.service.status()).model).toEqual({
      provider: 'openai',
      id: PI_DEFAULT_MODEL_ID,
    });
    await f.service.complete('Use the selected default');
    expect(f.sessions[0]!.options.model?.id).toBe('gpt-5.6-sol');
    expect(f.sessions[0]!.options.model?.id).not.toBe(alternativeModel.id);
  });

  it('connects an explicit environment key only to OpenAI and keeps it out of UI metadata', async () => {
    const key = 'sk-environment_test_key';
    const f = await fixture({ connected: false, environmentApiKey: ` ${key} ` });
    const status = await f.service.status();
    expect(status.environmentApiKeySet).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.model).toEqual({ provider: 'openai', id: PI_DEFAULT_MODEL_ID });
    expect(status.providers.find((item) => item.id === 'openai')).toMatchObject({
      configured: true,
      authType: 'api_key',
      authSource: 'environment',
    });
    expect(status.providers.find((item) => item.id === 'openai-codex')?.configured).toBe(false);
    expect(status.providers.find((item) => item.id === 'anthropic')?.configured).toBe(false);
    expect(f.runtime.setRuntimeApiKey).toHaveBeenCalledExactlyOnceWith('openai', key);
    expect(f.runtime.login).not.toHaveBeenCalled();
    expect(JSON.stringify({ status, events: f.events })).not.toContain(key);
    await f.service.complete('Analyze with an installation-scoped key');
    expect(f.sessions[0]!.options.model?.provider).toBe('openai');
    await expect(readFile(join(f.dataDir, 'pi', 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(f.dataDir, 'pi', 'selection.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves a saved provider and manual model selection when an environment key is added', async () => {
    const selection = { provider: 'openai-codex' as const, id: 'explicit-codex-model' };
    const f = await fixture({
      environmentApiKey: 'sk-environment_test_key',
      selection,
      models: [alternativeModel, model, { ...codexModel, id: selection.id }],
      credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    });
    expect((await f.service.status()).model).toEqual(selection);
    await f.service.complete('Use the saved provider');
    expect(f.sessions[0]!.options.model).toMatchObject(selection);
    expect(JSON.parse(await readFile(join(f.dataDir, 'pi', 'selection.json'), 'utf8'))).toEqual(
      selection,
    );
    expect(
      (await f.service.status()).providers.find((item) => item.id === 'openai-codex'),
    ).toMatchObject({ authType: 'oauth', authSource: 'stored' });
  });

  it('rejects a conflicting UI OpenAI key while environment auth is active, without blocking other providers', async () => {
    const f = await fixture({ environmentApiKey: 'sk-environment_test_key' });
    await expect(f.service.configureApiKey('sk-ui_key_not_applied')).rejects.toThrow(
      'environment configuration',
    );
    expect(f.runtime.login).not.toHaveBeenCalled();
    await f.service.setModel('openai', alternativeModel.id);
    await f.service.configureApiKey('sk-anthropic_test_key', 'anthropic');
    expect(f.runtime.login).toHaveBeenCalledOnce();
    expect(f.runtime.login.mock.calls[0]![0]).toBe('anthropic');
    expect(f.runtimeKeys.get('openai')).toBe('sk-environment_test_key');
    expect((await f.service.status()).model?.id).toBe(alternativeModel.id);
  });

  it('fails explicitly when Sol is missing and allows an explicit alternative', async () => {
    const f = await fixture({ models: [alternativeModel] });
    const status = await f.service.status();
    expect(status.modelError).toContain('gpt-5.6-sol');
    await expect(f.service.complete('Do not fall back')).rejects.toThrow(
      'no fallback model was selected',
    );
    expect(f.dependencies.createSession).not.toHaveBeenCalled();
    await f.service.setModel('openai', alternativeModel.id);
    expect((await f.service.status()).modelError).toBeNull();
    await f.service.complete('Use explicitly chosen model');
    expect(f.sessions[0]!.options.model?.id).toBe(alternativeModel.id);
  });

  it('selects Sol after API configuration but retains an existing explicit alternative', async () => {
    const f = await fixture({ connected: false });
    await f.service.configureApiKey('sk-new_api_test_key');
    expect((await f.service.status()).model).toEqual({
      provider: 'openai',
      id: PI_DEFAULT_MODEL_ID,
    });
    await f.service.setModel('openai', alternativeModel.id);
    await f.service.configureApiKey('sk-replacement_test_key');
    expect((await f.service.status()).model?.id).toBe(alternativeModel.id);
  });

  it('selects Opus 5 for a newly configured Anthropic provider', async () => {
    const f = await fixture({ connected: false });
    await f.service.configureApiKey('sk-ant-test_anthropic_key', 'anthropic');
    expect((await f.service.status()).model).toEqual({
      provider: 'anthropic',
      id: PI_DEFAULT_MODELS.anthropic,
    });
    expect(
      (await f.service.status()).providers.find((item) => item.id === 'anthropic'),
    ).toMatchObject({ configured: true, authType: 'api_key', authSource: 'stored' });
    await f.service.complete('Analyze with the selected Claude model');
    expect(f.sessions[0]!.options.model).toMatchObject({
      provider: 'anthropic',
      id: 'claude-opus-5',
    });
    expect(JSON.parse(await readFile(join(f.dataDir, 'pi', 'selection.json'), 'utf8'))).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5',
    });
    expect(JSON.stringify(f.events)).not.toContain('sk-ant-test_anthropic_key');
  });

  it('selects Opus 5 for stored Anthropic credentials without a saved selection', async () => {
    const f = await fixture({ credentials: [{ providerId: 'anthropic', type: 'api_key' }] });
    expect((await f.service.status()).model).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5',
    });
    expect(f.runtime.login).not.toHaveBeenCalled();
  });

  it('loads an explicit Anthropic environment key without configuring OpenAI or persisting credentials', async () => {
    const key = 'sk-ant-environment_test_key';
    const f = await fixture({ connected: false, environmentAnthropicApiKey: ` ${key} ` });
    const status = await f.service.status();
    expect(status.environmentApiKeySet).toBe(false);
    expect(status.environmentAnthropicApiKeySet).toBe(true);
    expect(status.model).toEqual({ provider: 'anthropic', id: 'claude-opus-5' });
    expect(status.providers.find((item) => item.id === 'anthropic')).toMatchObject({
      configured: true,
      authSource: 'environment',
    });
    expect(status.providers.find((item) => item.id === 'openai')?.configured).toBe(false);
    expect(f.runtime.setRuntimeApiKey).toHaveBeenCalledExactlyOnceWith('anthropic', key);
    expect(f.runtime.login).not.toHaveBeenCalled();
    expect(JSON.stringify({ status, events: f.events })).not.toContain(key);
    await expect(readFile(join(f.dataDir, 'pi', 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(f.dataDir, 'pi', 'selection.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['openai', 'openai-codex', 'anthropic'] as const)(
    'preserves a saved %s model when adding Anthropic authentication',
    async (providerId) => {
      const selected = { provider: providerId, id: 'user-selected-model' };
      const f = await fixture({
        selection: selected,
        environmentAnthropicApiKey: 'sk-ant-environment_test_key',
        models: [model, codexModel, anthropicModel, { ...model, ...selected }],
        credentials: [{ providerId, type: providerId === 'openai-codex' ? 'oauth' : 'api_key' }],
      });
      expect((await f.service.status()).model).toEqual(selected);
      await f.service.complete('Keep the user selection');
      expect(f.sessions[0]!.options.model).toMatchObject(selected);
      expect(JSON.parse(await readFile(join(f.dataDir, 'pi', 'selection.json'), 'utf8'))).toEqual(
        selected,
      );
    },
  );

  it('keeps an explicit OpenAI model while saving a separate Anthropic key', async () => {
    const selected = { provider: 'openai' as const, id: alternativeModel.id };
    const f = await fixture({ selection: selected });
    await f.service.configureApiKey('sk-ant-new_test_key', 'anthropic');
    expect((await f.service.status()).model).toEqual(selected);
    expect(f.runtime.login.mock.calls[0]?.[0]).toBe('anthropic');
  });

  it('blocks changes to environment Anthropic auth but allows a separate OpenAI key', async () => {
    const f = await fixture({
      connected: false,
      environmentAnthropicApiKey: 'sk-ant-environment_test_key',
    });
    await expect(
      f.service.configureApiKey('sk-ant-replacement_test_key', 'anthropic'),
    ).rejects.toThrow('Anthropic API key from environment configuration');
    expect(f.runtime.login).not.toHaveBeenCalled();
    await f.service.setModel('anthropic', anthropicModel.id);
    await f.service.configureApiKey('sk-new_openai_test_key', 'openai');
    expect(f.runtime.login.mock.calls[0]?.[0]).toBe('openai');
    expect((await f.service.status()).model).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5',
    });
    expect(f.runtimeKeys.get('anthropic')).toBe('sk-ant-environment_test_key');
  });

  it('fails explicitly if Opus 5 is unavailable without selecting another model or saving a key', async () => {
    const f = await fixture({
      connected: false,
      models: [model, { ...anthropicModel, id: 'another-claude-model' }],
    });
    await expect(f.service.configureApiKey('sk-ant-new_test_key', 'anthropic')).rejects.toThrow(
      'claude-opus-5',
    );
    expect(f.runtime.login).not.toHaveBeenCalled();
    const fromEnvironment = await fixture({
      connected: false,
      environmentAnthropicApiKey: 'sk-ant-environment_test_key',
      models: [],
    });
    expect((await fromEnvironment.service.status()).modelError).toContain('claude-opus-5');
    await expect(fromEnvironment.service.complete('Do not fall back')).rejects.toThrow(
      'no fallback model was selected',
    );
    expect(fromEnvironment.dependencies.createSession).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic', 'both'] as const)(
    'uses the real SDK %s runtime overlay without changing persisted auth or unrelated providers',
    async (providerId) => {
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      const dataDir = await mkdtemp(join(tmpdir(), 'tantei-pi-runtime-test-'));
      await mkdir(join(dataDir, 'pi'));
      const authPath = join(dataDir, 'pi', 'auth.json');
      const stored = JSON.stringify(
        {
          openai: { type: 'api_key', key: 'sk-stored_openai_test_key' },
          anthropic: { type: 'api_key', key: 'sk-stored_anthropic_test_key' },
        },
        null,
        2,
      );
      await writeFile(authPath, stored);
      const f = await fixture();
      let runtime!: ModelRuntime;
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Network is forbidden in this credential test.'));
      const openaiKey = providerId !== 'anthropic' ? 'sk-runtime_only_test_key' : undefined;
      const anthropicKey = providerId !== 'openai' ? 'sk-ant-runtime_only_test_key' : undefined;
      const service = new PiService({
        dataDir,
        emit: (event) => f.events.push(event),
        environmentApiKey: openaiKey,
        environmentAnthropicApiKey: anthropicKey,
        dependencies: {
          ...f.dependencies,
          createRuntime: async (options) => {
            runtime = await ModelRuntime.create(options);
            return runtime;
          },
        },
      });
      try {
        const status = await service.status();
        expect(status.model).toEqual(
          providerId === 'anthropic'
            ? { provider: 'anthropic', id: 'claude-opus-5' }
            : { provider: 'openai', id: 'gpt-5.6-sol' },
        );
        expect((await runtime.getAuth('openai'))?.auth.apiKey).toBe(
          openaiKey ?? 'sk-stored_openai_test_key',
        );
        expect((await runtime.getAuth('anthropic'))?.auth.apiKey).toBe(
          anthropicKey ?? 'sk-stored_anthropic_test_key',
        );
        expect(status.providers.find((item) => item.id === 'openai')?.authSource).toBe(
          openaiKey ? 'environment' : 'stored',
        );
        expect(status.providers.find((item) => item.id === 'anthropic')?.authSource).toBe(
          anthropicKey ? 'environment' : 'stored',
        );
        expect(status.modelError).toBeNull();
        expect(await readFile(authPath, 'utf8')).toBe(stored);
        expect(JSON.stringify({ status, events: f.events })).not.toContain('sk-');
        expect(network).not.toHaveBeenCalled();
        expect(f.dependencies.createSession).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
        await service.dispose();
      }
    },
  );

  it('isolates runtime locations and refuses inference without an app-owned connection', async () => {
    const f = await fixture({ connected: false });
    expect((await f.service.status()).configured).toBe(false);
    await expect(f.service.chat('Inspect failures')).rejects.toThrow('Connect Codex');
    expect(f.dependencies.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        authPath: join(f.dataDir, 'pi', 'auth.json'),
        modelsPath: join(f.dataDir, 'pi', 'models.json'),
        modelsStorePath: join(f.dataDir, 'pi', 'models-store.json'),
        allowModelNetwork: false,
        refreshOnCreate: false,
      }),
    );
    expect(f.dependencies.createSession).not.toHaveBeenCalled();
    expect((await f.service.status()).busy).toBe(false);
  });

  it('deletes only the selected task conversation, including its saved session files', async () => {
    const f = await fixture();
    await f.service.chat('Task A', {}, 'task:a');
    await f.service.chat('Workbench', {}, 'workbench');
    const dirs = vi.mocked(f.dependencies.sessionManager).mock.calls.map((args) => args[1]);
    await writeFile(join(dirs[0]!, 'conversation.jsonl'), 'task history');
    await writeFile(join(dirs[1]!, 'conversation.jsonl'), 'workbench history');
    await f.service.deleteTaskConversation('a');
    await expect(readFile(join(dirs[0]!, 'conversation.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(dirs[1]!, 'conversation.jsonl'), 'utf8')).toBe('workbench history');
    expect(f.sessions[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.sessions[1]!.dispose).not.toHaveBeenCalled();
    const resumed = await f.service.chat('Continue', {}, 'workbench');
    expect(resumed.sessionId).toBe('session-1');
    const fresh = await f.service.chat('New A', {}, 'task:a');
    expect(fresh.sessionId).toBe('session-2');
  });

  it('keeps workbench and task conversations separate and resumes the matching session', async () => {
    const f = await fixture();
    const first = await f.service.chat('Task A first', { task: { id: 'a' } }, 'task:a');
    const second = await f.service.chat('Task B first', { task: { id: 'b' } }, 'task:b');
    const workbench = await f.service.chat('Workbench question', { task: null }, 'workbench');
    const resumed = await f.service.chat('Task A follow-up', { task: { id: 'a' } }, 'task:a');
    expect(new Set([first.sessionId, second.sessionId, workbench.sessionId]).size).toBe(3);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(f.sessions).toHaveLength(3);
    expect(f.sessions[0]!.prompt).toHaveBeenCalledTimes(2);
    expect(f.sessions[1]!.prompt).toHaveBeenCalledTimes(1);
    expect(f.sessions[2]!.prompt).toHaveBeenCalledTimes(1);
    await f.service.dispose();
    for (const session of f.sessions) expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('exposes only domain tools and forwards cancellation to their implementations', async () => {
    const execute = vi.fn(async () => ({ issues: ['latency'] }));
    const f = await fixture({
      tools: [
        {
          name: 'list_findings',
          description: 'Read findings',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute,
        },
      ],
    });
    await f.service.chat('Read the findings', { workflowId: 23 });
    const session = f.sessions[0]!;
    expect(session.options.tools).toEqual(['list_findings']);
    expect(session.options.noTools).toBe('builtin');
    expect(session.options.customTools).toHaveLength(1);
    const controller = new AbortController();
    const tool = session.options.customTools![0]!;
    const result = await tool.execute('call-1', {}, controller.signal, undefined, {} as never);
    expect(execute).toHaveBeenCalledWith({}, { signal: controller.signal });
    expect(result.content).toEqual([{ type: 'text', text: '{"issues":["latency"]}' }]);
    expect(f.dependencies.sessionManager).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('sessions'),
      true,
    );
  });

  it('uses an independent in-memory no-tool session for analysis and leaves chat history unchanged', async () => {
    const f = await fixture();
    await f.service.chat('Review current workflow');
    const before = f.sessions[0]!.messages.length;
    expect(await f.service.complete('Return JSON')).toBe('{"ok":true}');
    expect(f.sessions[1]!.options.tools).toEqual([]);
    expect(f.sessions[1]!.options.customTools).toEqual([]);
    expect(f.sessions[1]!.dispose).toHaveBeenCalledOnce();
    expect(f.sessions[0]!.messages).toHaveLength(before);
    expect(f.dependencies.sessionManager).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      false,
    );
    expect((await f.service.status()).sessionId).toBe('session-0');
  });

  it('never exposes API key values in auth events or error messages', async () => {
    const f = await fixture({ connected: false });
    const key = 'sk-valid_test_secret_key';
    await f.service.configureApiKey(key);
    expect(JSON.stringify(f.events)).not.toContain(key);
    f.runtime.login.mockRejectedValueOnce(new Error(`Provider rejected ${key}`));
    await expect(f.service.configureApiKey(key)).rejects.toThrow(
      'Provider rejected [redacted API key]',
    );
    await expect(f.service.configureApiKey('!cat ~/.ssh/id_rsa')).rejects.toThrow('valid API key');
  });

  it('bridges OAuth prompts, rejects duplicate logins and stale prompt responses', async () => {
    const f = await fixture({ connected: false });
    let answer = '';
    f.runtime.login.mockImplementationOnce(async (_provider, _type, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/start' });
      answer = await interaction.prompt({ type: 'manual_code', message: 'Paste callback URL' });
      return {
        type: 'oauth',
        access: 'hidden-access-token',
        refresh: 'hidden-refresh-token',
        expires: 1,
      };
    });
    const login = await f.service.startLogin();
    await expect(f.service.startLogin()).rejects.toThrow('already in progress');
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === 'pi.auth.prompt')).toBe(true),
    );
    const prompt = f.events.find((event) => event.type === 'pi.auth.prompt')!;
    expect(prompt.loginId).toBe(login.loginId);
    await f.service.answerLogin(prompt.promptId as string, 'callback-code');
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === 'pi.auth.complete')).toBe(true),
    );
    expect(answer).toBe('callback-code');
    expect(JSON.stringify(f.events)).not.toContain('hidden-access-token');
    await expect(f.service.answerLogin(prompt.promptId as string, 'again')).rejects.toThrow(
      'no longer active',
    );
  });

  it('cancels pending OAuth UI prompts and releases the login reservation', async () => {
    const f = await fixture({ connected: false });
    f.runtime.login.mockImplementationOnce(async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'Login method',
        options: [{ id: 'browser', label: 'Browser' }],
      });
      throw new Error('Should not be reached');
    });
    await f.service.startLogin();
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === 'pi.auth.prompt')).toBe(true),
    );
    await f.service.cancelLogin();
    expect((await f.service.status()).login).toBeNull();
    expect(f.events.some((event) => event.type === 'pi.auth.cancelled')).toBe(true);
  });

  it('honors stop requests while a chat session is still being created', async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = f.dependencies.createSession;
    f.dependencies.createSession = async (options) => {
      await pending;
      return create(options);
    };
    const chat = f.service.chat('Begin');
    const rejection = expect(chat).rejects.toThrow('cancelled');
    await f.service.abort();
    release();
    await rejection;
    expect(f.sessions[0]!.prompt).not.toHaveBeenCalled();
  });

  it('stops chat without cancelling an independent background evaluation', async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = f.dependencies.createSession;
    f.dependencies.createSession = async (options) => {
      const result = await create(options);
      const session = f.sessions.at(-1)!;
      session.prompt.mockImplementation(async () => {
        await pending;
        session.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: '{"ok":true}' }],
        });
      });
      return result;
    };
    const completion = f.service.complete('Evaluate independently');
    await vi.waitFor(() => expect(f.sessions[0]?.prompt).toHaveBeenCalledOnce());
    await f.service.abort();
    expect(f.sessions[0]!.abort).not.toHaveBeenCalled();
    release();
    expect(await completion).toBe('{"ok":true}');
  });

  it('prevents paid inference if disposal wins a race with helper session creation', async () => {
    const f = await fixture();
    let release!: () => void;
    let creating = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = f.dependencies.createSession;
    f.dependencies.createSession = async (options) => {
      creating = true;
      await pending;
      return create(options);
    };
    const completion = f.service.complete('Evaluate independently');
    const rejection = expect(completion).rejects.toThrow('closed');
    await vi.waitFor(() => expect(creating).toBe(true));
    await f.service.dispose();
    release();
    await rejection;
    expect(f.sessions[0]!.prompt).not.toHaveBeenCalled();
    expect(f.sessions[0]!.dispose).toHaveBeenCalledOnce();
  });

  it('aborts active background evaluation during application disposal', async () => {
    const f = await fixture();
    const create = f.dependencies.createSession;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.dependencies.createSession = async (options) => {
      const result = await create(options);
      const session = f.sessions.at(-1)!;
      session.prompt.mockImplementation(async () => {
        await pending;
      });
      session.abort.mockImplementation(async () => {
        release();
      });
      return result;
    };
    const completion = f.service.complete('Evaluate independently');
    const rejection = expect(completion).rejects.toThrow('closed');
    await vi.waitFor(() => expect(f.sessions[0]?.prompt).toHaveBeenCalledOnce());
    await f.service.dispose();
    await rejection;
    expect(f.sessions[0]!.abort).toHaveBeenCalledOnce();
  });

  it('rejects malformed analysis output instead of inventing a successful evaluation', () => {
    expect(parsePiJson('```json\n{"passed": false}\n```')).toEqual({ passed: false });
    expect(() => parsePiJson('Looks good: {"passed":true}')).toThrow();
    expect(() => parsePiJson('[]')).toThrow('JSON object');
    expect(() => parsePiJson('null')).toThrow('JSON object');
  });

  it('rejects built-in tool names even when supplied by an embedding application', () => {
    expect(
      () =>
        new PiService({
          dataDir: '/tmp/unused',
          emit: () => {},
          tools: [{ name: 'bash', description: 'No', parameters: {}, execute: async () => null }],
        }),
    ).toThrow('reserved');
  });
});

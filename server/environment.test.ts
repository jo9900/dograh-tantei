import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { environmentFlags, loadLocalEnvironment, readEnvironmentConfig } from './environment.js';

const directories: string[] = [];
beforeEach(() => vi.stubEnv('PI_ANTHROPIC_API_KEY', undefined));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('local environment configuration', () => {
  it('uses explicit project connections over wrong inherited shell keys while preserving shell priority for TANTEI fields', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-env-test-'));
    directories.push(dir);
    const file = path.join(dir, '.env');
    await fs.writeFile(
      file,
      'DOGRAH_BASE_URL=https://file.test/workflow\nDOGRAH_LOGIN_TOKEN="Bearer file-token"\nOPENAI_API_KEY=sk-file-voice\nPI_OPENAI_API_KEY=sk-file-pi\nTANTEI_PORT=4317\nTANTEI_DATA_DIR=/project/test-data\n',
    );
    vi.stubEnv('DOGRAH_BASE_URL', 'https://os.test/api');
    vi.stubEnv('DOGRAH_LOGIN_TOKEN', 'wrong-shell-token');
    vi.stubEnv('OPENAI_API_KEY', 'sk-wrong-shell-voice');
    vi.stubEnv('PI_OPENAI_API_KEY', 'sk-wrong-shell-pi');
    vi.stubEnv('TANTEI_PORT', '4321');
    vi.stubEnv('TANTEI_DATA_DIR', undefined);
    loadLocalEnvironment(file);
    expect(readEnvironmentConfig()).toEqual({
      dograhBaseUrl: 'https://file.test/api/v1',
      dograhLoginToken: 'file-token',
      openaiApiKey: 'sk-file-voice',
      piOpenaiApiKey: 'sk-file-pi',
    });
    expect(process.env.TANTEI_PORT).toBe('4321');
    expect(process.env.TANTEI_DATA_DIR).toBe('/project/test-data');
  });

  it('treats explicit blank project connection fields as absent instead of inheriting shell credentials', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-env-test-'));
    directories.push(dir);
    const file = path.join(dir, '.env');
    await fs.writeFile(
      file,
      'DOGRAH_BASE_URL=\nDOGRAH_LOGIN_TOKEN=""\nOPENAI_API_KEY=\nPI_OPENAI_API_KEY=" "\nTANTEI_PORT=4317\n',
    );
    vi.stubEnv('DOGRAH_BASE_URL', 'https://shell.test');
    vi.stubEnv('DOGRAH_LOGIN_TOKEN', 'shell-token');
    vi.stubEnv('OPENAI_API_KEY', 'sk-shell-voice');
    vi.stubEnv('PI_OPENAI_API_KEY', 'sk-shell-pi');
    vi.stubEnv('TANTEI_PORT', '');
    loadLocalEnvironment(file);
    expect(readEnvironmentConfig()).toEqual({});
    expect(process.env.OPENAI_API_KEY).toBe('');
    expect(process.env.PI_OPENAI_API_KEY).toBe(' ');
    expect(process.env.TANTEI_PORT).toBe('');
  });

  it('uses the project voice key for an explicitly blank Pi key instead of the inherited Pi key', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-env-test-'));
    directories.push(dir);
    const file = path.join(dir, '.env');
    await fs.writeFile(file, 'OPENAI_API_KEY=sk-project-voice\nPI_OPENAI_API_KEY=\n');
    vi.stubEnv('DOGRAH_BASE_URL', undefined);
    vi.stubEnv('DOGRAH_LOGIN_TOKEN', undefined);
    vi.stubEnv('OPENAI_API_KEY', 'sk-wrong-shell-voice');
    vi.stubEnv('PI_OPENAI_API_KEY', 'sk-wrong-shell-pi');
    loadLocalEnvironment(file);
    expect(readEnvironmentConfig()).toEqual({
      openaiApiKey: 'sk-project-voice',
      piOpenaiApiKey: 'sk-project-voice',
    });
  });

  it('keeps inherited connections when the file or individual fields are missing', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-env-test-'));
    directories.push(dir);
    const file = path.join(dir, '.env');
    vi.stubEnv('DOGRAH_BASE_URL', 'https://shell.test');
    vi.stubEnv('DOGRAH_LOGIN_TOKEN', 'shell-token');
    vi.stubEnv('OPENAI_API_KEY', 'sk-shell-voice');
    vi.stubEnv('PI_OPENAI_API_KEY', 'sk-shell-pi');
    loadLocalEnvironment(file);
    const expected = {
      dograhBaseUrl: 'https://shell.test/api/v1',
      dograhLoginToken: 'shell-token',
      openaiApiKey: 'sk-shell-voice',
      piOpenaiApiKey: 'sk-shell-pi',
    };
    expect(readEnvironmentConfig()).toEqual(expected);
    await fs.writeFile(file, 'DOGRAH_BASE_URL=https://project.test\n');
    loadLocalEnvironment(file);
    expect(readEnvironmentConfig()).toEqual({
      ...expected,
      dograhBaseUrl: 'https://project.test/api/v1',
    });
  });

  it('ignores a missing optional file and sanitizes other loading errors', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-env-test-'));
    directories.push(dir);
    expect(() => loadLocalEnvironment(path.join(dir, 'missing.env'))).not.toThrow();
    let message = '';
    try {
      loadLocalEnvironment(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('无法读取本地 .env 配置，请检查文件格式和读取权限。');
    expect(message).not.toContain(dir);
  });

  it('supports Pi-specific override, shared-key fallback and empty unconfigured values', () => {
    expect(
      readEnvironmentConfig({ OPENAI_API_KEY: ' sk-voice ', PI_OPENAI_API_KEY: 'sk-pi' }),
    ).toEqual({ openaiApiKey: 'sk-voice', piOpenaiApiKey: 'sk-pi' });
    expect(readEnvironmentConfig({ OPENAI_API_KEY: 'sk-voice', PI_OPENAI_API_KEY: '   ' })).toEqual(
      { openaiApiKey: 'sk-voice', piOpenaiApiKey: 'sk-voice' },
    );
    expect(
      readEnvironmentConfig({
        DOGRAH_BASE_URL: ' ',
        DOGRAH_LOGIN_TOKEN: '\t',
        OPENAI_API_KEY: '',
        PI_OPENAI_API_KEY: ' ',
      }),
    ).toEqual({});
    expect(readEnvironmentConfig({ DOGRAH_LOGIN_TOKEN: 'dograh_auth_token=token-value' })).toEqual({
      dograhLoginToken: 'token-value',
    });
  });

  it('returns only boolean readonly flags, including the inherited Pi key', () => {
    const config = readEnvironmentConfig({
      DOGRAH_LOGIN_TOKEN: 'secret-token',
      OPENAI_API_KEY: 'sk-secret',
    });
    expect(environmentFlags(config)).toEqual({
      dograhBaseUrl: false,
      dograhLoginToken: true,
      openaiApiKey: true,
      piOpenaiApiKey: true,
      piAnthropicApiKey: false,
      typesafeApiKey: false,
    });
    expect(environmentFlags({ PI_OPENAI_API_KEY: 'sk-pi' })).toEqual({
      dograhBaseUrl: false,
      dograhLoginToken: false,
      openaiApiKey: false,
      piOpenaiApiKey: true,
      piAnthropicApiKey: false,
      typesafeApiKey: false,
    });
    expect(environmentFlags({})).toEqual({
      dograhBaseUrl: false,
      dograhLoginToken: false,
      openaiApiKey: false,
      piOpenaiApiKey: false,
      piAnthropicApiKey: false,
      typesafeApiKey: false,
    });
    expect(JSON.stringify(environmentFlags(config))).not.toContain('secret');
  });

  it('loads Claude independently and lets an explicit project value override an inherited Claude key', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tantei-env-test-'));
    directories.push(dir);
    const file = path.join(dir, '.env');
    vi.stubEnv('PI_ANTHROPIC_API_KEY', 'sk-ant-shell');
    await fs.writeFile(file, 'PI_ANTHROPIC_API_KEY=sk-ant-project\n');
    loadLocalEnvironment(file);
    expect(
      readEnvironmentConfig({ PI_ANTHROPIC_API_KEY: process.env.PI_ANTHROPIC_API_KEY }),
    ).toEqual({ piAnthropicApiKey: 'sk-ant-project' });
    expect(environmentFlags({ piAnthropicApiKey: 'sk-ant-project' })).toMatchObject({
      piAnthropicApiKey: true,
      piOpenaiApiKey: false,
      openaiApiKey: false,
    });
    await fs.writeFile(file, 'PI_ANTHROPIC_API_KEY=\n');
    loadLocalEnvironment(file);
    expect(
      readEnvironmentConfig({ PI_ANTHROPIC_API_KEY: process.env.PI_ANTHROPIC_API_KEY }),
    ).toEqual({});
    expect(readEnvironmentConfig({ OPENAI_API_KEY: 'sk-openai' })).not.toHaveProperty(
      'piAnthropicApiKey',
    );
  });

  it.each([
    { DOGRAH_BASE_URL: 'https://user:secret@example.test' },
    { DOGRAH_BASE_URL: 'https://example.test?token=secret' },
    { DOGRAH_BASE_URL: 'https://example.test\nsecret' },
    { DOGRAH_LOGIN_TOKEN: 'secret\nheader' },
    { DOGRAH_LOGIN_TOKEN: 'secret; another=cookie' },
    { OPENAI_API_KEY: 'sk-secret\n' },
    { PI_OPENAI_API_KEY: 'sk-secret with spaces' },
    { PI_ANTHROPIC_API_KEY: 'sk-secret with spaces' },
  ])('rejects invalid config without echoing its value', (env) => {
    let message = '';
    try {
      readEnvironmentConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('格式不正确');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('example.test');
  });
});

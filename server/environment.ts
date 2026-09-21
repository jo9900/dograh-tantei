import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { normalizeApiBaseUrl } from './dograh.js';
import { normalizeLoginToken } from './dograh-auth.js';

export interface EnvironmentConfig {
  dograhBaseUrl?: string;
  dograhLoginToken?: string;
  openaiApiKey?: string;
  piOpenaiApiKey?: string;
  piAnthropicApiKey?: string;
  typesafeApiKey?: string;
}
export type EnvironmentFlags = { [Field in keyof Required<EnvironmentConfig>]: boolean };

const PROJECT_CONNECTION_FIELDS = new Set([
  'DOGRAH_BASE_URL',
  'DOGRAH_LOGIN_TOKEN',
  'OPENAI_API_KEY',
  'PI_OPENAI_API_KEY',
  'PI_ANTHROPIC_API_KEY',
  'TYPESAFE_API_KEY',
]);

/** Explicit project connections override inherited shell values; other fields retain shell priority. */
export function loadLocalEnvironment(
  file = fileURLToPath(new URL('../.env', import.meta.url)),
): void {
  try {
    const local = parseEnv(readFileSync(file, 'utf8'));
    for (const [name, value] of Object.entries(local)) {
      // Presence matters: an explicit empty project value must also block the
      // inherited credential. readEnvironmentConfig applies normal fallback.
      if (PROJECT_CONNECTION_FIELDS.has(name) || process.env[name] === undefined)
        process.env[name] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('无法读取本地 .env 配置，请检查文件格式和读取权限。');
  }
}

function configured(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function apiKey(
  value: string | undefined,
  name: 'OPENAI_API_KEY' | 'PI_OPENAI_API_KEY' | 'PI_ANTHROPIC_API_KEY' | 'TYPESAFE_API_KEY',
): string | undefined {
  const raw = configured(value);
  if (raw === undefined) return undefined;
  if (
    raw.length > 16_384 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(raw) ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(raw.trim())
  ) {
    throw new Error(`${name} 格式不正确，请填写单个 API Key。`);
  }
  return raw.trim();
}

/** Validate without echoing potentially credential-bearing input or native errors. */
export function readEnvironmentConfig(env: NodeJS.ProcessEnv = process.env): EnvironmentConfig {
  const result: EnvironmentConfig = {};
  const base = configured(env.DOGRAH_BASE_URL);
  if (base !== undefined) {
    try {
      if (base.length > 2_000 || /[\u0000-\u001f\u007f-\u009f]/.test(base)) throw new Error();
      result.dograhBaseUrl = normalizeApiBaseUrl(base);
    } catch {
      throw new Error(
        'DOGRAH_BASE_URL 格式不正确，请填写不含凭据、查询参数或片段的 HTTP(S) 地址。',
      );
    }
  }
  const token = configured(env.DOGRAH_LOGIN_TOKEN);
  if (token !== undefined) {
    try {
      result.dograhLoginToken = normalizeLoginToken(token);
    } catch {
      throw new Error('DOGRAH_LOGIN_TOKEN 格式不正确，请填写单个登录 Token。');
    }
  }
  const voiceKey = apiKey(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const piKey = apiKey(env.PI_OPENAI_API_KEY, 'PI_OPENAI_API_KEY') ?? voiceKey;
  if (voiceKey !== undefined) result.openaiApiKey = voiceKey;
  if (piKey !== undefined) result.piOpenaiApiKey = piKey;
  const anthropicKey = apiKey(env.PI_ANTHROPIC_API_KEY, 'PI_ANTHROPIC_API_KEY');
  if (anthropicKey !== undefined) result.piAnthropicApiKey = anthropicKey;
  const typesafeKey = apiKey(env.TYPESAFE_API_KEY, 'TYPESAFE_API_KEY');
  if (typesafeKey !== undefined) result.typesafeApiKey = typesafeKey;
  return result;
}

/** Expose only field-management flags, never the values themselves. */
export function environmentFlags(
  env: EnvironmentConfig | NodeJS.ProcessEnv = process.env,
): EnvironmentFlags {
  const fields = [
    'dograhBaseUrl',
    'dograhLoginToken',
    'openaiApiKey',
    'piOpenaiApiKey',
    'piAnthropicApiKey',
    'typesafeApiKey',
  ] as const;
  const config = fields.some((field) => field in env)
    ? (env as EnvironmentConfig)
    : readEnvironmentConfig(env as NodeJS.ProcessEnv);
  return {
    dograhBaseUrl: !!configured(config.dograhBaseUrl),
    dograhLoginToken: !!configured(config.dograhLoginToken),
    openaiApiKey: !!configured(config.openaiApiKey),
    piOpenaiApiKey: !!configured(config.piOpenaiApiKey),
    piAnthropicApiKey: !!configured(config.piAnthropicApiKey),
    typesafeApiKey: !!configured(config.typesafeApiKey),
  };
}

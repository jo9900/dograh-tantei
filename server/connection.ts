import { createHash } from 'node:crypto';
import type { Settings } from '../shared/types.js';
import { normalizeApiBaseUrl } from './dograh.js';
import { normalizeDograhCredential, type DograhAuthMode } from './dograh-auth.js';

/** Missing mode is the original API-key-only format. New stores choose token. */
export const dograhAuthMode = (settings: Settings): DograhAuthMode =>
  settings.dograhAuthMode ?? 'apiKey';
export function dograhCredential(settings: Settings, mode = dograhAuthMode(settings)): string {
  const value = mode === 'token' ? settings.dograhLoginToken : settings.dograhApiKey;
  const binding =
    mode === 'token' ? settings.dograhLoginTokenBaseUrl : settings.dograhApiKeyBaseUrl;
  if (!value || !settings.dograhBaseUrl) return '';
  if (binding !== undefined && binding !== normalizeApiBaseUrl(settings.dograhBaseUrl)) return '';
  return value;
}
export function dograhClientConfig(settings: Settings) {
  const authMode = dograhAuthMode(settings),
    credential = dograhCredential(settings);
  return {
    baseUrl: settings.dograhBaseUrl,
    authMode,
    ...(authMode === 'token' ? { loginToken: credential } : { apiKey: credential }),
  };
}
/** Keep existing key-based task fingerprints stable after upgrading. */
export const connectionFingerprint = (
  baseUrl: string,
  credential: string,
  mode: DograhAuthMode = 'apiKey',
) =>
  createHash('sha256')
    .update(baseUrl + '\n' + (mode === 'token' ? 'token\n' : '') + credential)
    .digest('hex');
export const settingsFingerprint = (settings: Settings) =>
  connectionFingerprint(
    settings.dograhBaseUrl,
    dograhCredential(settings),
    dograhAuthMode(settings),
  );
export const connectionSecrets = (settings: Settings) => [
  settings.dograhApiKey,
  settings.dograhLoginToken ?? '',
  settings.openaiApiKey,
];

type ConnectionUpdate = {
  dograhBaseUrl: string;
  dograhAuthMode?: DograhAuthMode;
  dograhApiKey?: string;
  dograhLoginToken?: string;
};
export function updateDograhConnection(settings: Settings, input: ConnectionUpdate): Settings {
  const base = input.dograhBaseUrl ? normalizeApiBaseUrl(input.dograhBaseUrl) : '';
  const priorBase = settings.dograhBaseUrl ? normalizeApiBaseUrl(settings.dograhBaseUrl) : '';
  const keyInput = input.dograhApiKey?.trim() ?? '',
    tokenInput = input.dograhLoginToken?.trim() ?? '';
  // Retain compatibility with callers of the original settings API.
  const mode =
    input.dograhAuthMode ?? (keyInput && !tokenInput ? 'apiKey' : dograhAuthMode(settings));
  const provided = mode === 'token' ? tokenInput : keyInput;
  if (base !== priorBase && dograhCredential(settings) && !provided)
    throw new Error('更换 Dograh 地址时请重新输入该服务器的登录 Token 或 API Key。');
  const next: Settings = { ...settings, dograhBaseUrl: base, dograhAuthMode: mode };
  // Preserve inactive credentials, bound to their original API server. They
  // cannot become credentials for a different server merely by switching mode.
  if (settings.dograhApiKey && next.dograhApiKeyBaseUrl === undefined)
    next.dograhApiKeyBaseUrl = priorBase;
  if (settings.dograhLoginToken && next.dograhLoginTokenBaseUrl === undefined)
    next.dograhLoginTokenBaseUrl = priorBase;
  if (keyInput) {
    next.dograhApiKey = normalizeDograhCredential('apiKey', input.dograhApiKey!);
    next.dograhApiKeyBaseUrl = base;
  }
  if (tokenInput) {
    next.dograhLoginToken = normalizeDograhCredential('token', input.dograhLoginToken!);
    next.dograhLoginTokenBaseUrl = base;
  }
  return next;
}

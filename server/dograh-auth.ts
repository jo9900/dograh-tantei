export type DograhAuthMode = 'apiKey' | 'token';

export class DograhAuthError extends Error {
  readonly code: 'INVALID_API_KEY' | 'INVALID_LOGIN_TOKEN' | 'INVALID_AUTH_MODE';
  constructor(code: DograhAuthError['code'], message: string) {
    super(message);
    this.name = 'DograhAuthError';
    this.code = code;
  }
}

// RFC 6750 b64token accepts JWTs and opaque bearer tokens without assuming a
// particular identity provider, signature format, or expiry claim.
const TOKEN_VALUE = /^[A-Za-z0-9._~+/-]+=*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function cleanInput(value: string, mode: DograhAuthMode): string {
  const code = mode === 'token' ? 'INVALID_LOGIN_TOKEN' : 'INVALID_API_KEY';
  const label = mode === 'token' ? 'Dograh 登录 Token' : 'Dograh API Key';
  if (typeof value !== 'string' || !value.trim()) {
    throw new DograhAuthError(code, `请填写${label}。`);
  }
  // Check before trim: never hide a copied CR/LF or other header control byte.
  if (value.length > 16_384 || CONTROL_CHARACTERS.test(value)) {
    throw new DograhAuthError(
      code,
      `${label} 格式不正确，请只粘贴单个凭据，不要粘贴换行或整条请求。`,
    );
  }
  return value.trim();
}

/** Accept one raw token, Bearer value, or Dograh login-cookie assignment. */
export function normalizeLoginToken(value: string): string {
  let token = cleanInput(value, 'token');
  if (/^Bearer(?: |$)/i.test(token)) token = token.replace(/^Bearer */i, '');
  else if (token.startsWith('dograh_auth_token=')) token = token.slice('dograh_auth_token='.length);
  if (!TOKEN_VALUE.test(token)) {
    throw new DograhAuthError(
      'INVALID_LOGIN_TOKEN',
      '登录 Token 格式不正确。请粘贴 Token 本身、Bearer Token，或单个 dograh_auth_token=Token；不要粘贴完整 curl 或 Cookie 列表。',
    );
  }
  return token;
}

export function normalizeDograhCredential(mode: DograhAuthMode, credential: string): string {
  if (mode === 'token') return normalizeLoginToken(credential);
  if (mode !== 'apiKey')
    throw new DograhAuthError('INVALID_AUTH_MODE', '请选择 API Key 或登录 Token 认证方式。');
  const key = cleanInput(credential, 'apiKey');
  if (!TOKEN_VALUE.test(key)) {
    throw new DograhAuthError(
      'INVALID_API_KEY',
      'Dograh API Key 格式不正确。请粘贴完整 API Key；使用浏览器登录 Token 时请选择 Token 认证。',
    );
  }
  return key;
}

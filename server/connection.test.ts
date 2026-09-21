import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  dograhCredential,
  dograhClientConfig,
  settingsFingerprint,
  updateDograhConnection,
} from './connection.js';
import type { Settings } from '../shared/types.js';

const original: Settings = {
  dograhBaseUrl: 'https://old.example/api/v1',
  dograhApiKey: 'dgr_saved_key',
  openaiApiKey: 'sk-voice-saved',
  maxConcurrency: 5,
  voice: 'marin',
};
describe('Dograh connection mode and saved credential ownership', () => {
  it('retains legacy task fingerprints and API-key configuration', () => {
    expect(settingsFingerprint(original)).toBe(
      createHash('sha256')
        .update(original.dograhBaseUrl + '\n' + original.dograhApiKey)
        .digest('hex'),
    );
    expect(dograhClientConfig(original)).toEqual({
      baseUrl: original.dograhBaseUrl,
      authMode: 'apiKey',
      apiKey: original.dograhApiKey,
    });
  });
  it('normalizes a login token and sends only that selected credential', () => {
    const settings = updateDograhConnection(original, {
      dograhBaseUrl: original.dograhBaseUrl,
      dograhAuthMode: 'token',
      dograhLoginToken: 'Bearer login_token_for_test',
    });
    expect(dograhClientConfig(settings)).toEqual({
      baseUrl: original.dograhBaseUrl,
      authMode: 'token',
      loginToken: 'login_token_for_test',
    });
    expect(settings.dograhApiKey).toBe(original.dograhApiKey);
    expect(settings.openaiApiKey).toBe(original.openaiApiKey);
    expect(settingsFingerprint(settings)).not.toBe(settingsFingerprint(original));
    expect(
      dograhCredential(
        updateDograhConnection(settings, {
          dograhBaseUrl: original.dograhBaseUrl,
          dograhAuthMode: 'token',
          dograhLoginToken: '',
        }),
      ),
    ).toBe('login_token_for_test');
  });
  it('preserves inactive credentials without allowing them to cross API servers', () => {
    const tokenSettings = updateDograhConnection(original, {
      dograhBaseUrl: original.dograhBaseUrl,
      dograhAuthMode: 'token',
      dograhLoginToken: 'login_one',
    });
    expect(() =>
      updateDograhConnection(tokenSettings, {
        dograhBaseUrl: 'https://new.example',
        dograhAuthMode: 'token',
      }),
    ).toThrow('重新输入');
    const moved = updateDograhConnection(tokenSettings, {
      dograhBaseUrl: 'https://new.example',
      dograhAuthMode: 'token',
      dograhLoginToken: 'login_two',
    });
    expect(moved.dograhApiKey).toBe(original.dograhApiKey);
    expect(dograhCredential(moved, 'apiKey')).toBe('');
    expect(dograhCredential(moved, 'token')).toBe('login_two');
    const switched = updateDograhConnection(moved, {
      dograhBaseUrl: moved.dograhBaseUrl,
      dograhAuthMode: 'apiKey',
    });
    expect(dograhCredential(switched)).toBe('');
    expect(dograhClientConfig(switched)).not.toHaveProperty('loginToken');
  });
  it('does not treat an inactive API key as a missing token', () => {
    const settings = updateDograhConnection(original, {
      dograhBaseUrl: original.dograhBaseUrl,
      dograhAuthMode: 'token',
    });
    expect(dograhCredential(settings)).toBe('');
    expect(dograhCredential(settings, 'apiKey')).toBe(original.dograhApiKey);
  });
});

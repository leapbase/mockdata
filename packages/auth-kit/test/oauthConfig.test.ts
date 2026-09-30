import { describe, it, expect } from 'vitest';
import { isGoogleClientConfigured, getGoogleOAuthConfigFromEnv } from '../src/oauthConfig.js';

describe('isGoogleClientConfigured', () => {
  it('requires both id and secret, real (not placeholder) values', () => {
    expect(isGoogleClientConfigured('id', 'secret')).toBe(true);
    expect(isGoogleClientConfigured(undefined, 'secret')).toBe(false);
    expect(isGoogleClientConfigured('id', undefined)).toBe(false);
    expect(isGoogleClientConfigured('your_google_client_id', 'secret')).toBe(false);
    expect(isGoogleClientConfigured('id', 'your_google_client_secret')).toBe(false);
  });

  it('accepts custom placeholder lists for other providers', () => {
    expect(isGoogleClientConfigured('id', 'secret', ['placeholder-id', 'placeholder-secret'])).toBe(true);
    expect(isGoogleClientConfigured('placeholder-id', 'secret', ['placeholder-id', 'placeholder-secret'])).toBe(false);
  });
});

describe('getGoogleOAuthConfigFromEnv', () => {
  it('returns undefined when either var is missing', () => {
    expect(getGoogleOAuthConfigFromEnv({})).toBeUndefined();
  });

  it('returns a config object when both vars are set', () => {
    expect(getGoogleOAuthConfigFromEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { buildOAuth1AuthorizationHeader, percentEncode } from '../src/oauth1.js';

const CONSUMER = {
  key: 'fc3e99d2-118c-44b8-8ae3-03370dde24c0',
  secret: 'E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF',
};

function signatureOf(header: string): string | undefined {
  return /oauth_signature="([^"]*)"/.exec(header)?.[1];
}

describe('percentEncode', () => {
  it('follows RFC 3986', () => {
    expect(percentEncode('a b/c~d-e_f.g')).toBe('a%20b%2Fc~d-e_f.g');
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A');
  });
});

// Known answers computed with python-oauthlib (the library garth signs with),
// shared with datalib's Rust implementation of the same flow.
describe('buildOAuth1AuthorizationHeader', () => {
  it('signs the bearer exchange like oauthlib', () => {
    const header = buildOAuth1AuthorizationHeader(
      'POST',
      'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0',
      [['mfa_token', 'm']],
      CONSUMER,
      { key: 'tok', secret: 'sec' },
      { nonce: 'abc123', timestamp: 1_700_000_000 }
    );

    expect(signatureOf(header)).toBe('NLxYWkOOxBCIv%2FSQ3CG3bicL9ug%3D');
    expect(header.startsWith('OAuth oauth_consumer_key="')).toBe(true);
    expect(header).toContain('oauth_token="tok"');
  });

  it('folds query and form parameters into the signature (the RFC 5849 example)', () => {
    const header = buildOAuth1AuthorizationHeader(
      'POST',
      'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      [
        ['c2', ''],
        ['a3', '2 q'],
      ],
      CONSUMER,
      { key: 'kkk9d7dh3k39sjv7', secret: 'secret' },
      { nonce: '7d8f3e4a', timestamp: 137131201 }
    );

    expect(signatureOf(header)).toBe('7PAEbk9wufiGO1GzlKjQJavK2MQ%3D');
  });

  it('leaves the token out of a request signed by the consumer alone', () => {
    const header = buildOAuth1AuthorizationHeader(
      'GET',
      'https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=ST-1',
      [],
      CONSUMER,
      undefined,
      { nonce: 'n', timestamp: 1 }
    );

    expect(header).not.toContain('oauth_token=');
  });
});

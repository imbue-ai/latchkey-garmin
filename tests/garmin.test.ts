import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLatchkeySdk } from 'latchkey/dist/src/pluginSdk.js';
import { resetAsyncSubprocessRunner, setAsyncSubprocessRunner } from 'latchkey/dist/src/curl.js';
import plugin from '../src/index.js';
import {
  GarminTokenExchangeError,
  createGarmin,
  extractServiceTicketFromUrl,
} from '../src/garmin.js';

// What Latchkey hands the plugin at load time, for a Latchkey of this version.
const sdk = createLatchkeySdk('3.15.0');
const manifest = plugin(sdk);
// A single set of classes for everything below, so that `instanceof` holds.
const { Garmin, GarminCredentials, logInWithServiceTicket } = createGarmin(sdk);
const garmin = new Garmin();

const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();
const SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/android';

function credentialsWithBearer(bearer: string, expiresAt = IN_AN_HOUR) {
  return new GarminCredentials('tok', 'sec', 'm', bearer, expiresAt);
}

function garthDirectory(oauth1Token: object): string {
  const directory = mkdtempSync(join(tmpdir(), 'latchkey-garmin-'));
  writeFileSync(join(directory, 'oauth1_token.json'), JSON.stringify(oauth1Token));
  return directory;
}

class UnexpectedCurlCallError extends Error {}

interface RecordedCall {
  readonly arguments: readonly string[];
}

/** Answer each curl invocation in turn with the given status and body. */
function stubCurl(replies: readonly { status: number; body: string }[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  setAsyncSubprocessRunner((curlArguments) => {
    const reply = replies[calls.length];
    calls.push({ arguments: curlArguments });
    if (reply === undefined) {
      throw new UnexpectedCurlCallError();
    }
    return Promise.resolve({
      returncode: 0,
      stdout: Buffer.from(`${reply.body}\n${String(reply.status)}`),
      stderr: '',
    });
  });
  return calls;
}

function headerValue(curlArguments: readonly string[], name: string): string | undefined {
  const prefix = `${name}: `;
  return curlArguments.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

afterEach(() => {
  resetAsyncSubprocessRunner();
});

describe('the plugin manifest', () => {
  it('provides the garmin service, built from the sdk', () => {
    const [service] = manifest.services;
    expect(service).toBeInstanceOf(sdk.Service);
    expect(service!.name).toBe('garmin');
    expect(service!.baseApiUrls).toEqual(['https://connectapi.garmin.com/']);
  });

  it('registers the credentials class its service stores', () => {
    expect(manifest.apiCredentialsTypes?.map((type) => type.objectType)).toEqual(['garminOAuth']);
  });
});

describe('GarminCredentials', () => {
  it('survives a round trip through JSON', () => {
    const credentials = credentialsWithBearer('b3arer');

    expect(GarminCredentials.fromJSON(credentials.toJSON())).toEqual(credentials);
  });

  it('refuses stored data it does not understand', () => {
    expect(() =>
      GarminCredentials.fromJSON({ objectType: 'garminOAuth', oauthToken: 't' })
    ).toThrow();
  });

  it('injects the bearer', async () => {
    expect(await credentialsWithBearer('b3arer').injectIntoCurlCall(['https://x'])).toEqual([
      '-H',
      'Authorization: Bearer b3arer',
      'https://x',
    ]);
  });

  it('cannot be injected before a bearer has been minted', () => {
    expect(() => new GarminCredentials('tok', 'sec').injectIntoCurlCall([])).toThrow(
      sdk.ApiCredentialsUsageError
    );
  });

  it('counts as expired until a bearer has been minted, so that Latchkey asks for one', () => {
    expect(new GarminCredentials('tok', 'sec').isExpired()).toBe(true);
  });

  it('expires two minutes early', () => {
    const inAMinute = new Date(Date.now() + 60_000).toISOString();

    expect(credentialsWithBearer('b').isExpired()).toBe(false);
    expect(credentialsWithBearer('b', inAMinute).isExpired()).toBe(true);
  });
});

describe('importing from garth', () => {
  it('reads the OAuth1 token from a garth directory', () => {
    const directory = garthDirectory({
      oauth_token: 'tok',
      oauth_token_secret: 'sec',
      mfa_token: 'm',
      mfa_expiration_timestamp: '2027-03-18T00:00:00',
      domain: 'garmin.com',
    });

    expect(garmin.getCredentialsNoCurl([directory])).toEqual(
      new GarminCredentials('tok', 'sec', 'm')
    );
  });

  it("accepts garth's nulls", () => {
    const directory = garthDirectory({
      oauth_token: 'tok',
      oauth_token_secret: 'sec',
      mfa_token: null,
      mfa_expiration_timestamp: null,
      domain: null,
    });

    expect(garmin.getCredentialsNoCurl([directory])).toEqual(new GarminCredentials('tok', 'sec'));
  });

  it('refuses tokens for another Garmin domain', () => {
    const directory = garthDirectory({
      oauth_token: 'tok',
      oauth_token_secret: 'sec',
      domain: 'garmin.cn',
    });

    expect(() => garmin.getCredentialsNoCurl([directory])).toThrow(/garmin\.cn/);
  });

  it('wants exactly one existing directory', () => {
    expect(() => garmin.getCredentialsNoCurl([])).toThrow(sdk.NoCurlCredentialsNotSupportedError);
    expect(() => garmin.getCredentialsNoCurl(['a', 'b'])).toThrow(
      sdk.NoCurlCredentialsNotSupportedError
    );
    expect(() => garmin.getCredentialsNoCurl(['/nonexistent'])).toThrow(
      sdk.NoCurlCredentialsNotSupportedError
    );
  });
});

describe('refreshing', () => {
  it('mints a bearer with an OAuth1-signed exchange', async () => {
    const calls = stubCurl([
      { status: 200, body: JSON.stringify({ access_token: 'fresh', expires_in: 3600 }) },
    ]);

    const refreshed = await garmin.refreshCredentials(new GarminCredentials('tok', 'sec', 'm'));

    expect(refreshed).toBeInstanceOf(GarminCredentials);
    const credentials = refreshed as InstanceType<typeof GarminCredentials>;
    expect(credentials.accessToken).toBe('fresh');
    expect(credentials.oauthToken).toBe('tok');
    expect(credentials.isExpired()).toBe(false);

    const [call] = calls;
    expect(call!.arguments.at(-1)).toBe(
      'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0'
    );
    expect(headerValue(call!.arguments, 'Authorization')).toMatch(/^OAuth .*oauth_token="tok"/);
    expect(call!.arguments).toContain('mfa_token=m');
  });

  it('explains that an OAuth1 token Garmin refuses needs a new login', async () => {
    stubCurl([{ status: 401, body: 'nope' }]);

    await expect(garmin.refreshCredentials(new GarminCredentials('tok', 'sec'))).rejects.toThrow(
      GarminTokenExchangeError
    );
  });

  it('leaves credentials of other kinds alone', async () => {
    expect(await garmin.refreshCredentials(new sdk.AuthorizationBearer('x'))).toBeNull();
  });
});

describe('the browser login', () => {
  it('takes the service ticket from what the SSO page tells the app', () => {
    const session = garmin.getSession('latchkey');

    session.noteThickClientEvent(JSON.stringify({ eventType: 'PAGE_LOAD', data: { title: '' } }));
    expect(session.capturedServiceTicket).toBeNull();

    session.noteThickClientEvent(
      JSON.stringify({
        eventType: 'USER_AUTHENTICATED',
        flowName: 'AUTHENTICATION',
        logMessage: '',
        data: { serviceTicket: 'ST-123', serviceUrl: SERVICE_URL },
      })
    );
    expect(session.capturedServiceTicket).toBe('ST-123');
  });

  it('takes the service ticket from the navigation that hands it over', () => {
    const session = garmin.getSession('latchkey');

    session.noteRequestUrl('https://sso.garmin.com/mobile/sso/en-US/sign-in');
    expect(session.capturedServiceTicket).toBeNull();

    session.noteRequestUrl(`${SERVICE_URL}?ticket=ST-456`);
    expect(session.capturedServiceTicket).toBe('ST-456');
  });

  it('only takes tickets from the service URL', () => {
    expect(extractServiceTicketFromUrl(`${SERVICE_URL}?ticket=ST-1`)).toBe('ST-1');
    expect(extractServiceTicketFromUrl('https://example.com/?ticket=ST-1')).toBeNull();
  });

  it('trades the ticket for an OAuth1 token and a first bearer', async () => {
    const calls = stubCurl([
      {
        status: 200,
        body: 'oauth_token=tok&oauth_token_secret=s%2Fs&mfa_token=m&mfa_expiration_timestamp=2027',
      },
      { status: 200, body: JSON.stringify({ access_token: 'first', expires_in: 3600 }) },
    ]);

    const credentials = await logInWithServiceTicket('ST-1', 'lb=1');

    expect(credentials).toEqual(
      new GarminCredentials('tok', 's/s', 'm', 'first', credentials.accessTokenExpiresAt)
    );
    const [preauthorize, exchange] = calls;
    expect(preauthorize!.arguments.at(-1)).toMatch(
      /^https:\/\/connectapi\.garmin\.com\/oauth-service\/oauth\/preauthorized\?ticket=ST-1&/
    );
    expect(headerValue(preauthorize!.arguments, 'Authorization')).not.toContain('oauth_token=');
    expect(headerValue(preauthorize!.arguments, 'Cookie')).toBe('lb=1');
    expect(exchange!.arguments).toContain('audience=GARMIN_CONNECT_MOBILE_ANDROID_DI&mfa_token=m');
  });
});

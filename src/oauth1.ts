/**
 * OAuth 1.0a (RFC 5849) HMAC-SHA1 request signing, as the Garmin Connect
 * mobile app does it. Node's own crypto is all this needs, so the plugin stays
 * free of dependencies.
 */

import { createHmac, randomUUID } from 'node:crypto';

export interface OAuth1Consumer {
  readonly key: string;
  readonly secret: string;
}

export interface OAuth1Token {
  readonly key: string;
  readonly secret: string;
}

/** The two per-request values a signature folds in. */
export interface OAuth1Nonce {
  readonly nonce: string;
  readonly timestamp: number;
}

export type FormParameters = readonly (readonly [string, string])[];

export function freshNonce(): OAuth1Nonce {
  return {
    nonce: randomUUID().replaceAll('-', ''),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/** RFC 3986 section 2.3: everything but `A-Z a-z 0-9 - . _ ~` is escaped. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function formEncode(parameters: FormParameters): string {
  return parameters
    .map(([name, value]) => `${percentEncode(name)}=${percentEncode(value)}`)
    .join('&');
}

function decodeQueryComponent(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

function queryParameters(query: string): FormParameters {
  return query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const separatorIndex = pair.indexOf('=');
      const [name, value] =
        separatorIndex === -1
          ? [pair, '']
          : [pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1)];
      return [decodeQueryComponent(name), decodeQueryComponent(value)] as const;
    });
}

function compareEncodedPairs(
  [leftName, leftValue]: readonly [string, string],
  [rightName, rightValue]: readonly [string, string]
): number {
  if (leftName !== rightName) {
    return leftName < rightName ? -1 : 1;
  }
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
}

/**
 * The `Authorization: OAuth ...` header value for one request.
 *
 * `url` may carry a query string, whose parameters join `form` in the
 * signature base as the spec requires. `token` is left out for a request
 * signed by the consumer alone.
 */
export function buildOAuth1AuthorizationHeader(
  method: string,
  url: string,
  form: FormParameters,
  consumer: OAuth1Consumer,
  token: OAuth1Token | undefined,
  nonce: OAuth1Nonce
): string {
  const queryIndex = url.indexOf('?');
  const baseUrl = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1);

  const oauthParameters: FormParameters = [
    ['oauth_consumer_key', consumer.key],
    ['oauth_nonce', nonce.nonce],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', String(nonce.timestamp)],
    ['oauth_version', '1.0'],
    ...(token === undefined ? [] : [['oauth_token', token.key] as const]),
  ];

  const normalizedParameters = [...oauthParameters, ...queryParameters(query), ...form]
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .sort(compareEncodedPairs)
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalizedParameters),
  ].join('&');
  const signingKey = `${percentEncode(consumer.secret)}&${percentEncode(token?.secret ?? '')}`;
  const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  const fields = [...oauthParameters, ['oauth_signature', signature] as const]
    .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
    .join(', ');
  return `OAuth ${fields}`;
}

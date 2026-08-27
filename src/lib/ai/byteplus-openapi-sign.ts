/**
 * BytePlus OpenAPI HMAC-SHA256 request signing (control plane).
 *
 * The Assets API (`CreateAsset`, `GetAsset`, …) lives on
 * `ark.ap-southeast-1.byteplusapi.com` and rejects Bearer `ARK_API_KEY`.
 * It wants IAM AK/SK, SigV4-shaped:
 *   Authorization: HMAC-SHA256 Credential={ak}/{date}/{region}/ark/request, …
 *
 * Source: https://docs.byteplus.com/en/docs/byteplus-platform/reference-how-to-calculate-a-signature
 */

const encoder = new TextEncoder();

export type BytePlusSignInput = {
  method: string;
  /** Path only, e.g. `/`. */
  path: string;
  /** Already-sorted query without `?`, e.g. `Action=CreateAsset&Version=2024-01-01`. */
  query: string;
  host: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  body: string;
  /** UTC `YYYYMMDDTHHMMSSZ`. */
  xDate: string;
};

export type BytePlusSignedHeaders = {
  Host: string;
  'Content-Type': string;
  'X-Date': string;
  'X-Content-Sha256': string;
  Authorization: string;
};

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return toHex(digest);
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildCanonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`
    )
    .join('&');
}

export async function signBytePlusRequest(
  input: BytePlusSignInput
): Promise<BytePlusSignedHeaders> {
  const contentType = 'application/json';
  const payloadHash = await sha256Hex(input.body);
  const shortDate = input.xDate.slice(0, 8);
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${input.host}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${input.xDate}\n`;
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    input.xDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(encoder.encode(input.secretKey), shortDate);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, 'request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    Host: input.host,
    'Content-Type': contentType,
    'X-Date': input.xDate,
    'X-Content-Sha256': payloadHash,
    Authorization:
      `HMAC-SHA256 Credential=${input.accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function utcXDate(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

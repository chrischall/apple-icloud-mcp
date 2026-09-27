import { createSign } from 'node:crypto';
import type { DeveloperKey } from '../apple-keys.js';

/**
 * Maps Web Snapshots URL signing (research: apple-dev-apis.md §2, raw docs
 * research/devapis/snapshots-rendered.md).
 *
 * A snapshot URL is authorised by an ES256 signature over its exact
 * PATH + QUERY (`/api/v1/snapshot?…&teamId=…&keyId=…`), base64url-encoded,
 * appended as the LAST parameter (`&signature=…`) — Apple answers 401 when it
 * is not last, and any reordering or re-encoding of the signed part
 * invalidates it. The signature is the JOSE form (raw `r‖s`,
 * `dsaEncoding: 'ieee-p1363'`), which is what Apple's sample produces with
 * `jwa('ES256').sign`; Node's default DER encoding would be refused.
 *
 * This module only builds and signs; nothing here fetches the image (the
 * snapshot host is deliberately not in the egress allowlist).
 */

export const SNAPSHOT_ORIGIN = 'https://snapshot.apple-mapkit.com';
export const SNAPSHOT_PATH = '/api/v1/snapshot';

/**
 * Percent-encode a query component so that NO URL parser will re-encode it.
 * `encodeURIComponent` leaves `!'()*` literal, but the WHATWG URL parser
 * percent-encodes `'` in the query of an https URL — so a browser would
 * request `McDonald%27s` for a URL we signed as `McDonald's`, and Apple
 * would reject the signature. Encoding all five up front makes the signed
 * text and the requested text identical.
 */
export function encodeSnapshotComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Base64url ES256 (P-256/SHA-256, raw r‖s) signature of `pathAndQuery`. */
export function signSnapshotPath(pathAndQuery: string, privateKeyPem: string): string {
  return createSign('SHA256').update(pathAndQuery).sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

/**
 * Build the complete signed URL. `params` are emitted in the given order,
 * each value percent-encoded (`encodeSnapshotComponent`); `teamId` and `keyId` follow them, and the
 * signature is appended last.
 */
export function buildSignedSnapshotUrl(params: ReadonlyArray<readonly [string, string]>, key: DeveloperKey): string {
  const query = [...params, ['teamId', key.teamId] as const, ['keyId', key.keyId] as const]
    .map(([k, v]) => `${encodeSnapshotComponent(k)}=${encodeSnapshotComponent(v)}`)
    .join('&');
  const unsigned = `${SNAPSHOT_PATH}?${query}`;
  return `${SNAPSHOT_ORIGIN}${unsigned}&signature=${signSnapshotPath(unsigned, key.privateKeyPem)}`;
}

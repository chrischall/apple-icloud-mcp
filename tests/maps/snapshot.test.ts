import { createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_ORIGIN, SNAPSHOT_PATH, buildSignedSnapshotUrl, encodeSnapshotComponent, signSnapshotPath } from '../../src/maps/snapshot.js';
import { KEY, KEY_ID, PRIVATE_PEM, PUBLIC_KEY, TEAM_ID, verifySnapshotUrl } from './_helpers.js';

describe('signSnapshotPath', () => {
  it('produces a 64-byte JOSE (r‖s) ES256 signature in base64url', () => {
    const sig = signSnapshotPath('/api/v1/snapshot?center=apple%20park&teamId=T&keyId=K', PRIVATE_PEM);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sig, 'base64url')).toHaveLength(64);
    const ok = createVerify('SHA256')
      .update('/api/v1/snapshot?center=apple%20park&teamId=T&keyId=K')
      .verify({ key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('buildSignedSnapshotUrl', () => {
  it('encodes params in order, appends teamId/keyId, and puts the signature last', () => {
    const url = buildSignedSnapshotUrl(
      [
        ['center', '37.78,-122.42'],
        ['annotations', '[{"point":"San Francisco City Hall"}]'],
      ],
      KEY,
    );
    expect(url.startsWith(`${SNAPSHOT_ORIGIN}${SNAPSHOT_PATH}?center=37.78%2C-122.42&annotations=%5B%7B%22point%22%3A%22San%20Francisco%20City%20Hall%22%7D%5D&teamId=${TEAM_ID}&keyId=${KEY_ID}&signature=`)).toBe(true);
    expect(new URL(url).searchParams.get('annotations')).toBe('[{"point":"San Francisco City Hall"}]');
    expect([...new URL(url).searchParams.keys()].at(-1)).toBe('signature');
    expect(verifySnapshotUrl(url)).toBe(true);
    // Tampering with any signed parameter invalidates it.
    expect(verifySnapshotUrl(url.replace('37.78', '37.79'))).toBe(false);
  });
});

describe('encodeSnapshotComponent', () => {
  it("encodes the characters encodeURIComponent leaves alone, so a URL parser cannot change the signed text", () => {
    expect(encodeSnapshotComponent("McDonald's (Main St)!*")).toBe('McDonald%27s%20%28Main%20St%29%21%2A');
    const url = buildSignedSnapshotUrl([['center', "McDonald's, 1 Main St (rear)"]], KEY);
    // What a browser (WHATWG URL parser) would actually request is byte-identical to what was signed.
    expect(new URL(url).href).toBe(url);
    expect(verifySnapshotUrl(new URL(url).href)).toBe(true);
    expect(new URL(url).searchParams.get('center')).toBe("McDonald's, 1 Main St (rear)");
  });
});

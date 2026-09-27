import { beforeEach, describe, expect, it } from 'vitest';
import { NOW, KEY_ID, TEAM_ID, harness, verifySnapshotUrl } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

const params = (url: string) => [...new URL(url).searchParams.entries()];

describe('apple_maps_snapshot_url', () => {
  it('signs a centred map with only the parameters given, and never fetches it', async () => {
    const h = harness({});
    const { isError, json } = await h.call('apple_maps_snapshot_url', { center: '37.3349, -122.009' });
    expect(isError).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
    expect(params(json.url)).toEqual([
      ['center', '37.3349,-122.009'],
      ['teamId', TEAM_ID],
      ['keyId', KEY_ID],
      ['signature', expect.any(String)],
    ]);
    expect(verifySnapshotUrl(json.url)).toBe(true);
    expect(json).toMatchObject({ center: '37.3349,-122.009', size: '600x400', scale: 1, mapType: 'standard', colorScheme: 'light' });
    expect(json.zoom).toBeUndefined();
    expect(json.annotations).toBeUndefined();
    expect(json.notes).toEqual([
      'Signed locally and not fetched. Opening the URL returns a PNG; an HTTP 401 there means the key lacks MapKit JS or its Maps ID association (or the link expired). Apple allows 25,000 unique snapshot requests per day.',
    ]);
  });

  it('every option, in a stable order, signature last; labelled pins get glyphs and a legend', async () => {
    const h = harness({});
    const { json } = await h.call('apple_maps_snapshot_url', {
      center: 'Apple Park, Cupertino',
      zoom: 14.5,
      size: '640x480',
      scale: 2,
      mapType: 'satellite',
      colorScheme: 'dark',
      showPointsOfInterest: false,
      lang: 'en-GB',
      expiresInMinutes: 90,
      annotations: [
        { point: '37.33, -122.01', label: 'Office', color: '#FF3B30' },
        { address: '  1 Infinite   Loop ', label: 'Old office', glyphText: 'A', markerStyle: 'large' },
        { point: '37.3,-122.0', label: 'Cafe', markerStyle: 'dot', color: 'blue' },
        { point: '37.4,-122.1' },
      ],
    });
    const p = params(json.url);
    expect(p.map(([k]) => k)).toEqual(['center', 'z', 'size', 'scale', 't', 'colorScheme', 'poi', 'lang', 'annotations', 'expires', 'teamId', 'keyId', 'signature']);
    const map = Object.fromEntries(p);
    expect(map).toMatchObject({
      center: 'Apple Park, Cupertino',
      z: '14.5',
      size: '640x480',
      scale: '2',
      t: 'satellite',
      colorScheme: 'dark',
      poi: '0',
      lang: 'en-GB',
      expires: String(NOW / 1000 + 90 * 60),
    });
    // The explicit glyph "A" is taken, so the first auto glyph is "B".
    expect(JSON.parse(map.annotations!)).toEqual([
      { point: '37.33,-122.01', color: 'FF3B30', glyphText: 'B' },
      { point: '1 Infinite Loop', glyphText: 'A', markerStyle: 'large' },
      { point: '37.3,-122', color: 'blue', markerStyle: 'dot' },
      { point: '37.4,-122.1' },
    ]);
    expect(verifySnapshotUrl(json.url)).toBe(true);
    expect(new URL(json.url).href).toBe(json.url);
    expect(json).toMatchObject({
      center: 'Apple Park, Cupertino',
      zoom: 14.5,
      size: '640x480',
      scale: 2,
      mapType: 'satellite',
      colorScheme: 'dark',
      expiresAt: '2026-10-03T13:30:00-04:00',
      expiresAtDisplay: 'Sat, Oct 3, 2026, 1:30 PM EDT',
    });
    expect(json.annotations).toEqual([
      { index: 0, point: '37.33,-122.01', label: 'Office', glyph: 'B', color: 'FF3B30' },
      { index: 1, point: '1 Infinite Loop', label: 'Old office', glyph: 'A', markerStyle: 'large' },
      { index: 2, point: '37.3,-122', label: 'Cafe', color: 'blue', markerStyle: 'dot' },
      { index: 3, point: '37.4,-122.1' },
    ]);
    expect(json.notes).toEqual([
      'Dot markers cannot show a glyph, so labelled dot pins are told apart only by colour; see annotations.',
      'colorScheme dark has no effect on the satellite map type.',
      expect.stringMatching(/^Signed locally and not fetched/),
    ]);
    expect(Object.keys(json).at(-1)).toBe('annotations');
  });

  it('fits the map to the pins when there is no center (or center "auto")', async () => {
    const h = harness({});
    for (const center of [undefined, 'AUTO']) {
      const { json } = await h.call('apple_maps_snapshot_url', {
        ...(center ? { center } : {}),
        annotations: [{ point: '1,2' }],
        showPointsOfInterest: true,
        mapType: 'hybrid',
        colorScheme: 'dark',
      });
      expect(new URL(json.url).searchParams.get('center')).toBe('auto');
      expect(new URL(json.url).searchParams.get('poi')).toBe('1');
      expect(json.center).toBe('auto');
      expect(json.notes[0]).toBe('colorScheme dark has no effect on the hybrid map type.');
    }
  });

  it('refuses what Apple would reject or silently ignore', async () => {
    const h = harness({});
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /Give a center, annotations, or both/],
      [{ annotations: [] }, /Give a center, annotations, or both/],
      [{ annotations: [{ point: '1,2' }], zoom: 10 }, /zoom needs a center/],
      [{ center: 'x', size: '700x400' }, /size "700x400" has width 700; each side must be 50–640/],
      [{ center: 'x', size: '640x20' }, /has height 20/],
      [{ annotations: [{ point: '1,2', address: 'x' }] }, /annotations\[0\] needs exactly one of point or address/],
      [{ annotations: [{ label: 'x' }] }, /annotations\[0\] needs exactly one of point or address/],
      [{ annotations: [{ point: 'Cupertino' }] }, /annotations\[0\]\.point "Cupertino" must be coordinates/],
      [{ annotations: [{ address: '  ' }] }, /annotations\[0\]\.address is empty/],
      // A coordinate-shaped "address" IS coordinates, and is range-checked like any other.
      [{ annotations: [{ address: '95, 10' }] }, /annotations\[0\]\.address "95, 10" has latitude 95/],
      [{ center: '100,0' }, /center "100,0" has latitude 100/],
    ];
    for (const [args, re] of cases) {
      const { isError, json } = await h.call('apple_maps_snapshot_url', args);
      expect(isError).toBe(true);
      expect(json.error.code).toBe('INVALID_ARGUMENT');
      expect(json.error.message).toMatch(re);
    }
  });

  it('a dot marker never claims a glyph in the legend (Apple does not draw one), and a coordinate-shaped address is normalized', async () => {
    const h = harness({});
    const { json } = await h.call('apple_maps_snapshot_url', {
      annotations: [
        { address: ' 37.330000 , -122.0100 ', markerStyle: 'dot', glyphText: 'Q' },
        { point: '1,2', label: 'Next', markerStyle: 'balloon' },
      ],
    });
    const sent = JSON.parse(new URL(json.url).searchParams.get('annotations')!);
    expect(sent[0]).toEqual({ point: '37.33,-122.01', glyphText: 'Q', markerStyle: 'dot' });
    // "Q" is taken by an explicit glyph even though a dot hides it, so auto-assignment starts at "A".
    expect(sent[1]).toEqual({ point: '1,2', glyphText: 'A', markerStyle: 'balloon' });
    expect(json.annotations).toEqual([
      { index: 0, point: '37.33,-122.01', markerStyle: 'dot' },
      { index: 1, point: '1,2', label: 'Next', glyph: 'A', markerStyle: 'balloon' },
    ]);
    expect(json.notes[0]).toBe('Dot markers cannot show a glyph, so labelled dot pins are told apart only by colour; see annotations.');
    expect(verifySnapshotUrl(json.url)).toBe(true);
  });

  it('warns when the URL is long enough that Apple may answer 413', async () => {
    const h = harness({});
    const annotations = Array.from({ length: 50 }, (_, i) => ({
      address: `${i} A Rather Long Street Name That Goes On And On, Some Suburb, Some City, Some State 12345`,
      label: `Stop ${i}`,
      color: 'darkslateblue',
    }));
    const { json } = await h.call('apple_maps_snapshot_url', { annotations });
    expect(json.url.length).toBeGreaterThan(8000);
    expect(json.notes[0]).toMatch(/^The URL is \d+ characters; Apple answers HTTP 413/);
    // 50 labelled pins: A–Z, then digits, then lower case, all distinct.
    const glyphs = json.annotations.map((a: { glyph: string }) => a.glyph);
    expect(new Set(glyphs).size).toBe(50);
    expect(glyphs.slice(24, 28)).toEqual(['Y', 'Z', '1', '2']);
    expect(verifySnapshotUrl(json.url)).toBe(true);
  });
});

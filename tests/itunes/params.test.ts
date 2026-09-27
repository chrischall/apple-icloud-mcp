import { describe, expect, it } from 'vitest';
import { ConfigError, InvalidArgumentError } from '../../src/errors.js';
import {
  ATTRIBUTES_BY_MEDIA,
  CHART_NAMES,
  CHARTS,
  ENTITIES_BY_MEDIA,
  LOOKUP_ENTITIES,
  SEARCH_ATTRIBUTES,
  SEARCH_ENTITIES,
  SEARCH_MEDIA,
  assertValidForMedia,
  inferMedia,
  normalizeIsbn,
  resolveStorefront,
} from '../../src/itunes/params.js';

describe('media / entity / attribute tables', () => {
  it('the schema enums are the de-duplicated union of every media', () => {
    expect(new Set(SEARCH_ENTITIES).size).toBe(SEARCH_ENTITIES.length);
    expect(new Set(SEARCH_ATTRIBUTES).size).toBe(SEARCH_ATTRIBUTES.length);
    for (const m of SEARCH_MEDIA) {
      for (const e of ENTITIES_BY_MEDIA[m]) expect(SEARCH_ENTITIES).toContain(e);
      for (const a of ATTRIBUTES_BY_MEDIA[m]) expect(SEARCH_ATTRIBUTES).toContain(a);
    }
    expect(LOOKUP_ENTITIES).toContain('podcastEpisode');
    expect(LOOKUP_ENTITIES).toContain('song');
  });

  it('accepts entity/attribute pairs Apple documents for the media', () => {
    expect(() => assertValidForMedia('music', 'song', 'artistTerm')).not.toThrow();
    expect(() => assertValidForMedia('podcast', 'podcastEpisode', 'titleTerm')).not.toThrow();
    expect(() => assertValidForMedia('all', undefined, undefined)).not.toThrow();
  });

  it('refuses an entity Apple would silently answer for a different media', () => {
    try {
      assertValidForMedia('music', 'podcast', undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidArgumentError);
      expect((err as InvalidArgumentError).message).toContain('entity "podcast" is not valid for media "music"');
      expect((err as InvalidArgumentError).hint).toContain('musicArtist, musicTrack, album, musicVideo, mix, song');
    }
  });

  it('refuses an attribute the media does not have, and says when a media has none', () => {
    expect(() => assertValidForMedia('music', undefined, 'titleTerm')).toThrow(/attribute "titleTerm" is not valid for media "music"/);
    try {
      assertValidForMedia('ebook', 'ebook', 'titleTerm');
      expect.unreachable();
    } catch (err) {
      expect((err as InvalidArgumentError).hint).toContain('Apple supports no attribute for media "ebook"');
    }
    try {
      assertValidForMedia('software', undefined, 'artistTerm');
      expect.unreachable();
    } catch (err) {
      expect((err as InvalidArgumentError).hint).toContain('softwareDeveloper');
    }
  });

  it('infers the media from the entity/attribute when none was named', () => {
    expect(inferMedia(undefined, undefined)).toBe('all');
    expect(inferMedia('song', undefined)).toBe('music');
    expect(inferMedia('podcastEpisode', undefined)).toBe('podcast');
    expect(inferMedia('musicVideo', undefined)).toBe('music');
    expect(inferMedia('allArtist', undefined)).toBe('all');
    expect(inferMedia(undefined, 'artistTerm')).toBe('all');
    expect(inferMedia(undefined, 'softwareDeveloper')).toBe('software');
    expect(inferMedia('podcast', 'titleTerm')).toBe('podcast');
    expect(inferMedia('album', 'titleTerm')).toBe('all');
  });

  it('refuses a pair no media accepts, naming the pair rather than a media the caller never chose', () => {
    try {
      inferMedia('ebook', 'titleTerm');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidArgumentError);
      expect((err as InvalidArgumentError).message).toBe('No media accepts entity "ebook" together with attribute "titleTerm".');
      expect((err as InvalidArgumentError).hint).toBe(
        'entity "ebook" belongs to media ebook; attribute "titleTerm" to media all, podcast, audiobook. Drop one, or pick values from the same media.',
      );
    }
  });

  it('maps every chart to a feed path', () => {
    expect(CHART_NAMES).toHaveLength(12);
    expect(CHARTS['podcast-channels']).toEqual({ media: 'podcasts', feed: 'top-subscriber', type: 'podcast-channels' });
    expect(CHARTS.audiobooks).toEqual({ media: 'audio-books', feed: 'top', type: 'audio-books' });
  });
});

describe('resolveStorefront', () => {
  it('uses the explicit value, lower-cased', () => {
    process.env.APPLE_MUSIC_STOREFRONT = 'gb';
    expect(resolveStorefront('JP', 'country')).toBe('jp');
  });

  it('refuses a malformed explicit value (it lands in a URL path)', () => {
    expect(() => resolveStorefront('../x', 'storefront')).toThrow(InvalidArgumentError);
    expect(() => resolveStorefront('usa', 'country')).toThrow(/country "usa" is not a two-letter country code/);
  });

  it('falls back to APPLE_MUSIC_STOREFRONT, then us — read at call time', () => {
    expect(resolveStorefront(undefined, 'country')).toBe('us');
    process.env.APPLE_MUSIC_STOREFRONT = 'DE';
    expect(resolveStorefront(undefined, 'country')).toBe('de');
    process.env.APPLE_MUSIC_STOREFRONT = '';
    expect(resolveStorefront(undefined, 'country')).toBe('us');
  });

  it('a malformed APPLE_MUSIC_STOREFRONT is a config error, not a silent switch to the US store', () => {
    process.env.APPLE_MUSIC_STOREFRONT = 'United Kingdom';
    try {
      resolveStorefront(undefined, 'storefront');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toEqual(['APPLE_MUSIC_STOREFRONT']);
      expect((err as ConfigError).service).toBe('itunes');
      expect((err as ConfigError).hint).toContain('or pass storefront explicitly');
    }
  });
});

describe('normalizeIsbn', () => {
  it('accepts a valid ISBN-13, ignoring hyphens and spaces', () => {
    expect(normalizeIsbn('978-0-316-06935-9')).toBe('9780316069359');
    expect(normalizeIsbn('978 0316069359')).toBe('9780316069359');
  });

  it('converts a valid ISBN-10 (including an X check digit) to ISBN-13', () => {
    expect(normalizeIsbn('0-316-06935-3')).toBe('9780316069359');
    expect(normalizeIsbn('080442957x')).toBe('9780804429573');
  });

  it('refuses typos rather than looking up a different book', () => {
    expect(() => normalizeIsbn('9780316069358')).toThrow(/check digit does not match/);
    expect(() => normalizeIsbn('0316069354')).toThrow(/check digit does not match/);
    expect(() => normalizeIsbn('1234567890123')).toThrow(/starts with 978 or 979/);
    expect(() => normalizeIsbn('12345')).toThrow(/expected 10 or 13 digits/);
    expect(() => normalizeIsbn('12345')).toThrow(InvalidArgumentError);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { catalogIdOf, compactResource, formatDuration, projectList, projectOne, putDate, resourceName } from '../../src/music/project.js';

const NY = 'America/New_York';

describe('formatDuration', () => {
  it('renders m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(205_400)).toBe('3:25');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('putDate', () => {
  it('keeps calendar dates, labels real ones, and converts timestamps into the zone with an offset', () => {
    const o: Record<string, unknown> = {};
    putDate(o, 'releaseDate', '2026-07-27', NY);
    expect(o).toEqual({ releaseDate: '2026-07-27', releaseDateDisplay: 'Mon, Jul 27, 2026' });
    const rolled: Record<string, unknown> = {};
    putDate(rolled, 'd', '2026-02-30', NY);
    expect(rolled).toEqual({ d: '2026-02-30' });
    const inst: Record<string, unknown> = {};
    putDate(inst, 'dateAdded', '2021-10-06T16:47:33Z', NY);
    expect(inst).toEqual({ dateAdded: '2021-10-06T12:47:33-04:00', dateAddedDisplay: 'Wed, Oct 6, 2021, 12:47 PM EDT' });
  });

  it('never shifts a bare year and passes unparseable values through', () => {
    const o: Record<string, unknown> = {};
    putDate(o, 'releaseDate', '1975', NY);
    putDate(o, 'x', '2021-09-30T13: 28: 29Z', NY);
    putDate(o, 'skip', '', NY);
    putDate(o, 'skip2', 42, NY);
    expect(o).toEqual({ releaseDate: '1975', x: '2021-09-30T13: 28: 29Z' });
  });
});

describe('compactResource', () => {
  it('keeps what a caller acts on and drops artwork / previews / playParams', () => {
    const song = {
      id: 'i.abc',
      type: 'library-songs',
      href: '/v1/me/library/songs/i.abc',
      attributes: {
        name: 'Song',
        artistName: 'Artist',
        albumName: 'Album',
        durationInMillis: 205_400,
        releaseDate: '2020-01-31',
        trackNumber: 3,
        discNumber: 1,
        isrc: 'USUM71703861',
        genreNames: ['Pop', 7],
        contentRating: 'explicit',
        url: 'https://music.apple.com/x',
        dateAdded: '2025-01-02T03:04:05Z',
        artwork: { url: 'x' },
        previews: [{ url: 'y' }],
        playParams: { id: 'i.abc', kind: 'song', catalogId: '123' },
      },
    };
    expect(compactResource(song, NY)).toEqual({
      id: 'i.abc',
      type: 'library-songs',
      name: 'Song',
      artistName: 'Artist',
      albumName: 'Album',
      duration: '3:25',
      durationMs: 205_400,
      releaseDate: '2020-01-31',
      releaseDateDisplay: 'Fri, Jan 31, 2020',
      trackNumber: 3,
      discNumber: 1,
      isrc: 'USUM71703861',
      contentRating: 'explicit',
      url: 'https://music.apple.com/x',
      genreNames: ['Pop'],
      catalogId: '123',
      dateAdded: '2025-01-01T22:04:05-05:00',
      dateAddedDisplay: 'Wed, Jan 1, 2025, 10:04 PM EST',
    });
  });

  it('handles playlists, stations, recommendations and bare resources', () => {
    expect(
      compactResource(
        {
          id: 'p.x',
          type: 'library-playlists',
          attributes: {
            name: 'Mix',
            canEdit: true,
            isPublic: false,
            hasCatalog: true,
            description: { standard: 'desc' },
            lastModifiedDate: '2026-03-08T07:30:00Z',
            playParams: { id: 'p.x', globalId: 'pl.u-1' },
            curatorName: 'Me',
            trackCount: 12,
          },
        },
        NY,
      ),
    ).toEqual({
      id: 'p.x',
      type: 'library-playlists',
      name: 'Mix',
      curatorName: 'Me',
      trackCount: 12,
      catalogId: 'pl.u-1',
      lastModifiedDate: '2026-03-08T03:30:00-04:00',
      lastModifiedDateDisplay: 'Sun, Mar 8, 2026, 3:30 AM EDT',
      canEdit: true,
      isPublic: false,
      hasCatalog: true,
      description: 'desc',
    });
    expect(compactResource({ id: 'ra.1', type: 'stations', attributes: { name: 'Radio', isLive: true, editorialNotes: { tagline: 'Tag' } } }, NY)).toEqual({
      id: 'ra.1',
      type: 'stations',
      name: 'Radio',
      isLive: true,
      editorialNotes: 'Tag',
    });
    expect(compactResource({ id: 'r', type: 'personal-recommendation', attributes: { title: { stringForDisplay: 'Made for You' }, description: 'plain' } }, NY)).toEqual({
      id: 'r',
      type: 'personal-recommendation',
      name: 'Made for You',
      description: 'plain',
    });
    expect(compactResource({ id: '1', type: 'songs', attributes: { description: { short: 's' }, genreNames: [1], playParams: { catalogId: '1' } } }, NY)).toEqual({
      id: '1',
      type: 'songs',
      description: 's',
    });
    expect(compactResource({ id: '1', type: 'songs', attributes: { description: {}, editorialNotes: { short: 'n' }, title: {} } }, NY)).toEqual({ id: '1', type: 'songs', editorialNotes: 'n' });
    expect(compactResource({ id: '1', type: 'songs' }, NY)).toEqual({ id: '1', type: 'songs' });
    expect(resourceName({ id: '1', type: 'x', attributes: { title: 'nope' } })).toBeUndefined();
    expect(catalogIdOf({ id: '1', type: 'x', attributes: { playParams: 'nope' } })).toBeUndefined();
  });
});

describe('projectList', () => {
  const items = [{ id: '1', type: 'songs', attributes: { name: 'A', artwork: {} } }];

  it('compact projects, full passes Apple\'s record through verbatim', () => {
    expect(projectList(items, 'compact', NY, 'ctx')).toEqual([{ id: '1', type: 'songs', name: 'A' }]);
    expect(projectList(items, 'full', NY, 'ctx')).toBe(items);
    expect(projectOne(items[0]!, 'compact', NY, 'ctx')).toEqual({ id: '1', type: 'songs', name: 'A' });
  });

  it('returns the raw array (with a stderr warning) when the projection trips', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = [null] as unknown as typeof items;
    expect(projectList(bad, 'compact', NY, 'GET /x')).toBe(bad);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not project GET \/x/);
    warn.mockRestore();
  });
});

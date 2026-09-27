import { describe, expect, it } from 'vitest';
import {
  compactChartEntry,
  compactItunesRecord,
  formatDuration,
  primaryId,
  putAppleDate,
  recordType,
} from '../../src/itunes/project.js';
import { formatDuration as musicFormatDuration } from '../../src/music/project.js';
import { ALBUM, ARTIST, AUDIOBOOK, CHART_EPISODE, CHART_PLAYLIST, EBOOK, PODCAST, SOFTWARE, SONG, chartSong, episode } from './fixtures.js';

const NY = 'America/New_York';

describe('putAppleDate', () => {
  const put = (value: unknown, storeDate = true, zone = NY): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    putAppleDate(out, 'releaseDate', value, zone, { storeDate });
    return out;
  };

  it('a midnight-Pacific store stamp is the calendar date it denotes (PDT and PST)', () => {
    expect(put('1997-05-21T07:00:00Z')).toEqual({ releaseDate: '1997-05-21', releaseDateDisplay: 'Wed, May 21, 1997' });
    expect(put('2015-11-20T08:00:00Z')).toEqual({ releaseDate: '2015-11-20', releaseDateDisplay: 'Fri, Nov 20, 2015' });
    // Even for a viewer west of Pacific, where the instant would fall on the previous evening.
    expect(put('1997-05-21T07:00:00Z', true, 'Pacific/Honolulu').releaseDate).toBe('1997-05-21');
  });

  it('any other store stamp is the date Apple wrote (its clock time means nothing)', () => {
    expect(put('2025-09-30T12:00:00Z')).toEqual({ releaseDate: '2025-09-30', releaseDateDisplay: 'Tue, Sep 30, 2025' });
    expect(put('2025-09-30T00:00:00Z', true, 'Pacific/Honolulu').releaseDate).toBe('2025-09-30');
  });

  it('a real instant carries an explicit offset in the display zone', () => {
    expect(put('2026-09-26T10:00:00Z', false)).toEqual({
      releaseDate: '2026-09-26T06:00:00-04:00',
      releaseDateDisplay: 'Sat, Sep 26, 2026, 6:00 AM EDT',
    });
    expect(put('1997-05-21T07:00:00.000Z', false).releaseDate).toBe('1997-05-21T03:00:00-04:00');
  });

  it('a bare date stays a date', () => {
    expect(put('2026-09-24')).toEqual({ releaseDate: '2026-09-24', releaseDateDisplay: 'Thu, Sep 24, 2026' });
  });

  it('passes an unrecognised value through untouched and ignores a missing one', () => {
    expect(put('Sat, 26 Sep 2026')).toEqual({ releaseDate: 'Sat, 26 Sep 2026' });
    expect(put('2026-13-01T00:00:00Z')).toEqual({ releaseDate: '2026-13-01T00:00:00Z' });
    expect(put(undefined)).toEqual({});
    expect(put('')).toEqual({});
    expect(put(12345)).toEqual({});
  });
});

describe('formatDuration', () => {
  it('rounds to the nearest whole second, with hours when needed', () => {
    expect(formatDuration(299_560)).toBe('5:00');
    expect(formatDuration(239_500)).toBe('4:00');
    expect(formatDuration(239_499)).toBe('3:59');
    expect(formatDuration(200_600)).toBe('3:21');
    expect(formatDuration(4_644_000)).toBe('1:17:24');
    expect(formatDuration(3_599_500)).toBe('1:00:00');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(-1_000)).toBe('0:00');
  });

  it('formats every duration exactly as the apple_music_* tools do (same catalog ids, same milliseconds)', () => {
    const samples = [0, 1, 499, 500, 999, 59_499, 59_500, 200_600, 239_500, 239_999, 299_560, 3_599_499, 3_599_500, 4_644_000, 36_000_000, -1_000];
    for (let ms = 0; ms < 7_300_000; ms += 1_237) samples.push(ms);
    for (const ms of samples) expect(formatDuration(ms), `${ms} ms`).toBe(musicFormatDuration(ms));
  });
});

describe('recordType / primaryId', () => {
  it('derives a type from kind, collectionType or wrapperType', () => {
    expect(recordType(SONG)).toBe('song');
    expect(recordType(ALBUM)).toBe('album');
    expect(recordType({ wrapperType: 'collection' })).toBe('collection');
    expect(recordType(ARTIST)).toBe('artist');
    expect(recordType(AUDIOBOOK)).toBe('audiobook');
    expect(recordType({})).toBe('unknown');
  });

  it('names the record by trackId, else collectionId, else artistId', () => {
    expect(primaryId(SONG)).toBe('1097861834');
    expect(primaryId(ALBUM)).toBe('1097861387');
    expect(primaryId(ARTIST)).toBe('909253');
    expect(primaryId({ trackId: '42' })).toBe('42');
    expect(primaryId({ trackId: '', collectionId: null })).toBeUndefined();
  });
});

describe('compactItunesRecord', () => {
  it('keeps what a caller acts on for a song and drops artwork, previews, prices and duplicates', () => {
    expect(compactItunesRecord(SONG, NY)).toEqual({
      type: 'song',
      trackId: 1097861834,
      trackName: 'Let Down',
      collectionId: 1097861387,
      collectionName: 'OK Computer',
      artistId: 657515,
      artistName: 'Radiohead',
      releaseDate: '1997-05-21',
      releaseDateDisplay: 'Wed, May 21, 1997',
      duration: '5:00',
      durationMs: 299560,
      trackNumber: 5,
      trackCount: 12,
      discNumber: 1,
      discCount: 1,
      primaryGenreName: 'Alternative',
      explicitness: 'notExplicit',
      isStreamable: true,
      url: SONG.trackViewUrl,
    });
  });

  it('albums and audiobooks link to the collection', () => {
    const album = compactItunesRecord(ALBUM, NY);
    expect(album).toMatchObject({ type: 'album', collectionId: 1097861387, explicitness: 'notExplicit', url: ALBUM.collectionViewUrl });
    expect(album).not.toHaveProperty('trackId');
    const book = compactItunesRecord(AUDIOBOOK, NY);
    expect(book).toMatchObject({ type: 'audiobook', releaseDate: '2015-11-20', explicitness: 'cleaned', url: AUDIOBOOK.collectionViewUrl });
    expect(compactItunesRecord({ wrapperType: 'collection', collectionType: 'Album', trackViewUrl: 'https://x/t' }, NY).url).toBe('https://x/t');
  });

  it('artists link to their artist page', () => {
    expect(compactItunesRecord(ARTIST, NY)).toEqual({
      type: 'artist',
      artistId: 909253,
      artistName: 'Jack Johnson',
      primaryGenreName: 'Rock',
      url: ARTIST.artistLinkUrl,
    });
    expect(compactItunesRecord({ wrapperType: 'artist', artistViewUrl: 'https://x/a' }, NY).url).toBe('https://x/a');
  });

  it('a podcast keeps feedUrl and its episode count, but not its meaningless duration', () => {
    const out = compactItunesRecord(PODCAST, NY);
    expect(out).toMatchObject({
      type: 'podcast',
      trackCount: 2731,
      feedUrl: PODCAST.feedUrl,
      releaseDate: '2026-09-26T06:00:00-04:00',
      contentAdvisoryRating: 'Clean',
      explicitness: 'cleaned',
    });
    expect(out).not.toHaveProperty('duration');
    expect(out).not.toHaveProperty('artworkUrl600');
  });

  it('an episode keeps its audio URL, guid, short description and publish instant', () => {
    const out = compactItunesRecord(episode(1), NY);
    expect(out).toEqual({
      type: 'podcast-episode',
      trackId: 1000791747107,
      trackName: 'Episode 1',
      collectionId: 1200361736,
      collectionName: 'The Daily',
      releaseDate: '2026-09-26T06:00:00-04:00',
      releaseDateDisplay: 'Sat, Sep 26, 2026, 6:00 AM EDT',
      duration: '30:39',
      durationMs: 1_839_000,
      episodeGuid: 'guid-1',
      feedUrl: 'https://feeds.simplecast.com/Sl5CSM3S',
      episodeUrl: 'https://dts.podtrac.com/redirect.mp3/ep1.mp3',
      shortDescription: 'Episode 1 in short.',
      url: episode(1).trackViewUrl,
    });
  });

  it('apps keep bundle id, version, seller, price label, ratings and build instants', () => {
    expect(compactItunesRecord(SOFTWARE, NY)).toEqual({
      type: 'software',
      trackId: 361309726,
      trackName: 'Pages: Create Documents',
      artistId: 284417353,
      artistName: 'Apple',
      releaseDate: '2010-04-01T16:36:57-04:00',
      releaseDateDisplay: 'Thu, Apr 1, 2010, 4:36 PM EDT',
      primaryGenreName: 'Productivity',
      contentAdvisoryRating: '4+',
      formattedPrice: 'Free',
      averageUserRating: 4.64355,
      userRatingCount: 571523,
      bundleId: 'com.apple.Pages',
      version: '15.3',
      sellerName: 'Apple Inc.',
      currentVersionReleaseDate: '2026-06-30T13:02:13-04:00',
      currentVersionReleaseDateDisplay: 'Tue, Jun 30, 2026, 1:02 PM EDT',
      url: SOFTWARE.trackViewUrl,
    });
  });

  it('ebooks and records without links', () => {
    expect(compactItunesRecord(EBOOK, NY)).toMatchObject({ type: 'ebook', releaseDate: '2011-04-05', formattedPrice: '$9.99', averageUserRating: 4 });
    expect(compactItunesRecord({ kind: 'song', collectionViewUrl: 'https://x/c' }, NY).url).toBe('https://x/c');
    expect(compactItunesRecord({ kind: 'song', trackTimeMillis: 'long', isStreamable: 'yes', trackId: null }, NY)).toEqual({ type: 'song' });
    // An id that drifted to a string is kept, not dropped.
    expect(compactItunesRecord({ kind: 'song', trackId: '1097861834', artistId: '' }, NY)).toEqual({ type: 'song', trackId: '1097861834' });
  });

  it('throws on a non-object so projectOrRaw falls back to the raw array', () => {
    expect(() => compactItunesRecord('nope', NY)).toThrow('not an object');
    expect(() => compactItunesRecord(null, NY)).toThrow('not an object');
    expect(() => compactItunesRecord([], NY)).toThrow('not an object');
  });
});

describe('compactChartEntry', () => {
  it('a charted song: rank, ids, album id from the link, genre names, explicit flag', () => {
    expect(compactChartEntry(chartSong(0), 1, NY)).toEqual({
      rank: 1,
      id: '6814997425',
      name: 'Song 0',
      artistName: 'Taylor Swift',
      artistId: '159260351',
      collectionId: '6814997249',
      releaseDate: '2026-09-24',
      releaseDateDisplay: 'Thu, Sep 24, 2026',
      genres: ['Pop', 'Music'],
      explicit: true,
      url: 'https://music.apple.com/us/album/song-0/6814997249?i=6814997425',
    });
    expect(compactChartEntry(chartSong(1), 2, NY)).not.toHaveProperty('explicit');
  });

  it("a charted episode's show id comes from its link", () => {
    expect(compactChartEntry(CHART_EPISODE, 3, NY)).toMatchObject({ rank: 3, id: '1000791716703', collectionId: '1535809341', explicit: true });
    expect(compactChartEntry({ id: '1', url: 'https://podcasts.apple.com/us/podcast/x/id77?uo=4&i=5' }, 1, NY).collectionId).toBe('77');
  });

  it('a playlist has no artist, no genres and no collection id', () => {
    expect(compactChartEntry(CHART_PLAYLIST, 4, NY)).toEqual({
      rank: 4,
      id: CHART_PLAYLIST.id,
      name: 'Today’s Country',
      url: CHART_PLAYLIST.url,
    });
  });

  it('tolerates odd genre entries and missing fields', () => {
    expect(
      compactChartEntry({ id: '9', genres: ['Pop', { genreId: '1' }, { name: 'Rock' }], contentAdvisoryRating: 'Clean' }, 5, NY),
    ).toEqual({ rank: 5, id: '9', genres: ['Rock'] });
    expect(compactChartEntry({ id: '9', genres: 'Pop' }, 6, NY)).toEqual({ rank: 6, id: '9' });
    expect(compactChartEntry({ id: 9, artistId: 12 }, 6, NY)).toEqual({ rank: 6, id: 9, artistId: 12 });
    expect(compactChartEntry({ id: '9', url: 'https://music.apple.com/us/album/x/1' }, 7, NY)).toEqual({
      rank: 7,
      id: '9',
      url: 'https://music.apple.com/us/album/x/1',
    });
  });

  it('throws on a non-object', () => {
    expect(() => compactChartEntry(42, 1, NY)).toThrow('not an object');
  });
});

// Records captured from live iTunes Search / Lookup and Apple chart responses
// (2026-09-26), trimmed to the fields that matter plus the ones compact drops.

export const SONG = {
  wrapperType: 'track',
  kind: 'song',
  artistId: 657515,
  collectionId: 1097861387,
  trackId: 1097861834,
  artistName: 'Radiohead',
  collectionName: 'OK Computer',
  trackName: 'Let Down',
  collectionCensoredName: 'OK Computer',
  trackCensoredName: 'Let Down',
  artistViewUrl: 'https://music.apple.com/us/artist/radiohead/657515?uo=4',
  collectionViewUrl: 'https://music.apple.com/us/album/let-down/1097861387?i=1097861834&uo=4',
  trackViewUrl: 'https://music.apple.com/us/album/let-down/1097861387?i=1097861834&uo=4',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/cd/65/58/x.m4a',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/07/60/ba/x/100x100bb.jpg',
  collectionPrice: 9.99,
  trackPrice: 1.29,
  releaseDate: '1997-05-21T07:00:00Z',
  collectionExplicitness: 'notExplicit',
  trackExplicitness: 'notExplicit',
  discCount: 1,
  discNumber: 1,
  trackCount: 12,
  trackNumber: 5,
  trackTimeMillis: 299560,
  country: 'USA',
  currency: 'USD',
  primaryGenreName: 'Alternative',
  isStreamable: true,
};

export const ALBUM = {
  wrapperType: 'collection',
  collectionType: 'Album',
  artistId: 657515,
  collectionId: 1097861387,
  amgArtistId: 41092,
  artistName: 'Radiohead',
  collectionName: 'OK Computer',
  collectionCensoredName: 'OK Computer',
  artistViewUrl: 'https://music.apple.com/us/artist/radiohead/657515?uo=4',
  collectionViewUrl: 'https://music.apple.com/us/album/ok-computer/1097861387?uo=4',
  collectionPrice: 9.99,
  collectionExplicitness: 'notExplicit',
  trackCount: 12,
  copyright: '℗ 1997 XL Recordings Ltd',
  country: 'USA',
  currency: 'USD',
  releaseDate: '1997-05-21T07:00:00Z',
  primaryGenreName: 'Alternative',
};

export const ARTIST = {
  wrapperType: 'artist',
  artistType: 'Artist',
  artistName: 'Jack Johnson',
  artistLinkUrl: 'https://music.apple.com/us/artist/jack-johnson/909253?uo=4',
  artistId: 909253,
  amgArtistId: 468749,
  primaryGenreName: 'Rock',
  primaryGenreId: 21,
};

export const PODCAST = {
  wrapperType: 'track',
  kind: 'podcast',
  artistId: 121664449,
  collectionId: 1200361736,
  trackId: 1200361736,
  artistName: 'The New York Times',
  collectionName: 'The Daily',
  trackName: 'The Daily',
  collectionViewUrl: 'https://podcasts.apple.com/us/podcast/the-daily/id1200361736?uo=4',
  feedUrl: 'https://feeds.simplecast.com/Sl5CSM3S',
  trackViewUrl: 'https://podcasts.apple.com/us/podcast/the-daily/id1200361736?uo=4',
  artworkUrl600: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/x/600x600bb.jpg',
  collectionPrice: 0,
  trackPrice: 0,
  releaseDate: '2026-09-26T10:00:00Z',
  collectionExplicitness: 'notExplicit',
  trackExplicitness: 'cleaned',
  trackCount: 2731,
  trackTimeMillis: 4644,
  primaryGenreName: 'Daily News',
  contentAdvisoryRating: 'Clean',
  genreIds: ['1526', '26', '1489'],
  genres: ['Daily News', 'Podcasts', 'News'],
};

export function episode(n: number): Record<string, unknown> {
  return {
    artworkUrl600: 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/x/600x600bb.jpg',
    artistIds: [],
    genres: [{ name: 'Daily News', id: '1526' }],
    episodeGuid: `guid-${n}`,
    shortDescription: `Episode ${n} in short.`,
    trackName: `Episode ${n}`,
    trackId: 1000791747108 - n,
    releaseDate: '2026-09-26T10:00:00Z',
    closedCaptioning: 'none',
    feedUrl: 'https://feeds.simplecast.com/Sl5CSM3S',
    collectionId: 1200361736,
    collectionName: 'The Daily',
    kind: 'podcast-episode',
    wrapperType: 'podcastEpisode',
    description: `A long description of episode ${n}.`,
    country: 'USA',
    episodeFileExtension: 'mp3',
    episodeContentType: 'audio',
    previewUrl: `https://dts.podtrac.com/redirect.mp3/ep${n}.mp3`,
    episodeUrl: `https://dts.podtrac.com/redirect.mp3/ep${n}.mp3`,
    collectionViewUrl: 'https://itunes.apple.com/us/podcast/the-daily/id1200361736?mt=2&uo=4',
    trackViewUrl: `https://podcasts.apple.com/us/podcast/episode-${n}/id1200361736?i=${1000791747108 - n}&uo=4`,
    trackTimeMillis: 1_839_000,
  };
}

export const SOFTWARE = {
  kind: 'software',
  wrapperType: 'software',
  trackId: 361309726,
  trackName: 'Pages: Create Documents',
  bundleId: 'com.apple.Pages',
  version: '15.3',
  sellerName: 'Apple Inc.',
  formattedPrice: 'Free',
  price: 0,
  averageUserRating: 4.64355,
  userRatingCount: 571523,
  releaseDate: '2010-04-01T20:36:57Z',
  currentVersionReleaseDate: '2026-06-30T17:02:13Z',
  contentAdvisoryRating: '4+',
  primaryGenreName: 'Productivity',
  artistId: 284417353,
  artistName: 'Apple',
  trackViewUrl: 'https://apps.apple.com/us/app/pages-create-documents/id361309726?uo=4',
  description: 'A very long app description.',
  screenshotUrls: ['https://is1-ssl.mzstatic.com/a.png'],
};

export const EBOOK = {
  artistIds: [2087642],
  artistId: 2087642,
  artistName: 'Michael Connelly',
  genres: ['Mysteries & Thrillers', 'Books', 'Police Procedural'],
  price: 9.99,
  releaseDate: '2011-04-05T07:00:00Z',
  trackName: 'The Fifth Witness',
  trackId: 395519191,
  kind: 'ebook',
  currency: 'USD',
  formattedPrice: '$9.99',
  description: '<b>A long HTML description.</b>',
  trackViewUrl: 'https://books.apple.com/us/book/the-fifth-witness/id395519191?uo=4',
  averageUserRating: 4.0,
  userRatingCount: 3206,
};

export const AUDIOBOOK = {
  wrapperType: 'audiobook',
  artistId: 79595314,
  collectionId: 1442174040,
  artistName: 'J.K. Rowling',
  collectionName: "Harry Potter and the Sorcerer's Stone",
  artistViewUrl: 'https://books.apple.com/us/author/j-k-rowling/id79595314?uo=4',
  collectionViewUrl: 'https://books.apple.com/us/audiobook/harry-potter/id1442174040?uo=4',
  collectionPrice: 25.99,
  collectionExplicitness: 'cleaned',
  trackCount: 1,
  releaseDate: '2015-11-20T08:00:00Z',
  primaryGenreName: 'Kids & Young Adults',
};

export function chartSong(n: number): Record<string, unknown> {
  return {
    artistName: 'Taylor Swift',
    id: String(6814997425 + n),
    name: `Song ${n}`,
    releaseDate: '2026-09-24',
    kind: 'songs',
    artistId: '159260351',
    artistUrl: 'https://music.apple.com/us/artist/taylor-swift/159260351',
    ...(n % 2 === 0 ? { contentAdvisoryRating: 'Explict' } : {}),
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/x/100x100bb.jpg',
    genres: [
      { genreId: '14', name: 'Pop', url: 'https://itunes.apple.com/us/genre/id14' },
      { genreId: '34', name: 'Music', url: 'https://itunes.apple.com/us/genre/id34' },
    ],
    url: `https://music.apple.com/us/album/song-${n}/6814997249?i=${6814997425 + n}`,
  };
}

export const CHART_EPISODE = {
  artistName: 'The Joe Budden Network',
  id: '1000791716703',
  name: 'Episode 967 | "Guys Love Karaoke"',
  kind: 'podcast-episodes',
  contentAdvisoryRating: 'Explict',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.png',
  genres: [{ genreId: '1310', name: 'Music', url: 'https://itunes.apple.com/us/genre/id1310' }],
  url: 'https://podcasts.apple.com/us/podcast/episode-967-guys-love-karaoke/id1535809341?i=1000791716703',
};

export const CHART_PLAYLIST = {
  id: 'pl.87bb5b36a9bd49db8c975607452bfa2b',
  name: 'Today’s Country',
  kind: 'playlists',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100SC.DN01.jpg?l=en-US',
  genres: [],
  url: 'https://music.apple.com/us/playlist/todays-country/pl.87bb5b36a9bd49db8c975607452bfa2b',
};

export function chartFeed(results: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feed: {
      title: 'Top Songs',
      id: 'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/25/songs.json',
      author: { name: 'Apple', url: 'https://www.apple.com/' },
      links: [{ self: 'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/25/songs.json' }],
      copyright: 'Copyright © 2026 Apple Inc. All rights reserved.',
      country: 'us',
      icon: 'https://www.apple.com/favicon.ico',
      updated: 'Sat, 26 Sep 2026 23:54:36 +0000',
      results,
      ...extra,
    },
  };
}

/** A Response the way itunes.apple.com sends it: JSON labelled text/javascript. */
export function itunesResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename=1.txt' },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export function envelope(results: unknown[]): Record<string, unknown> {
  return { resultCount: results.length, results };
}

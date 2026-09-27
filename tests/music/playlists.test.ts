import { describe, expect, it } from 'vitest';
import { MusicClient } from '../../src/music/client.js';
import { appendWarnings, folderIdArg, playlistFields, readFolder, refuseReadOnly, trackKey, trackLabel } from '../../src/music/playlists.js';
import { attrs, firstDataId, nameOf } from '../../src/music/project.js';
import { installFetch, route, useWeb } from './_helpers.js';

describe('playlist helpers', () => {
  it('playlistFields reads name, description (string, {standard}, {short}, {} or absent) and isPublic', () => {
    expect(playlistFields({ id: 'p', type: 'x', attributes: { name: 'N', description: 'plain', isPublic: true } })).toEqual({ name: 'N', description: 'plain', isPublic: true });
    expect(playlistFields({ id: 'p', type: 'x', attributes: { description: { standard: 'std' } } })).toEqual({ description: 'std' });
    // Only a short form: read it (update_playlist sends the description back; "" would clear it).
    expect(playlistFields({ id: 'p', type: 'x', attributes: { description: { short: 'brief' } } })).toEqual({ description: 'brief' });
    expect(playlistFields({ id: 'p', type: 'x', attributes: { description: {} } })).toEqual({ description: '' });
    expect(playlistFields({ id: 'p', type: 'x' })).toEqual({});
  });

  it('trackLabel / trackKey / nameOf / attrs / firstDataId cope with bare records', () => {
    expect(trackLabel({ id: 'i.1', type: 'library-songs' }, 3)).toEqual({ position: 3, name: 'i.1', id: 'i.1' });
    expect(trackLabel({ id: 'i.1', type: 'library-songs', attributes: { name: 'S', artistName: 'A' } }, 1)).toEqual({ position: 1, name: 'S', artistName: 'A', id: 'i.1' });
    expect(trackKey({ id: 'i.1', type: 'library-songs', attributes: { playParams: { catalogId: '9' } } })).toBe('9');
    expect(trackKey({ id: 'i.1', type: 'library-songs' })).toBe('i.1');
    expect(nameOf({ id: 'x', type: 't' }, 'fallback')).toBe('fallback');
    expect(nameOf({ id: 'x', type: 't' })).toBe('x');
    expect(attrs({ id: 'x', type: 't', attributes: 'nope' as never })).toEqual({});
    expect(firstDataId({ data: [{ id: 'p.1' }] })).toBe('p.1');
    expect(firstDataId({ data: ['x'] })).toBeUndefined();
    expect(firstDataId({ data: {} })).toBeUndefined();
    expect(firstDataId(null)).toBeUndefined();
    expect(folderIdArg('root')).toBe('p.playlistsroot');
    expect(folderIdArg('p.x')).toBe('p.x');
  });

  it('refuseReadOnly only refuses canEdit:false', () => {
    expect(() => refuseReadOnly({ id: 'p', type: 'x', attributes: { canEdit: false } }, 'N')).toThrow(/"N" cannot be edited/);
    expect(() => refuseReadOnly({ id: 'p', type: 'x', attributes: { canEdit: true } }, 'N')).not.toThrow();
    expect(() => refuseReadOnly({ id: 'p', type: 'x' }, 'N')).not.toThrow();
  });

  it('appendWarnings is empty without a failure', () => {
    expect(appendWarnings({ added: 3, notAttempted: 0 })).toEqual([]);
    expect(appendWarnings({ added: 0, notAttempted: 0, failure: { fromTrack: 1, toTrack: 1, message: 'x', unconfirmed: false, error: new Error('x') } })).toEqual(['Tracks 1–1 were not added: x']);
  });

  it('readFolder: an empty data array is NOT_FOUND', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/library/playlist-folders/p.Z', { json: { data: [] } }));
    const s = new MusicClient().session('library', 'x');
    await expect(readFolder(s, 'p.Z')).rejects.toMatchObject({ code: 'NOT_FOUND', hint: expect.stringMatching(/apple_music_list_folders/) });
  });
});

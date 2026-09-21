import { describe, expect, it } from 'vitest';
import { AnkiConnect, AnkiConnectError, bytesToBase64, blobToBase64, mediaFilename, type FetchLike } from './anki-connect';

interface Call {
  url: string;
  body: { action: string; version: number; params: Record<string, unknown> };
}

/** Fake fetch: replies per action; records requests. */
function fakeFetch(replies: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>, opts: { status?: number; raw?: string; throwNetwork?: boolean } = {}) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    if (opts.throwNetwork) throw new TypeError('Failed to fetch');
    const body = JSON.parse(String(init.body)) as Call['body'];
    calls.push({ url, body });
    if (opts.raw !== undefined) return new Response(opts.raw, { status: opts.status ?? 200 });
    const r = replies[body.action];
    const result = typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(body.params) : r;
    const payload = result && typeof result === 'object' && '__error' in (result as object) ? { result: null, error: (result as { __error: string }).__error } : { result, error: null };
    return new Response(JSON.stringify(payload), { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { f, calls };
}

describe('AnkiConnect', () => {
  it('sends version-6 requests with CORS to the configured URL', async () => {
    const { f, calls } = fakeFetch({ version: 6 });
    const anki = new AnkiConnect('http://127.0.0.1:8765', f);
    expect(await anki.version()).toBe(6);
    expect(calls[0].url).toBe('http://127.0.0.1:8765');
    expect(calls[0].body).toEqual({ action: 'version', version: 6, params: {} });
  });

  it('maps requestPermission to a boolean', async () => {
    const granted = new AnkiConnect('u', fakeFetch({ requestPermission: { permission: 'granted', requireApiKey: false, version: 6 } }).f);
    expect(await granted.requestPermission()).toBe(true);
    const denied = new AnkiConnect('u', fakeFetch({ requestPermission: { permission: 'denied' } }).f);
    expect(await denied.requestPermission()).toBe(false);
  });

  it('findLatestNoteId picks the highest id and returns null when empty', async () => {
    const { f, calls } = fakeFetch({ findNotes: [1700000000001, 1700000000999, 1700000000500] });
    const anki = new AnkiConnect('u', f);
    expect(await anki.findLatestNoteId()).toBe(1700000000999);
    expect(calls[0].body.params).toEqual({ query: 'added:1' });
    expect(await new AnkiConnect('u', fakeFetch({ findNotes: [] }).f).findLatestNoteId()).toBeNull();
    expect(await new AnkiConnect('u', fakeFetch({ findNotes: null }).f).findLatestNoteId()).toBeNull();
  });

  it('updateNoteMedia builds the updateNoteFields shape and addTags trims/skips', async () => {
    const { f, calls } = fakeFetch({ updateNoteFields: null, addTags: null });
    const anki = new AnkiConnect('u', f);
    await anki.updateNoteMedia(42, {
      audio: { data: 'QUJD', filename: 'a.mp3', fields: ['SentenceAudio'] },
      picture: { data: 'REVG', filename: 'p.webp', fields: ['Picture'] },
    });
    expect(calls[0].body.action).toBe('updateNoteFields');
    expect(calls[0].body.params).toEqual({
      note: {
        id: 42,
        fields: {},
        audio: [{ data: 'QUJD', filename: 'a.mp3', fields: ['SentenceAudio'] }],
        picture: [{ data: 'REVG', filename: 'p.webp', fields: ['Picture'] }],
      },
    });
    await anki.updateNoteMedia(43, { audio: { data: 'x', filename: 'a.mp3', fields: ['A'] } });
    expect(calls[1].body.params).toEqual({ note: { id: 43, fields: {}, audio: [{ data: 'x', filename: 'a.mp3', fields: ['A'] }] } });
    await anki.addTags([42], '  ppsspp-web ');
    expect(calls[2].body).toEqual({ action: 'addTags', version: 6, params: { notes: [42], tags: 'ppsspp-web' } });
    await anki.addTags([42], '   ');
    await anki.addTags([], 'x');
    expect(calls.length).toBe(3);
  });

  it('surfaces the error field, HTTP failures, bad JSON and network errors as AnkiConnectError', async () => {
    const apiErr = new AnkiConnect('u', fakeFetch({ findNotes: { __error: 'collection is not available' } }).f);
    await expect(apiErr.findLatestNoteId()).rejects.toMatchObject({ name: 'AnkiConnectError', kind: 'api', message: 'collection is not available' });

    const http = new AnkiConnect('u', fakeFetch({}, { status: 500, raw: 'boom' }).f);
    await expect(http.version()).rejects.toMatchObject({ kind: 'network', message: 'AnkiConnect HTTP 500' });

    const bad = new AnkiConnect('u', fakeFetch({}, { raw: 'not json' }).f);
    await expect(bad.version()).rejects.toMatchObject({ kind: 'api' });

    const shape = new AnkiConnect('u', fakeFetch({}, { raw: '{"foo":1}' }).f);
    await expect(shape.version()).rejects.toMatchObject({ kind: 'api', message: /missing required fields/ });

    const net = new AnkiConnect('http://127.0.0.1:8765', fakeFetch({}, { throwNetwork: true }).f);
    const err = await net.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnkiConnectError);
    expect((err as AnkiConnectError).kind).toBe('network');
    expect((err as Error).message).toMatch(/Cannot reach AnkiConnect at http:\/\/127\.0\.0\.1:8765/);
  });

  it('guiBrowse swallows errors', async () => {
    const anki = new AnkiConnect('u', fakeFetch({ guiBrowse: { __error: 'no gui' } }).f);
    await expect(anki.guiBrowse(1)).resolves.toBeUndefined();
  });
});

describe('base64 + filenames', () => {
  it('encodes bytes and blobs to standard base64', async () => {
    expect(bytesToBase64(new Uint8Array([65, 66, 67]))).toBe('QUJD');
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    const big = new Uint8Array(70_000).fill(0xff);
    const b64 = bytesToBase64(big);
    expect(b64.length).toBe(Math.ceil(70_000 / 3) * 4);
    expect(await blobToBase64(new Blob([new Uint8Array([0, 255, 16])]))).toBe('AP8Q');
  });

  it('builds filesystem-safe media names', () => {
    const at = new Date(2026, 8, 21, 12, 45, 0, 7);
    expect(mediaFilename('ULJM05500', 'mp3', at)).toBe('ppsspp_ULJM05500_20260921-124500-007.mp3');
    expect(mediaFilename('My Game (JP).iso', 'webp', at)).toBe('ppsspp_My_Game_JP_20260921-124500-007.webp');
    expect(mediaFilename(null, 'webp', at)).toBe('ppsspp_game_20260921-124500-007.webp');
    expect(mediaFilename('!!!', 'mp3', at)).toBe('ppsspp_game_20260921-124500-007.mp3');
  });
});

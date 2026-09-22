/**
 * AnkiConnect client (API version 6). Talks to a local Anki instance (desktop
 * add-on 2055492159 or AnkiConnect Android). From an https, cross-origin-isolated
 * page a CORS-mode fetch to http://127.0.0.1 is allowed (loopback is potentially
 * trustworthy); the user must approve the origin once inside Anki
 * (`requestPermission`).
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AnkiMediaAttachment {
  /** Base64 file body (no data: prefix). */
  data: string;
  filename: string;
  /** Fields to which `[sound:…]` / `<img>` is appended. */
  fields: string[];
}

export interface UpdateNoteMediaInput {
  audio?: AnkiMediaAttachment;
  picture?: AnkiMediaAttachment;
}

export class AnkiConnectError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'api' | 'permission' | 'no-note' = 'api',
  ) {
    super(message);
    this.name = 'AnkiConnectError';
  }
}

export class AnkiConnect {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  /** Raw call. Throws AnkiConnectError when the transport fails or `error` is set. */
  async invoke<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }),
      });
    } catch (e) {
      throw new AnkiConnectError(`Cannot reach AnkiConnect at ${this.url} (${(e as Error)?.message ?? e}). Is Anki running with the AnkiConnect add-on?`, 'network');
    }
    if (!res.ok) throw new AnkiConnectError(`AnkiConnect HTTP ${res.status}`, 'network');
    let body: { result?: T; error?: string | null };
    try {
      body = (await res.json()) as { result?: T; error?: string | null };
    } catch {
      throw new AnkiConnectError('AnkiConnect returned a non-JSON response', 'api');
    }
    if (!body || typeof body !== 'object' || !('result' in body) || !('error' in body)) {
      throw new AnkiConnectError('AnkiConnect response is missing required fields', 'api');
    }
    if (body.error) throw new AnkiConnectError(String(body.error), 'api');
    return body.result as T;
  }

  /** Ask Anki to allow this origin. Resolves true when granted. */
  async requestPermission(): Promise<boolean> {
    const r = await this.invoke<{ permission: 'granted' | 'denied'; requireApiKey?: boolean; version?: number }>('requestPermission');
    return r?.permission === 'granted';
  }

  version(): Promise<number> {
    return this.invoke<number>('version');
  }

  /** Newest note among those added today, or null when none. */
  async findLatestNoteId(): Promise<number | null> {
    const ids = await this.invoke<number[]>('findNotes', { query: 'added:1' });
    if (!Array.isArray(ids) || ids.length === 0) return null;
    // Note ids are creation timestamps in ms, so the max is the most recent.
    let best = -Infinity;
    for (const id of ids) if (typeof id === 'number' && id > best) best = id;
    return Number.isFinite(best) ? best : null;
  }

  /** Attach audio/picture to a note via `updateNoteFields` (fields stay untouched otherwise). */
  async updateNoteMedia(noteId: number, media: UpdateNoteMediaInput, fields: Record<string, string> = {}): Promise<void> {
    const note: Record<string, unknown> = { id: noteId, fields };
    if (media.audio) note['audio'] = [media.audio];
    if (media.picture) note['picture'] = [media.picture];
    await this.invoke('updateNoteFields', { note });
  }

  async addTags(noteIds: number[], tags: string): Promise<void> {
    if (!tags.trim() || noteIds.length === 0) return;
    await this.invoke('addTags', { notes: noteIds, tags: tags.trim() });
  }

  /** Optional GUI refresh so the Browse window shows the new media. */
  async guiBrowse(noteId: number): Promise<void> {
    try {
      await this.invoke('guiBrowse', { query: `nid:${noteId}` });
    } catch {
      /* best effort */
    }
  }
}

/** Blob → base64 (no data URL prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') throw new Error('btoa unavailable');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return btoa(s);
}

/** Filename-safe game id + timestamp: `ppsspp_ULJM05500_20260921-124500-123.mp3`. */
export function mediaFilename(gameId: string | null, ext: 'mp3' | 'webp', now = new Date()): string {
  const g = (gameId ?? 'game').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'game';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
  return `ppsspp_${g}_${ts}.${ext}`;
}

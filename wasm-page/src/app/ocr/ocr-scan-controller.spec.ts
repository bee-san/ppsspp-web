import { describe, expect, it } from 'vitest';
import type { LayoutSnapshot, TextHit } from 'meikiocr-web/meikipop';
import type { OcrSnapshot } from 'meikiocr-web';
import { OcrScanController, probeChanged, UNCHANGED_BACKOFF_MS, type ControllerPorts, type Scheduler } from './ocr-scan-controller';
import { DEFAULT_OCR_SETTINGS, FULL_REGION, type CapturedGameFrame, type OcrSettings, type PublishedLayout } from './ocr-types';

/** Deterministic virtual clock + timers. */
class FakeScheduler implements Scheduler {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: number) {
    this.timers.delete(id);
  }
  /** Advance time, firing due timers in order, and flushing microtasks between. */
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = Math.max(this.t, due[1].at);
      this.timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Harness {
  ctrl: OcrScanController;
  sched: FakeScheduler;
  captures: number;
  ocrCalls: number;
  layouts: (PublishedLayout | null)[];
  hits: (TextHit | null)[];
  setPixels(v: number): void;
  setOcrDelay(ms: number): void;
  failNextOcr(): void;
  resolveOcr(): void;
}

function makeSnapshot(frameId: string, text: string): OcrSnapshot {
  const glyphs = Array.from(text).map((ch, i) => ({
    id: `l0g${i}`,
    text: ch,
    box: [10 + i * 10, 10, 20 + i * 10, 20] as const,
    confidence: 0.9,
    utf16Start: i,
    utf16End: i + 1,
  }));
  return {
    frameId,
    width: 100,
    height: 50,
    profile: 'meikipop-v2',
    lines: text ? [{ id: 'l0', text, box: [10, 10, 10 + text.length * 10, 20], orientation: 'horizontal', glyphs }] : [],
    diagnostics: { backend: 'wasm', elapsedMs: 5, modelSetId: 'm', warnings: [] },
  };
}

function makeLayout(s: OcrSnapshot): LayoutSnapshot {
  return {
    frameId: s.frameId,
    width: s.width,
    height: s.height,
    filteredLineIds: [],
    paragraphs: s.lines.map((l, i) => ({
      id: `p${i}`,
      text: l.text,
      orientation: l.orientation,
      isFurigana: false,
      box: l.box,
      norm: { cx: 0.5, cy: 0.5, w: 1, h: 1 },
      lineIds: [l.id],
      glyphs: l.glyphs.map((g, gi) => ({
        glyphId: g.id,
        lineId: l.id,
        text: g.text,
        box: g.box,
        norm: { cx: (g.box[0] + 5) / s.width, cy: 15 / s.height, w: 10 / s.width, h: 10 / s.height },
        utf16Start: g.utf16Start,
        utf16End: g.utf16End,
        codePointIndex: gi,
      })),
    })),
  };
}

function harness(overrides: Partial<OcrSettings> = {}, opts: { ocrText?: string; detachBuffers?: boolean } = {}): Harness {
  const sched = new FakeScheduler();
  let pixels = 1;
  let ocrDelay = 0;
  let failNext = false;
  let ocrPending: (() => void) | null = null;
  const h: Harness = {
    ctrl: null as unknown as OcrScanController,
    sched,
    captures: 0,
    ocrCalls: 0,
    layouts: [],
    hits: [],
    setPixels: (v) => (pixels = v),
    setOcrDelay: (ms) => (ocrDelay = ms),
    failNextOcr: () => (failNext = true),
    resolveOcr: () => ocrPending?.(),
  };
  const ports: ControllerPorts = {
    capture: async (region) => {
      h.captures++;
      const rgba = new ArrayBuffer(100 * 50 * 4);
      new Uint8Array(rgba).fill(pixels);
      const frame: CapturedGameFrame = {
        frame: { frameId: `f${h.captures}`, width: 100, height: 50, capturedAtMs: sched.now(), rgba },
        meta: {
          gameSessionId: 1,
          sceneEpoch: 1,
          geometryVersion: 1,
          region,
          cropRect: { x: 0, y: 0, w: 100, h: 50 },
          scale: 1,
          imageWidth: 100,
          imageHeight: 50,
      sourceWidth: 480,
      sourceHeight: 272,
        },
      };
      return frame;
    },
    ocr: (frame) => {
      h.ocrCalls++;
      // Like the real client with transfer:'move': the frame buffer is transferred to the worker and detached here.
      if (opts.detachBuffers) structuredClone(frame.frame.rgba, { transfer: [frame.frame.rgba] });
      const shouldFail = failNext;
      failNext = false;
      const make = () => {
        if (shouldFail) throw new Error('ocr failed');
        return makeSnapshot(frame.frame.frameId, opts.ocrText ?? '日本語');
      };
      if (ocrDelay === 0) return shouldFail ? Promise.reject(new Error('ocr failed')) : Promise.resolve(make());
      if (ocrDelay < 0) {
        // manual resolution
        return new Promise((resolve, reject) => {
          ocrPending = () => {
            ocrPending = null;
            try {
              resolve(make());
            } catch (e) {
              reject(e);
            }
          };
        });
      }
      return new Promise((resolve, reject) => {
        sched.setTimeout(() => {
          try {
            resolve(make());
          } catch (e) {
            reject(e);
          }
        }, ocrDelay);
      });
    },
    buildLayout: makeLayout,
    hitTest: (layout, pt) => {
      for (const p of layout.paragraphs) {
        for (const g of p.glyphs) {
          if (pt.x >= g.box[0] && pt.x <= g.box[2] && pt.y >= g.box[1] && pt.y <= g.box[3]) {
            return {
              paragraphId: p.id,
              lineId: g.lineId,
              glyphId: g.glyphId,
              fullText: p.text,
              utf16Offset: g.utf16Start,
              codePointIndex: g.codePointIndex,
              suffix: p.text.slice(g.utf16Start),
              sourceBox: g.box,
            };
          }
        }
      }
      return null;
    },
    sourceSize: () => ({ width: 100, height: 50 }),
    onLayout: (p) => h.layouts.push(p),
    onHit: (hit) => h.hits.push(hit),
  };
  h.ctrl = new OcrScanController(ports, { ...DEFAULT_OCR_SETTINGS, enabled: true, ...overrides }, sched);
  return h;
}

async function ready(h: Harness) {
  h.ctrl.setEnabled(true);
  h.ctrl.setModelsReady(true);
  h.ctrl.setGameReady(true);
  h.ctrl.setDocumentVisible(true);
  await flush();
}

const move = (h: Harness, x: number, y: number) => h.ctrl.pointerMove({ clientX: x, clientY: y, norm: { x: x / 100, y: y / 50 } });

describe('OcrScanController (MeikiPop scheduling)', () => {
  it('initial ready state → exactly one initial scan', async () => {
    const h = harness();
    await ready(h);
    expect(h.captures).toBe(1);
    expect(h.ocrCalls).toBe(1);
    expect(h.layouts.length).toBe(1);
    await h.sched.advance(2000);
    expect(h.ocrCalls).toBe(1); // movement mode: no further scans without motion
  });

  it('does nothing until enabled + models + game + visible', async () => {
    const h = harness();
    h.ctrl.setEnabled(true);
    h.ctrl.setModelsReady(true);
    await flush();
    expect(h.captures).toBe(0);
    h.ctrl.setGameReady(true);
    await flush();
    expect(h.captures).toBe(1);
  });

  it('thousands of pointer events → bounded intents, immediate cached hits, no backlog', async () => {
    const h = harness();
    await ready(h);
    h.setPixels(2); // image changes so scans would run if unthrottled
    for (let i = 0; i < 3000; i++) move(h, 10 + (i % 30), 15);
    await flush();
    // Only the first movement scan can have been submitted (others throttled)
    expect(h.ocrCalls).toBeLessThanOrEqual(2);
    expect(h.ctrl.getDiagnostics().pendingIntent === null || h.ctrl.getDiagnostics().pendingIntent === 'movement').toBe(true);
    // cached hits were produced immediately from the initial layout
    expect(h.hits.filter(Boolean).length).toBeGreaterThan(100);
    const hitAt15 = h.hits.filter(Boolean).at(-1)!;
    expect(hitAt15.fullText).toBe('日本語');
  });

  it('motion every 50 ms with 500 ms interval → throttled, not starved', async () => {
    const h = harness();
    await ready(h);
    let px = 10;
    for (let i = 0; i < 40; i++) {
      h.setPixels(px++);
      move(h, 10 + (i % 5), 15);
      await h.sched.advance(50);
    }
    // 2000 ms of motion → initial + ~4 more scans (one per 500 ms), never 40
    expect(h.ocrCalls).toBeGreaterThanOrEqual(4);
    expect(h.ocrCalls).toBeLessThanOrEqual(6);
  });

  it('final movement inside the throttle window → trailing scan services the newest intent', async () => {
    const h = harness();
    await ready(h);
    h.setPixels(7);
    move(h, 12, 15);
    await flush();
    expect(h.ocrCalls).toBe(1); // throttled (initial was at t=0)
    expect(h.ctrl.getDiagnostics().pendingIntent).toBe('movement');
    await h.sched.advance(499);
    expect(h.ocrCalls).toBe(1);
    await h.sched.advance(2);
    expect(h.ocrCalls).toBe(2);
    expect(h.ctrl.getDiagnostics().pendingIntent).toBeNull();
  });

  it('unchanged pixels → no additional inference; hit target still follows pointer', async () => {
    const h = harness();
    await ready(h);
    await h.sched.advance(600);
    move(h, 12, 15);
    await h.sched.advance(600);
    move(h, 22, 15);
    await h.sched.advance(600);
    expect(h.captures).toBeGreaterThanOrEqual(3);
    expect(h.ocrCalls).toBe(1);
    expect(h.ctrl.getDiagnostics().scansSkippedUnchanged).toBeGreaterThanOrEqual(2);
    const last = h.hits.filter(Boolean).at(-1)!;
    expect(last.utf16Offset).toBe(1); // 本
  });

  it('inference slower than interval → one active scan, one pending intent, bounded', async () => {
    const h = harness();
    h.setOcrDelay(1500);
    await ready(h);
    expect(h.ctrl.getDiagnostics().activeInference).toBe(true);
    for (let i = 0; i < 20; i++) {
      h.setPixels(100 + i);
      move(h, 10 + i, 15);
      await h.sched.advance(100);
    }
    const d = h.ctrl.getDiagnostics();
    expect(d.activeInference || d.pendingIntent !== null).toBe(true);
    expect(h.ocrCalls).toBeLessThanOrEqual(3);
    await h.sched.advance(5000);
    expect(h.ocrCalls).toBeLessThanOrEqual(4);
    expect(h.ctrl.getDiagnostics().pendingIntent).toBeNull();
  });

  it('pointer moved during scan → result hit-tested against current pointer', async () => {
    const h = harness();
    h.setOcrDelay(-1);
    await ready(h);
    move(h, 12, 15); // over 日 while inference in flight
    move(h, 32, 15); // now over 語
    h.resolveOcr();
    await flush();
    const last = h.hits.filter(Boolean).at(-1)!;
    expect(last.utf16Offset).toBe(2);
    expect(last.suffix).toBe('語');
  });

  it('new game/region during scan → old result never appears', async () => {
    const h = harness();
    h.setOcrDelay(-1);
    await ready(h);
    h.ctrl.invalidate('game-changed');
    h.resolveOcr();
    await flush();
    expect(h.layouts.filter(Boolean).length).toBe(0);
    expect(h.ctrl.getDiagnostics().scansStale).toBe(1);
    // fresh initial scan for the new content is pending (still subject to the global interval)
    expect(h.ctrl.getDiagnostics().pendingIntent).toBe('initial');
    h.setOcrDelay(0);
    await h.sched.advance(500);
    expect(h.ocrCalls).toBe(2);
    expect(h.layouts.filter(Boolean).length).toBe(1);
  });

  it('manual mode: one rising-edge capture, not one per key repeat', async () => {
    const h = harness({ autoScan: false });
    await ready(h);
    expect(h.captures).toBe(0); // no initial scan outside auto mode
    h.ctrl.hotkeyDownEdge();
    h.ctrl.hotkeyDownEdge();
    h.ctrl.hotkeyDownEdge();
    await flush();
    expect(h.captures).toBe(1);
    expect(h.ocrCalls).toBe(1);
    h.ctrl.hotkeyUp();
    h.ctrl.hotkeyDownEdge();
    await flush();
    expect(h.captures).toBe(2);
    expect(h.ocrCalls).toBe(1); // identical image reused
    // activation requires key when lookupsWithoutHotkey applies only to auto mode
    move(h, 12, 15);
    expect(h.hits.filter(Boolean).length).toBeGreaterThan(0);
    h.ctrl.hotkeyUp();
    move(h, 13, 15);
    expect(h.hits.at(-1)).toBeNull();
  });

  it('hide tab / disable → no new scans; held key cleared; no reactivation', async () => {
    const h = harness();
    await ready(h);
    h.ctrl.hotkeyDownEdge();
    h.ctrl.setDocumentVisible(false);
    h.setPixels(9);
    move(h, 12, 15);
    await h.sched.advance(3000);
    expect(h.ocrCalls).toBe(1);
    expect(h.hits.filter(Boolean).length).toBe(0);
    h.ctrl.setDocumentVisible(true);
    await flush();
    // re-entering auto mode schedules a fresh initial scan (image changed → inference)
    expect(h.ocrCalls).toBe(2);
  });

  it('empty result then changed image → no false hit; changed image eligible', async () => {
    const h = harness({}, { ocrText: '' });
    await ready(h);
    move(h, 12, 15);
    expect(h.hits.filter(Boolean).length).toBe(0);
    await h.sched.advance(600);
    h.setPixels(3);
    move(h, 13, 15);
    await flush();
    expect(h.ocrCalls).toBe(2);
  });

  it('failed OCR followed by identical image → retry possible', async () => {
    const h = harness();
    h.failNextOcr();
    await ready(h);
    expect(h.ctrl.getDiagnostics().scansFailed).toBe(1);
    await h.sched.advance(600);
    move(h, 12, 15);
    await flush();
    expect(h.ocrCalls).toBe(2); // identical bytes were NOT cached as success
    expect(h.layouts.filter(Boolean).length).toBe(1);
  });

  it('refresh bypasses image equality once', async () => {
    const h = harness();
    await ready(h);
    await h.sched.advance(600);
    h.ctrl.refresh();
    await flush();
    expect(h.ocrCalls).toBe(2);
  });

  it('periodic mode scans at cadence without motion and never overlaps', async () => {
    const h = harness({ scanOnMouseMove: false });
    h.setOcrDelay(100);
    await ready(h);
    let px = 50;
    for (let i = 0; i < 10; i++) {
      h.setPixels(px++);
      await h.sched.advance(500);
    }
    expect(h.ocrCalls).toBeGreaterThanOrEqual(8);
    expect(h.ocrCalls).toBeLessThanOrEqual(11);
  });

  it('region change invalidates and re-scans once ready', async () => {
    const h = harness();
    await ready(h);
    h.ctrl.setRegion({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    await flush();
    expect(h.layouts).toContain(null);
    await h.sched.advance(500);
    expect(h.ocrCalls).toBe(2);
  });

  it("stale check ('remove' policy) retires spatial targets when the image changes while text is visible", async () => {
    const h = harness({ stalePolicy: 'remove' });
    await ready(h);
    expect(h.layouts.filter(Boolean).length).toBe(1);
    h.setPixels(42);
    await h.sched.advance(600);
    expect(h.layouts.at(-1)).toBeNull();
    // movement mode: no inference until movement
    expect(h.ocrCalls).toBe(1);
    move(h, 12, 15);
    await flush();
    expect(h.ocrCalls).toBe(2);
  });

  it('pointer leave keeps results but hides hit; return is instant', async () => {
    const h = harness();
    await ready(h);
    move(h, 12, 15);
    expect(h.hits.at(-1)).not.toBeNull();
    h.ctrl.pointerLeave();
    expect(h.hits.at(-1)).toBeNull();
    expect(h.ctrl.getPublished()).not.toBeNull();
    move(h, 22, 15);
    expect(h.hits.at(-1)?.utf16Offset).toBe(1);
  });

  it('unchanged detection survives the OCR port detaching (transferring) the frame buffer', async () => {
    const h = harness({}, { detachBuffers: true });
    await ready(h);
    expect(h.ocrCalls).toBe(1);
    for (let i = 0; i < 6; i++) {
      move(h, 10 + i, 15);
      await h.sched.advance(600);
    }
    // Same pixels every time: no further inference, layout kept.
    expect(h.ocrCalls).toBe(1);
    expect(h.layouts.filter((l) => l === null).length).toBe(0);
    expect(h.ctrl.getDiagnostics().scansSkippedUnchanged).toBeGreaterThan(0);
    // Stale check with identical pixels must not clear the layout either.
    await h.sched.advance(2000);
    expect(h.layouts.filter((l) => l === null).length).toBe(0);
  });

  it('disabling OCR removes the published layout; re-enabling performs a fresh initial scan', async () => {
    const h = harness();
    await ready(h);
    move(h, 15, 15);
    expect(h.hits.at(-1)).not.toBeNull();
    h.ctrl.setEnabled(false);
    await flush();
    expect(h.layouts.at(-1)).toBeNull();
    expect(h.ctrl.getPublished()).toBeNull();
    expect(h.hits.at(-1)).toBeNull();
    // pointer movement while disabled cannot reactivate anything
    move(h, 16, 15);
    expect(h.hits.at(-1)).toBeNull();
    const before = h.ocrCalls;
    h.ctrl.setEnabled(true);
    await flush();
    await h.sched.advance(600);
    expect(h.ocrCalls).toBe(before + 1);
  });

  it('after an unchanged image, movement captures back off (MeikiPop 0.1 s) instead of every event', async () => {
    const h = harness();
    await ready(h);
    await h.sched.advance(600);
    const c0 = h.captures;
    for (let i = 0; i < 20; i++) {
      move(h, 10 + i, 15);
      await h.sched.advance(10); // 20 moves in 200 ms
    }
    // ≤ 1 capture per UNCHANGED_BACKOFF_MS window (plus the trailing one)
    expect(h.captures - c0).toBeLessThanOrEqual(Math.ceil(200 / UNCHANGED_BACKOFF_MS) + 1);
    expect(h.ocrCalls).toBe(1);
  });

  it('a source framebuffer size change invalidates the layout; a pure CSS resize does not', async () => {
    const h = harness();
    await ready(h);
    expect(h.ctrl.getPublished()).not.toBeNull();
    h.ctrl.geometryChanged(480, 272); // same source size: CSS-only change
    expect(h.ctrl.getPublished()).not.toBeNull();
    h.ctrl.geometryChanged(960, 544); // source changed
    expect(h.ctrl.getPublished()).toBeNull();
    expect(h.layouts.at(-1)).toBeNull();
    await h.sched.advance(600);
    expect(h.ocrCalls).toBe(2); // fresh initial scan
  });

  it('stale check does not capture while no spatial text can be visible (hold-key mode, key up)', async () => {
    const h = harness({ lookupsWithoutHotkey: false });
    await ready(h);
    await h.sched.advance(600);
    const c0 = h.captures;
    await h.sched.advance(3000);
    expect(h.captures).toBe(c0);
  });

  it("stale policy 'mark' keeps text readable but flags it; the next movement re-infers", async () => {
    const h = harness({ stalePolicy: 'mark' });
    await ready(h);
    h.setPixels(2); // animated background changes under the visible text
    await h.sched.advance(600); // stale check fires
    const last = h.layouts.at(-1);
    expect(last).not.toBeNull();
    expect(last!.stale).toBe(true);
    expect(h.ctrl.getDiagnostics().staleDetected).toBe(1);
    move(h, 30, 15);
    await h.sched.advance(600);
    expect(h.ocrCalls).toBe(2); // not skipped as unchanged
    expect(h.layouts.at(-1)!.stale).toBeUndefined();
  });

  it("stale policy 'rescan' (default) re-infers after the image changes, with no pointer movement", async () => {
    const h = harness({ stalePolicy: 'rescan' });
    await ready(h);
    expect(h.ocrCalls).toBe(1);
    h.setPixels(2); // dialogue advanced / menu opened: the screen changed on its own
    await h.sched.advance(600); // 1st stale check: changed → flagged, waits for the picture to settle
    const flagged = h.layouts.find((l) => l?.stale === true);
    expect(flagged).toBeTruthy();
    expect(h.ocrCalls).toBe(1);
    await h.sched.advance(600); // 2nd check: same pixels as the 1st → settled → re-scan
    await h.sched.advance(1200);
    expect(h.ocrCalls).toBe(2);
    expect(h.ctrl.getDiagnostics().staleRescans).toBe(1);
    expect(h.layouts.at(-1)).not.toBeNull();
    expect(h.layouts.at(-1)!.stale).toBeUndefined();
    // unchanged afterwards: the stale check keeps running but infers nothing more
    await h.sched.advance(3000);
    expect(h.ocrCalls).toBe(2);
  });

  it("rescan waits for a typewriter effect to finish: changing pixels every check → no inference until they hold still", async () => {
    const h = harness({ stalePolicy: 'rescan' });
    await ready(h);
    for (let i = 0; i < 8; i++) { h.setPixels(10 + i); await h.sched.advance(500); } // text typing out: a new glyph before every check
    expect(h.ocrCalls).toBe(1);
    expect(h.ctrl.getDiagnostics().staleSettling).toBeGreaterThanOrEqual(6);
    await h.sched.advance(1000); // pixels held still across two checks → settled
    await h.sched.advance(1200);
    expect(h.ocrCalls).toBe(2);
    expect(h.ctrl.getDiagnostics().staleRescans).toBe(1);
  });

  it('emulator UI open (pause menu) hides the layout and blocks scans; closing it re-infers once', async () => {
    const h = harness({ stalePolicy: 'rescan' });
    await ready(h);
    h.ctrl.setEmulatorUiOpen(true);
    expect(h.layouts.at(-1)).toBeNull();
    h.setPixels(5); // the dimmed game + menu
    move(h, 20, 20);
    await h.sched.advance(2000);
    expect(h.ocrCalls).toBe(1); // nothing scanned while the menu is open
    h.setPixels(1);
    h.ctrl.setEmulatorUiOpen(false);
    await h.sched.advance(1200);
    expect(h.ocrCalls).toBe(2);
    expect(h.layouts.at(-1)).not.toBeNull();
  });

  it("stale policy 'remove' retires the targets; 'off' never captures for freshness", async () => {
    const hr = harness({ stalePolicy: 'remove' });
    await ready(hr);
    hr.setPixels(2);
    await hr.sched.advance(600);
    expect(hr.layouts.at(-1)).toBeNull();

    const ho = harness({ stalePolicy: 'off' });
    await ready(ho);
    const c0 = ho.captures;
    ho.setPixels(2);
    await ho.sched.advance(3000);
    expect(ho.captures).toBe(c0);
    expect(ho.layouts.at(-1)).not.toBeNull();
  });

  it('switching auto → manual drops the pending auto intent; the next Shift press captures exactly once', async () => {
    const h = harness();
    await ready(h);
    move(h, 20, 15); // movement intent inside the throttle window (trailing scan armed)
    expect(h.ctrl.getDiagnostics().pendingIntent).toBe('movement');
    h.ctrl.setSettings({ ...DEFAULT_OCR_SETTINGS, enabled: true, autoScan: false });
    await h.sched.advance(2000);
    expect(h.ocrCalls).toBe(1); // the auto-mode trailing scan did not fire
    h.setPixels(2);
    h.ctrl.hotkeyDownEdge();
    await flush();
    expect(h.ocrCalls).toBe(2);
    h.ctrl.hotkeyDownEdge(); // repeat
    await h.sched.advance(100);
    expect(h.ocrCalls).toBe(2);
  });

  it('probeChanged: a blinking cursor (few pixels) is not a change; a new text line is', () => {
    const w = 160, h = 90;
    const a = { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(20) };
    const b = { width: w, height: h, rgba: a.rgba.slice() };
    // 40 pixels (0.28 %) flip white: blinking "▼" cursor
    for (let i = 0; i < 40; i++) { const o = (i * 4) + (h - 5) * w * 4; b.rgba[o] = b.rgba[o + 1] = b.rgba[o + 2] = 255; }
    expect(probeChanged(a, b)).toBe(false);
    // a text line: 6 rows × 120 px = 5 %
    for (let y = 40; y < 46; y++) for (let x = 20; x < 140; x++) { const o = (y * w + x) * 4; b.rgba[o] = b.rgba[o + 1] = b.rgba[o + 2] = 255; }
    expect(probeChanged(a, b)).toBe(true);
    expect(probeChanged(a, { width: 80, height: 45, rgba: new Uint8Array(80 * 45 * 4) })).toBe(true);
  });
});

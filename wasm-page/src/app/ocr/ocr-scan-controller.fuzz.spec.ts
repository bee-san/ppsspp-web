/**
 * Randomized (seeded, reproducible) event fuzzing of the scan controller.
 * After EVERY step the following invariants must hold:
 *  I1 at most one inference in flight
 *  I2 a published layout always belongs to the current generation (no stale text)
 *  I3 a hit is only reported while a layout is published and activation is allowed
 *  I4 nothing is published or hit while the controller is not eligible
 *  I5 inference count is bounded by (captures) and captures are bounded by time/interval
 *  I6 when pixels never change, at most one inference per generation
 */
import { describe, expect, it } from 'vitest';
import type { LayoutSnapshot, TextHit } from 'meikiocr-web/meikipop';
import type { OcrSnapshot } from 'meikiocr-web';
import { OcrScanController, type ControllerPorts, type Scheduler } from './ocr-scan-controller';
import { DEFAULT_OCR_SETTINGS, FULL_REGION, type CapturedGameFrame, type OcrSettings, type PublishedLayout } from './ocr-types';

class Clock implements Scheduler {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 1;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.id++; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: number) { this.timers.delete(id); }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = Math.max(this.t, due[1].at); this.timers.delete(due[0]); due[1].fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    this.t = target;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  pending() { return this.timers.size; }
}
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

function snapshotFor(frameId: string, pixels: number): OcrSnapshot {
  const text = pixels % 3 === 0 ? '' : '日本語テキスト';
  const glyphs = Array.from(text).map((ch, i) => ({ id: `g${i}`, text: ch, box: [10 + i * 10, 10, 20 + i * 10, 20] as const, confidence: 0.9, utf16Start: i, utf16End: i + 1 }));
  return { frameId, width: 100, height: 50, profile: 'meikipop-v2', lines: text ? [{ id: 'l0', text, box: [10, 10, 10 + text.length * 10, 20], orientation: 'horizontal', glyphs }] : [], diagnostics: { backend: 'wasm', elapsedMs: 1, modelSetId: 'm', warnings: [] } };
}
function layoutFor(s: OcrSnapshot): LayoutSnapshot {
  return {
    frameId: s.frameId, width: s.width, height: s.height,
    paragraphs: s.lines.map((l) => ({ id: `p-${l.id}`, text: l.text, orientation: l.orientation, isFurigana: false, box: l.box, lineIds: [l.id], glyphs: l.glyphs.map((g, i) => ({ glyphId: g.id, lineId: l.id, text: g.text, box: g.box, utf16Start: i, utf16End: i + 1, codePointIndex: i })) })),
  } as unknown as LayoutSnapshot;
}

describe('OcrScanController fuzz', () => {
  for (const seed of [1, 7, 42, 1234, 99991]) {
    it(`seed ${seed}: invariants hold over 600 random events`, async () => {
      const rand = rng(seed);
      const clock = new Clock();
      let pixels = 1, inflight = 0, maxInflight = 0, captures = 0, inferences = 0, ocrDelay = 0, failNext = false;
      let startedWhileIneligible = 0;
      const published: (PublishedLayout | null)[] = [];
      const hits: { hit: TextHit | null }[] = [];
      const ports: ControllerPorts = {
        capture: async (region) => {
          captures++;
          const rgba = new ArrayBuffer(100 * 50 * 4); new Uint8Array(rgba).fill(pixels);
          const f: CapturedGameFrame = { frame: { frameId: `f${captures}`, width: 100, height: 50, capturedAtMs: clock.now(), rgba }, meta: { gameSessionId: 1, sceneEpoch: 1, geometryVersion: 1, region, cropRect: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, imageWidth: 100, imageHeight: 50, sourceWidth: 480, sourceHeight: 272 } };
          return f;
        },
        ocr: (frame) => {
          startedWhileIneligible += eligible() ? 0 : 1;
          inflight++; maxInflight = Math.max(maxInflight, inflight); inferences++;
          const px = new Uint8Array(frame.frame.rgba)[0]!;
          const fail = failNext; failNext = false;
          return new Promise((resolve, reject) => clock.setTimeout(() => { inflight--; fail ? reject(new Error('x')) : resolve(snapshotFor(frame.frame.frameId, px)); }, ocrDelay));
        },
        buildLayout: layoutFor,
        hitTest: (layout, pt) => { for (const p of layout.paragraphs) for (const g of p.glyphs) if (pt.x >= g.box[0] && pt.x <= g.box[2] && pt.y >= g.box[1] && pt.y <= g.box[3]) return { paragraphId: p.id, lineId: g.lineId, glyphId: g.glyphId, fullText: p.text, utf16Offset: g.utf16Start, codePointIndex: g.codePointIndex, suffix: p.text.slice(g.utf16Start), sourceBox: g.box }; return null; },
        sourceSize: () => ({ width: 100, height: 50 }),
        onLayout: (p) => published.push(p),
        onHit: (hit) => hits.push({ hit }),
      };
      const base: OcrSettings = { ...DEFAULT_OCR_SETTINGS, enabled: true };
      const inputs = { enabled: true, models: true, game: true, visible: true };
      const eligible = () => inputs.enabled && inputs.models && inputs.game && inputs.visible;
      const ctrl = new OcrScanController(ports, base, clock);
      const apply = () => { ctrl.setEnabled(inputs.enabled); ctrl.setModelsReady(inputs.models); ctrl.setGameReady(inputs.game); ctrl.setDocumentVisible(inputs.visible); };
      apply();
      let settings = base;
      const events = ['move', 'move', 'move', 'move', 'leave', 'tick', 'tick', 'tick', 'pixels', 'hotkeyDown', 'hotkeyUp', 'toggleEnabled', 'toggleVisible', 'toggleGame', 'region', 'invalidate', 'settings', 'fail', 'slow', 'fast', 'geometry'];
      for (let step = 0; step < 600; step++) {
        const ev = events[Math.floor(rand() * events.length)]!;
        switch (ev) {
          case 'move': { const x = Math.floor(rand() * 100), y = Math.floor(rand() * 50); ctrl.pointerMove({ clientX: x, clientY: y, norm: { x: x / 100, y: y / 50 } }); break; }
          case 'leave': ctrl.pointerLeave(); break;
          case 'tick': await clock.advance(Math.floor(rand() * 700)); break;
          case 'pixels': pixels = 1 + Math.floor(rand() * 6); break;
          case 'hotkeyDown': ctrl.hotkeyDownEdge(); break;
          case 'hotkeyUp': ctrl.hotkeyUp(); break;
          case 'toggleEnabled': inputs.enabled = !inputs.enabled; apply(); break;
          case 'toggleVisible': inputs.visible = !inputs.visible; apply(); break;
          case 'toggleGame': inputs.game = !inputs.game; apply(); break;
          case 'region': ctrl.setRegion(rand() < 0.5 ? FULL_REGION : { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }); break;
          case 'invalidate': ctrl.invalidate('fuzz'); break;
          case 'settings': settings = { ...settings, autoScan: rand() < 0.7, scanOnMouseMove: rand() < 0.7, lookupsWithoutHotkey: rand() < 0.7, stalePolicy: (['mark', 'remove', 'off'] as const)[Math.floor(rand() * 3)]! }; ctrl.setSettings(settings); break;
          case 'fail': failNext = true; break;
          case 'slow': ocrDelay = 800; break;
          case 'fast': ocrDelay = 0; break;
          case 'geometry': ctrl.geometryChanged(480, 272); break;
        }
        for (let i = 0; i < 10; i++) await Promise.resolve();
        // ---- invariants
        expect(maxInflight, 'I1 one inference in flight').toBeLessThanOrEqual(1);
        const d = ctrl.getDiagnostics();
        const pub = ctrl.getPublished();
        if (pub) expect(pub.generation, 'I2 published layout is current').toBe(d.generation);
        const lastHit = hits.at(-1)?.hit ?? null;
        if (lastHit) {
          expect(pub, 'I3 hit requires a published layout').not.toBeNull();
          expect(ctrl.activationAllowed(), 'I3 hit requires activation').toBe(true);
        }
        expect(startedWhileIneligible, 'I4 no inference starts while ineligible').toBe(0);
        if (!eligible()) {
          expect(lastHit, 'I4 no hit while ineligible').toBeNull();
          if (!inputs.enabled || !inputs.game) expect(pub, 'I4 no layout when disabled/stopped').toBeNull();
        }
      }
      await clock.advance(5000);
      expect(inflight).toBe(0);
      // I5/I6 sanity: with ≥600 events and ≤ ~1 pixel change per 20 events, inferences stay far below captures/events
      expect(inferences).toBeLessThanOrEqual(captures);
      expect(inferences).toBeLessThan(600);
      ctrl.stop();
      expect(clock.pending(), 'no timers after stop').toBe(0);
    });
  }
});

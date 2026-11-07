import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { boxSelect, hitTest, sketchBounds } from './hit';
import { Viewport } from './viewport';

function scene() {
  const b = new SketchBuilder();
  const a = b.point(0, 0);
  const c = b.point(100, 0);
  const line = b.line(a, c);
  const center = b.point(50, 50);
  const circle = b.circle(center, 20);
  // Quarter arc from (80, 50) clockwise on screen to (50, 80).
  const ac = b.point(50, 50);
  const as = b.point(80, 50);
  const ae = b.point(50, 80);
  const arc = b.arc(ac, as, ae);
  return { sketch: b.build(), a, c, line, center, circle, arc };
}

describe('hitTest', () => {
  it('prefers points over curves within tolerance', () => {
    const s = scene();
    expect(hitTest(s.sketch, { x: 1, y: 1 }, { tolerance: 3 })).toBe(s.a);
    expect(hitTest(s.sketch, { x: 50, y: 2 }, { tolerance: 3 })).toBe(s.line);
    expect(hitTest(s.sketch, { x: 50, y: 10 }, { tolerance: 3 })).toBeUndefined();
  });

  it('hits circles on their circumference only', () => {
    const s = scene();
    expect(hitTest(s.sketch, { x: 50, y: 31 }, { tolerance: 2 })).toBe(s.circle);
  });

  it('hits arcs only within their sweep', () => {
    const s = scene();
    const r = 30 / Math.SQRT2;
    expect(hitTest(s.sketch, { x: 50 + r, y: 50 + r }, { tolerance: 1 })).toBe(s.arc);
    expect(hitTest(s.sketch, { x: 50 - r, y: 50 - r }, { tolerance: 1 })).toBeUndefined();
  });
});

describe('boxSelect', () => {
  it('window selection needs the whole entity inside', () => {
    const s = scene();
    const box = { minX: -5, minY: -5, maxX: 60, maxY: 5 };
    expect(boxSelect(s.sketch, box, 'window')).toEqual([s.a]);
  });

  it('crossing selection takes anything touching the box', () => {
    const s = scene();
    const box = { minX: 40, minY: -5, maxX: 60, maxY: 5 };
    expect(boxSelect(s.sketch, box, 'crossing')).toEqual([s.line]);
  });
});

describe('sketchBounds and Viewport', () => {
  it('fits the sketch and maps world to screen and back', () => {
    const s = scene();
    const bounds = sketchBounds(s.sketch)!;
    expect(bounds.minX).toBeCloseTo(0);
    expect(bounds.maxY).toBeCloseTo(80);

    const vp = new Viewport();
    vp.resize(400, 300);
    vp.fit(bounds, 0);
    const center = vp.toScreen({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    });
    expect(center.x).toBeCloseTo(200);
    expect(center.y).toBeCloseTo(150);
    const p = { x: 12, y: 34 };
    const back = vp.toWorld(vp.toScreen(p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('zooms about the anchor point', () => {
    const vp = new Viewport();
    vp.resize(400, 300);
    const anchor = { x: 120, y: 80 };
    const before = vp.toWorld(anchor);
    vp.zoomAt(anchor, 3);
    const after = vp.toWorld(anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('keeps grid spacing on a 1-2-5 progression above the minimum pixel gap', () => {
    const vp = new Viewport();
    for (const scale of [0.013, 0.4, 1, 3.7, 50]) {
      vp.scale = scale;
      const { minor, major } = vp.gridSteps();
      expect(minor * scale).toBeGreaterThanOrEqual(12);
      const mantissa = minor / 10 ** Math.floor(Math.log10(minor) + 1e-9);
      expect([1, 2, 5]).toContainEqual(Math.round(mantissa));
      expect(major / minor === 5 || major / minor === 2).toBe(true);
    }
  });
});

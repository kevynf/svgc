import { describe, expect, it } from 'vitest';
import {
  artboardFromBounds,
  handlePositions,
  normalizeArtboard,
  presetArtboard,
  PRESETS,
  resizeArtboard,
  sameArtboard,
  snapArtboard,
} from './artboard';
import type { Artboard } from './sketch';

const box = (x: number, y: number, width: number, height: number): Artboard => ({
  x,
  y,
  width,
  height,
});

describe('normalizeArtboard', () => {
  it('keeps a top-left origin with positive size', () => {
    expect(normalizeArtboard(box(10, 20, 100, 50))).toEqual(box(10, 20, 100, 50));
  });

  it('rewrites negative width/height into a top-left origin', () => {
    expect(normalizeArtboard(box(100, 100, -50, -30))).toEqual(box(50, 70, 50, 30));
    expect(normalizeArtboard(box(100, 100, -50, 30))).toEqual(box(50, 100, 50, 30));
  });
});

describe('artboardFromBounds', () => {
  it('adds a margin and rounds outward to whole px', () => {
    expect(artboardFromBounds({ minX: 10.2, minY: 20.7, maxX: 90.3, maxY: 70.1 }, 5)).toEqual(
      box(5, 15, 91, 61),
    );
  });

  it('touches the bounds exactly with no margin', () => {
    expect(artboardFromBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 0)).toEqual(
      box(0, 0, 100, 50),
    );
  });

  it('never collapses below 1 px', () => {
    expect(artboardFromBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 0)).toEqual(box(5, 5, 1, 1));
  });
});

describe('snapArtboard', () => {
  it('rounds origin and size to whole px, keeping 1 px', () => {
    expect(snapArtboard(box(1.4, 2.6, 10.5, 0.3))).toEqual(box(1, 3, 11, 1));
    expect(snapArtboard(box(-1.6, -0.4, 3, 3))).toEqual(box(-2, 0, 3, 3));
  });
});

describe('handlePositions', () => {
  it('places grips at the corners and edge midpoints', () => {
    expect(handlePositions(box(0, 0, 100, 100))).toEqual({
      nw: { x: 0, y: 0 },
      n: { x: 50, y: 0 },
      ne: { x: 100, y: 0 },
      w: { x: 0, y: 50 },
      e: { x: 100, y: 50 },
      sw: { x: 0, y: 100 },
      s: { x: 50, y: 100 },
      se: { x: 100, y: 100 },
    });
  });
});

describe('resizeArtboard', () => {
  const base = box(10, 10, 100, 80);

  it('moves the gripped edge and keeps the opposite one', () => {
    expect(resizeArtboard(base, 'e', { x: 200, y: 50 })).toEqual(box(10, 10, 190, 80));
    expect(resizeArtboard(base, 'w', { x: 0, y: 50 })).toEqual(box(0, 10, 110, 80));
    expect(resizeArtboard(base, 'n', { x: 60, y: 0 })).toEqual(box(10, 0, 100, 90));
    expect(resizeArtboard(base, 's', { x: 60, y: 200 })).toEqual(box(10, 10, 100, 190));
  });

  it('moves both edges of a corner grip', () => {
    expect(resizeArtboard(base, 'se', { x: 200, y: 200 })).toEqual(box(10, 10, 190, 190));
    expect(resizeArtboard(base, 'nw', { x: 0, y: 0 })).toEqual(box(0, 0, 110, 90));
    expect(resizeArtboard(base, 'ne', { x: 200, y: 0 })).toEqual(box(10, 0, 190, 90));
    expect(resizeArtboard(base, 'sw', { x: 0, y: 200 })).toEqual(box(0, 10, 110, 190));
  });

  it('does not snap fractional results', () => {
    expect(resizeArtboard(box(0, 0, 100, 100), 'e', { x: 150.5, y: 50 })).toEqual(
      box(0, 0, 150.5, 100),
    );
  });

  it('keeps the aspect ratio from a corner grip (dominant axis drives)', () => {
    const square = box(0, 0, 100, 100);
    expect(resizeArtboard(square, 'se', { x: 200, y: 80 }, { keepAspect: true })).toEqual(
      box(0, 0, 200, 200),
    );
    expect(resizeArtboard(square, 'se', { x: 80, y: 200 }, { keepAspect: true })).toEqual(
      box(0, 0, 200, 200),
    );
    expect(
      resizeArtboard(box(0, 0, 100, 50), 'se', { x: 200, y: 80 }, { keepAspect: true }),
    ).toEqual(box(0, 0, 200, 100));
  });

  it('keeps the aspect ratio from an edge grip (dragged axis drives)', () => {
    const wide = box(0, 0, 100, 50);
    expect(resizeArtboard(wide, 'e', { x: 200, y: 25 }, { keepAspect: true })).toEqual(
      box(0, -25, 200, 100),
    );
    expect(resizeArtboard(wide, 'n', { x: 50, y: -50 }, { keepAspect: true })).toEqual(
      box(-50, -50, 200, 100),
    );
  });

  it('resizes about the centre with fromCenter', () => {
    expect(
      resizeArtboard(box(0, 0, 100, 100), 'se', { x: 150, y: 150 }, { fromCenter: true }),
    ).toEqual(box(-50, -50, 200, 200));
    expect(
      resizeArtboard(box(0, 0, 100, 100), 'e', { x: 150, y: 50 }, { fromCenter: true }),
    ).toEqual(box(-50, 0, 200, 100));
  });

  it('clamps to a 1 px minimum without inverting', () => {
    expect(resizeArtboard(box(0, 0, 100, 100), 'e', { x: 0.5, y: 50 })).toEqual(box(0, 0, 1, 100));
    expect(resizeArtboard(box(0, 0, 100, 100), 'e', { x: -50, y: 50 })).toEqual(box(0, 0, 1, 100));
    expect(
      resizeArtboard(box(0, 0, 100, 100), 'se', { x: 0.5, y: 0.5 }, { keepAspect: true }),
    ).toEqual(box(0, 0, 1, 1));
  });
});

describe('presetArtboard', () => {
  it('centres a preset on a point', () => {
    expect(presetArtboard({ id: 'x', width: 100, height: 50 }, { x: 200, y: 200 })).toEqual(
      box(150, 175, 100, 50),
    );
  });
});

describe('PRESETS', () => {
  it('offers the documented page sizes with unique ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const byId = new Map(PRESETS.map((p) => [p.id, p]));
    expect(byId.get('a4Portrait')).toEqual({ id: 'a4Portrait', width: 794, height: 1123 });
    expect(byId.get('a4Landscape')).toEqual({ id: 'a4Landscape', width: 1123, height: 794 });
    expect(byId.get('letter')).toEqual({ id: 'letter', width: 816, height: 1056 });
    expect(byId.get('fullHd')).toEqual({ id: 'fullHd', width: 1920, height: 1080 });
    expect(byId.get('square1080')).toEqual({ id: 'square1080', width: 1080, height: 1080 });
    expect(byId.get('icon512')).toEqual({ id: 'icon512', width: 512, height: 512 });
    expect(byId.get('icon24')).toEqual({ id: 'icon24', width: 24, height: 24 });
  });

  it('has positive whole-pixel sizes', () => {
    for (const preset of PRESETS) {
      expect(Number.isInteger(preset.width) && preset.width > 0).toBe(true);
      expect(Number.isInteger(preset.height) && preset.height > 0).toBe(true);
    }
  });
});

describe('sameArtboard', () => {
  it('compares by value and treats two absents as equal', () => {
    expect(sameArtboard(undefined, undefined)).toBe(true);
    expect(sameArtboard(box(0, 0, 1, 1), undefined)).toBe(false);
    expect(sameArtboard(undefined, box(0, 0, 1, 1))).toBe(false);
    expect(sameArtboard(box(0, 0, 1, 1), box(0, 0, 1, 1))).toBe(true);
    expect(sameArtboard(box(0, 0, 1, 1), box(0, 0, 1, 2))).toBe(false);
  });
});

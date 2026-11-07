import { describe, expect, it } from 'vitest';
import {
  closestOnSegment,
  degToRad,
  directionDeg,
  lineAngleDeg,
  lineIntersection,
  normalizeDeg,
  perpendicularDistance,
  segmentNormal,
  unit,
} from './geometry';

describe('perpendicularDistance', () => {
  it('measures to a horizontal line', () => {
    expect(perpendicularDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it('measures to a vertical line', () => {
    expect(perpendicularDistance({ x: -4, y: 7 }, { x: 0, y: 0 }, { x: 0, y: 10 })).toBe(4);
  });

  it('measures to a diagonal line', () => {
    // On the line y = x, the point (2, 0) sits √2 away.
    expect(perpendicularDistance({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(
      Math.SQRT2,
      12,
    );
  });

  it('ignores where along the line the foot falls', () => {
    expect(perpendicularDistance({ x: 50, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('is zero for a point on the line', () => {
    expect(perpendicularDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 6, y: 8 })).toBe(0);
  });

  it('falls back to the point distance for a degenerate line', () => {
    expect(perpendicularDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('unit', () => {
  it('scales a vector to length 1', () => {
    expect(unit({ x: 3, y: 4 })).toEqual({ x: 0.6, y: 0.8 });
  });

  it('has no direction for a zero vector', () => {
    expect(unit({ x: 0, y: 0 })).toBeUndefined();
  });
});

describe('lineIntersection', () => {
  it('finds where two segments cross', () => {
    expect(
      lineIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }),
    ).toEqual({ x: 5, y: 0 });
  });

  it('is undefined for parallel lines', () => {
    expect(
      lineIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }),
    ).toBeUndefined();
  });
});

describe('segmentNormal', () => {
  it('points above a left-to-right line and right of a top-to-bottom one', () => {
    const right = segmentNormal({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(right.x).toBeCloseTo(0, 12);
    expect(right.y).toBeCloseTo(-1, 12);
    const down = segmentNormal({ x: 0, y: 0 }, { x: 0, y: 10 });
    expect(down.x).toBeCloseTo(1, 12);
    expect(down.y).toBeCloseTo(0, 12);
  });

  it('falls back to up for a degenerate segment', () => {
    const up = segmentNormal({ x: 3, y: 3 }, { x: 3, y: 3 });
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(-1, 12);
  });
});

describe('closestOnSegment', () => {
  it('projects inside the segment', () => {
    expect(closestOnSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({
      x: 5,
      y: 0,
    });
  });

  it('clamps to the endpoints', () => {
    expect(closestOnSegment({ x: -5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(closestOnSegment({ x: 15, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({
      x: 10,
      y: 0,
    });
  });

  it('returns the point itself for a degenerate segment', () => {
    expect(closestOnSegment({ x: 5, y: 5 }, { x: 3, y: 3 }, { x: 3, y: 3 })).toEqual({
      x: 3,
      y: 3,
    });
  });
});

describe('normalizeDeg', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(30)).toBe(30);
    expect(normalizeDeg(359.5)).toBe(359.5);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(390)).toBe(30);
    expect(normalizeDeg(-30)).toBe(330);
    expect(normalizeDeg(-390)).toBe(330);
  });
});

describe('directionDeg', () => {
  it('reads the axis directions counterclockwise on screen', () => {
    expect(directionDeg({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(directionDeg({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(90);
    expect(directionDeg({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(-90);
    expect(directionDeg({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe(-180);
  });

  it('reads a diagonal toward the upper right as 45°', () => {
    expect(directionDeg({ x: 20, y: 20 }, { x: 30, y: 10 })).toBe(45);
  });
});

describe('lineAngleDeg', () => {
  it('measures counterclockwise on screen from the first line to the second', () => {
    // A horizontal base and an arm pointing up the screen: 90°.
    expect(lineAngleDeg({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: -10 })).toBe(
      90,
    );
  });

  it('measures a diagonal', () => {
    expect(lineAngleDeg({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 15, y: -5 })).toBe(
      45,
    );
  });

  it('wraps a clockwise turn past zero', () => {
    // An arm pointing down the screen is a 270° counterclockwise turn.
    expect(lineAngleDeg({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 })).toBe(
      270,
    );
  });

  it('always lands in [0, 360)', () => {
    const at = (deg: number) => ({
      x: 100 * Math.cos(degToRad(deg)),
      y: -100 * Math.sin(degToRad(deg)),
    });
    for (const a of [0, 37, 90, 179, 180, 268, 359]) {
      for (const b of [0, 53, 90, 181, 270, 300]) {
        const value = lineAngleDeg({ x: 0, y: 0 }, at(a), { x: 0, y: 0 }, at(b));
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(360);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { CONSTRAINT_GLYPHS, constraintGlyphSvg } from './constraint-icons';

/** Absolute positions visited by a path, tracking relative commands. Arcs and curves contribute their end points. */
function visitedPoints(d: string): [number, number][] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const points: [number, number][] = [];
  let x = 0;
  let y = 0;
  let cmd = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, a: 7, c: 6, s: 4, q: 4 };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    if (lower === 'z') continue;
    const args = Array.from({ length: arity[lower] ?? 0 }, num);
    if (lower === 'h') x = rel ? x + args[0]! : args[0]!;
    else if (lower === 'v') y = rel ? y + args[0]! : args[0]!;
    else {
      const dx = args[args.length - 2]!;
      const dy = args[args.length - 1]!;
      x = rel ? x + dx : dx;
      y = rel ? y + dy : dy;
    }
    points.push([x, y]);
  }
  return points;
}

function drawnPaths(svg: string): string[] {
  return [...svg.matchAll(/<path d="([^"]+)" \/>/g)].map((m) => m[1]!);
}

describe('constraint glyphs', () => {
  it('lists 19 unique glyphs', () => {
    expect(CONSTRAINT_GLYPHS).toHaveLength(19);
    expect(new Set(CONSTRAINT_GLYPHS).size).toBe(19);
  });

  it.each(CONSTRAINT_GLYPHS)('%s uses the Tabler outline format', (glyph) => {
    const svg = constraintGlyphSvg(glyph);
    for (const attr of [
      'viewBox="0 0 24 24"',
      'fill="none"',
      'stroke="currentColor"',
      'stroke-width="2"',
      'stroke-linecap="round"',
      'stroke-linejoin="round"',
    ]) {
      expect(svg).toContain(attr);
    }
    expect(svg).toContain('<path stroke="none" d="M0 0h24v24H0z" fill="none" />');
    expect(drawnPaths(svg).length).toBeGreaterThan(0);
  });

  it.each(CONSTRAINT_GLYPHS)('%s stays inside the 2px padding', (glyph) => {
    for (const d of drawnPaths(constraintGlyphSvg(glyph))) {
      for (const [x, y] of visitedPoints(d)) {
        expect(x).toBeGreaterThanOrEqual(2);
        expect(x).toBeLessThanOrEqual(22);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(y).toBeLessThanOrEqual(22);
      }
    }
  });
});

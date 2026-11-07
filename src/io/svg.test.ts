import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import type { Sketch } from '../core/sketch';
import { sketchToSvg } from './svg';

/** A horizontal line, a circle and a quarter arc, each with its sketch points. */
function geometrySketch(): Sketch {
  const b = new SketchBuilder();
  const a = b.point(10, 20);
  const c = b.point(60, 20);
  b.line(a, c);
  const center = b.point(30, 60);
  b.circle(center, 15);
  const arcCenter = b.point(100, 60);
  const arcStart = b.point(120, 60);
  const arcEnd = b.point(100, 80);
  b.arc(arcCenter, arcStart, arcEnd);
  return b.build();
}

const ROOT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 110 60" width="110" height="60" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">';

/** The document's opening tag, where the presentation attributes live. */
function rootOf(svg: string): string {
  return svg.slice(0, svg.indexOf('\n'));
}

describe('sketchToSvg', () => {
  it('writes one element per curve, in sketch order, and no sketch points', () => {
    expect(sketchToSvg(geometrySketch())).toBe(`${ROOT}
  <line x1="10" y1="20" x2="60" y2="20"/>
  <circle cx="30" cy="60" r="15"/>
  <path d="M 120 60 A 20 20 0 0 1 100 80"/>
</svg>
`);
  });

  it('omits construction curves and standalone points', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(40, 30);
    b.line(a, c, { construction: true });
    b.point(10, 10);
    const svg = sketchToSvg(b.build());
    expect(svg).not.toContain('<line');
    expect(svg).not.toContain('<circle');
    expect(svg).not.toContain('<path');
    expect(rootOf(svg)).toContain('viewBox="0 0 40 30"');
  });

  it('clips the geometry to the artboard when the sketch has one', () => {
    const sketch: Sketch = {
      ...geometrySketch(),
      artboard: { x: 5, y: 5, width: 200, height: 100 },
    };
    expect(sketchToSvg(sketch))
      .toBe(`${ROOT.replace('viewBox="10 20 110 60" width="110" height="60"', 'viewBox="5 5 200 100" width="200" height="100"')}
  <defs>
    <clipPath id="svgc-artboard">
      <rect x="5" y="5" width="200" height="100"/>
    </clipPath>
  </defs>
  <g clip-path="url(#svgc-artboard)">
    <line x1="10" y1="20" x2="60" y2="20"/>
    <circle cx="30" cy="60" r="15"/>
    <path d="M 120 60 A 20 20 0 0 1 100 80"/>
  </g>
</svg>
`);
  });

  it('falls back to the geometry bounds, with an arc sweep crossing included', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    // A quarter arc from -45° to +45° about the origin: its endpoints sit at
    // x ≈ 7.07, but the sweep bulges out to x = 10 where it crosses the +x
    // axis, and the bounds have to reach that far.
    const start = b.point(10 * Math.SQRT1_2, -10 * Math.SQRT1_2);
    const end = b.point(10 * Math.SQRT1_2, 10 * Math.SQRT1_2);
    b.arc(center, start, end);
    const viewBox =
      /viewBox="([^"]+)"/.exec(sketchToSvg(b.build()))?.[1]?.split(' ').map(Number) ?? [];
    expect(viewBox[0]).toBe(0); // the arc's centre point
    expect(viewBox[1]).toBeCloseTo(-10 * Math.SQRT1_2, 10);
    expect(viewBox[2]).toBeCloseTo(10, 10); // out to the crossing, past the endpoints
    expect(viewBox[3]).toBeCloseTo(20 * Math.SQRT1_2, 10);
  });

  it('falls back to a unit page for an empty sketch', () => {
    // A zero-sized viewBox is an error in SVG, so the fallback is one unit.
    expect(sketchToSvg({ entities: [], constraints: [], params: {} }))
      .toBe(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
</svg>
`);
  });

  it('takes the stroke colour and width', () => {
    const root = rootOf(sketchToSvg(geometrySketch(), { stroke: '#333', strokeWidth: 0.5 }));
    expect(root).toContain('stroke="#333" stroke-width="0.5"');
  });

  it('lets extra attributes override the defaults, once each', () => {
    const root = rootOf(
      sketchToSvg(geometrySketch(), { attributes: { id: 'plate', stroke: 'red' } }),
    );
    expect(root).toContain('id="plate"');
    expect(root).toContain('stroke="red"');
    expect(root).not.toContain('#000');
    // A repeated attribute name is not well formed, so the override replaces
    // the default rather than sitting next to it.
    expect(root.match(/stroke=/g)).toHaveLength(1);
  });

  it('escapes attribute values so a quote cannot break out of them', () => {
    const svg = sketchToSvg(geometrySketch(), { stroke: 'a"b<c&d' });
    expect(rootOf(svg)).toContain('stroke="a&quot;b&lt;c&amp;d"');
    // Every attribute in the document is well formed, so stripping them all
    // leaves no stray quote: the injected one cannot close the attribute.
    expect(svg.replace(/[\w-]+="[^"]*"/g, '')).not.toContain('"');
  });

  it('sweeps an arc clockwise on screen, flagging a sweep over half a turn', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(10, 0);
    const end = b.point(0, -10);
    b.arc(center, start, end);
    // Clockwise on screen from the +x axis by 270° ends straight up: the sweep
    // flag is 1 for that direction in the Y-down coordinate system, and the
    // sweep is over half a turn, so the large-arc flag is 1 as well.
    expect(sketchToSvg(b.build())).toContain('<path d="M 10 0 A 10 10 0 1 1 0 -10"/>');
  });

  it('writes the same document every time', () => {
    expect(sketchToSvg(geometrySketch())).toBe(sketchToSvg(geometrySketch()));
  });
});

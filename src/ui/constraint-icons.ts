// Constraint glyphs drawn for this project in the Tabler Icons outline style:
// 24×24 grid, 2px padding, 2px round strokes, currentColor, no fills. Points are
// r=2 rings with the curve broken around them, as in Tabler's `line` icon.

export const CONSTRAINT_GLYPHS = [
  'coincident',
  'fix',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'equal',
  'tangent',
  'pointOnLine',
  'pointOnCurve',
  'midpoint',
  'collinear',
  'concentric',
  'symmetric',
  'smooth',
  'distance',
  'radius',
  'diameter',
  'angle',
] as const;

export type ConstraintGlyph = (typeof CONSTRAINT_GLYPHS)[number];

/** A point marker: ring of radius 2 centered at (x, y). */
const ring = (x: number, y: number) => `M${x - 2} ${y}a2 2 0 1 0 4 0a2 2 0 1 0 -4 0`;

/**
 * Every glyph's ink is centered on the 24 grid (verified with getBBox in
 * /measure.html), so icons line up when a column of them is rendered.
 */
const paths: Record<ConstraintGlyph, readonly string[]> = {
  // Two segments ending in one shared point.
  coincident: ['M4 17l6.5 -6.5', 'M20 17l-6.5 -6.5', ring(12, 9)],
  // A point pinned to ground.
  fix: [ring(12, 6), 'M12 8v7', 'M4 15h16', 'M9 15l-3 5', 'M17 15l-3 5'],
  horizontal: [ring(5, 12), ring(19, 12), 'M7 12h10'],
  vertical: [ring(12, 5), ring(12, 19), 'M12 7v10'],
  parallel: ['M5 20l7 -16', 'M12 20l7 -16'],
  // ⊥ with a right-angle mark.
  perpendicular: ['M4 20h16', 'M12 20v-16', 'M12 16h4v4'],
  // Two segments of the same length, end bars aligned.
  equal: ['M5 8h14', 'M5 16h14', 'M5 6v4', 'M19 6v4', 'M5 14v4', 'M19 14v4'],
  // A line resting on a circle.
  tangent: ['M3 6h18', 'M6 12a6 6 0 1 0 12 0a6 6 0 1 0 -12 0'],
  pointOnLine: ['M4 20l6.5 -6.5', 'M13.5 10.5l6.5 -6.5', ring(12, 12)],
  // A circle broken around a point on its top.
  pointOnCurve: ['M13.98 5.25a8 8 0 1 1 -3.96 0', ring(12, 5)],
  // Segment with end ticks and a point in the middle.
  midpoint: ['M4 9v6', 'M20 9v6', 'M4 12h6', 'M14 12h6', ring(12, 12)],
  // Two segments on one dotted line.
  collinear: ['M3 21l6 -6', 'M15 9l6 -6', 'M11 13v.01', 'M13 11v.01'],
  concentric: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M12 12v.01'],
  // Two points mirrored about a dashed axis.
  symmetric: ['M12 3v3', 'M12 10.5v3', 'M12 18v3', ring(6, 12), ring(18, 12)],
  // Two curves meeting at a point with matching curvature.
  smooth: ['M3 18c4 0 4 -6 7 -6', 'M14 12c3 0 3 -6 7 -6', ring(12, 12)],
  distance: ['M4 4v16', 'M20 4v16', 'M4 12h16', 'M7 9l-3 3l3 3', 'M17 9l3 3l-3 3'],
  radius: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 12l6 -6', 'M14.5 6h3.5v3.5', 'M12 12v.01'],
  // The ⌀ sign: a circle struck through.
  diameter: ['M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M4 20l16 -16'],
  angle: ['M4 17.5h16', 'M4 17.5l11 -11', 'M12 17.5a8 8 0 0 0 -2.34 -5.66'],
};

/** Raw SVG markup in Tabler's outline format. */
export function constraintGlyphSvg(glyph: ConstraintGlyph): string {
  const body = paths[glyph].map((d) => `  <path d="${d}" />`).join('\n');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '  <path stroke="none" d="M0 0h24v24H0z" fill="none" />',
    body,
    '</svg>',
  ].join('\n');
}

/** A fresh, decorative SVG element for the glyph; same behavior as `icon()` in icons.ts. */
export function constraintIcon(glyph: ConstraintGlyph, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs: Record<string, string> = {
    class: 'icon',
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  for (const d of paths[glyph]) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

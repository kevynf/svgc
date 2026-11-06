import { SketchBuilder } from './core/builder';
import type { Sketch } from './core/sketch';

/**
 * A rounded rectangle with a centered hole. Width, height and corner radius
 * are free; the hole stays concentric and tied to the corner radius.
 */
export function demoSketch(): Sketch {
  const b = new SketchBuilder().param('corner', 30);

  const origin = b.point(120, 100);
  b.fix(origin);

  // Corner centers, clockwise from top-left.
  const c1 = b.point(150, 130);
  const c2 = b.point(450, 130);
  const c3 = b.point(450, 330);
  const c4 = b.point(150, 330);

  // Tangent points, clockwise.
  const t = [
    b.point(150, 100), b.point(450, 100),
    b.point(480, 130), b.point(480, 330),
    b.point(450, 360), b.point(150, 360),
    b.point(120, 330), b.point(120, 130),
  ] as const;

  const top = b.line(t[0], t[1]);
  const right = b.line(t[2], t[3]);
  const bottom = b.line(t[4], t[5]);
  const left = b.line(t[6], t[7]);
  const a1 = b.arc(c1, t[7], t[0]);
  const a2 = b.arc(c2, t[1], t[2]);
  const a3 = b.arc(c3, t[3], t[4]);
  const a4 = b.arc(c4, t[5], t[6]);

  b.constrain({ kind: 'horizontal', a: top });
  b.constrain({ kind: 'horizontal', a: bottom });
  b.constrain({ kind: 'vertical', a: left });
  b.constrain({ kind: 'vertical', a: right });
  for (const [line, arc] of [[top, a1], [top, a2], [right, a2], [right, a3], [bottom, a3], [bottom, a4], [left, a4], [left, a1]] as const) {
    b.constrain({ kind: 'tangent', a: line, b: arc });
  }
  b.constrain({ kind: 'radius', curve: a1, value: 'corner' });
  for (const arc of [a2, a3, a4]) {
    b.constrain({ kind: 'equal', a: a1, b: arc });
  }
  // Anchor the shape's top-left corner of the bounding box at the origin.
  b.constrain({ kind: 'horizontal', a: origin, b: t[0] });
  b.constrain({ kind: 'vertical', a: origin, b: t[7] });

  // Construction diagonal locates the center of the shape.
  const diagonal = b.line(c1, c3, { construction: true });
  const center = b.point(300, 230);
  b.constrain({ kind: 'midpoint', point: center, line: diagonal });

  const hole = b.circle(center, 40);
  b.constrain({ kind: 'equal', a: hole, b: a1 });

  return b.build();
}

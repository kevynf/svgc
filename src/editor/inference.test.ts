import { describe, expect, it } from 'vitest';
import { degToRad } from '../core/geometry';
import { SketchBuilder } from '../core/builder';
import { infer, materialize } from './inference';

/** A line, a circle and a quarter arc, plus the points they are built from. */
function curveScene() {
  const b = new SketchBuilder();
  const a = b.point(0, 0);
  const c = b.point(100, 0);
  const line = b.line(a, c);
  const center = b.point(200, 0);
  const circle = b.circle(center, 40);
  const arcCenter = b.point(300, 0);
  const arcStart = b.point(340, 0);
  const arcEnd = b.point(300, 40);
  const arc = b.arc(arcCenter, arcStart, arcEnd);
  return { sketch: b.build(), a, c, line, center, circle, arc };
}

/** Loose points only, for direction and alignment behavior. */
function anchorScene() {
  const b = new SketchBuilder();
  const free = b.point(0, 250);
  const p = b.point(150, 80);
  const q = b.point(400, 251);
  const r = b.point(1, 400);
  const s = b.point(149, 246);
  const t = b.point(1, 290);
  return { sketch: b.build(), free, p, q, r, s, t };
}

/** Quarter arc centered at the origin from (50, 0) clockwise on screen to (0, 50). */
function arcScene() {
  const b = new SketchBuilder();
  const center = b.point(0, 0);
  const start = b.point(50, 0);
  const end = b.point(0, 50);
  const arc = b.arc(center, start, end);
  return { sketch: b.build(), center, start, end, arc };
}

function referenceScene() {
  const b = new SketchBuilder();
  const a = b.point(0, 0);
  const d = b.point(100, 50);
  const reference = b.line(a, d);
  const anchor = b.point(200, 200);
  return { sketch: b.build(), reference, anchor };
}

function materializeScene() {
  const b = new SketchBuilder();
  const a = b.point(0, 0);
  const c = b.point(100, 0);
  const line = b.line(a, c);
  const d = b.point(100, 50);
  const ref = b.line(a, d);
  const center = b.point(200, 0);
  const circle = b.circle(center, 40);
  const arcCenter = b.point(300, 0);
  const arcStart = b.point(340, 0);
  const arcEnd = b.point(300, 40);
  const arc = b.arc(arcCenter, arcStart, arcEnd);
  return { sketch: b.build(), line, ref, circle, arc };
}

describe('infer', () => {
  it('returns the raw cursor when inference is disabled', () => {
    const s = curveScene();
    const cursor = { x: 100, y: 1 };
    const r = infer(s.sketch, cursor, { tolerance: 5, enabled: false });
    expect(r.position).toEqual(cursor);
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([]);
  });

  it('reuses a nearby point instead of inferring anything else', () => {
    const s = curveScene();
    const r = infer(
      s.sketch,
      { x: 100, y: 1.5 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 0 }, id: s.a },
      },
    );
    expect(r.position).toEqual({ x: 100, y: 0 });
    expect(r.constraints).toEqual([{ kind: 'coincident', target: s.c }]);
    expect(r.alignments).toEqual([]);
  });

  it('projects the cursor onto a line', () => {
    const s = curveScene();
    const r = infer(s.sketch, { x: 50, y: 3 }, { tolerance: 5, enabled: true });
    expect(r.constraints).toEqual([{ kind: 'pointOnCurve', target: s.line }]);
    expect(r.position).toEqual({ x: 50, y: 0 });
  });

  it('projects the cursor radially onto a circle', () => {
    const s = curveScene();
    const r = infer(s.sketch, { x: 244, y: 0 }, { tolerance: 5, enabled: true });
    expect(r.constraints).toEqual([{ kind: 'pointOnCurve', target: s.circle }]);
    expect(r.position).toEqual({ x: 240, y: 0 });
  });

  it('projects the cursor onto an arc inside its sweep', () => {
    const s = curveScene();
    const r = infer(
      s.sketch,
      { x: 300 + 44 * Math.cos(degToRad(30)), y: 44 * Math.sin(degToRad(30)) },
      {
        tolerance: 5,
        enabled: true,
      },
    );
    expect(r.constraints).toEqual([{ kind: 'pointOnCurve', target: s.arc }]);
    expect(r.position.x).toBeCloseTo(300 + 40 * Math.cos(degToRad(30)), 6);
    expect(r.position.y).toBeCloseTo(40 * Math.sin(degToRad(30)), 6);
    expect(r.alignments).toEqual([]);
  });

  it('ignores a circle position outside the arc sweep', () => {
    const s = curveScene();
    const cursor = { x: 300 + 40 * Math.cos(degToRad(-30)), y: 40 * Math.sin(degToRad(-30)) };
    const r = infer(s.sketch, cursor, { tolerance: 5, enabled: true });
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([]);
    expect(r.position).toEqual(cursor);
  });

  it('snaps horizontal against the anchor and skips the y alignment', () => {
    const s = anchorScene();
    const r = infer(
      s.sketch,
      { x: 152, y: 252 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 250 }, id: s.free },
      },
    );
    expect(r.constraints).toEqual([{ kind: 'horizontal' }]);
    expect(r.alignments).toEqual([{ source: s.p, axis: 'x' }]);
    expect(r.position).toEqual({ x: 150, y: 250 });
  });

  it('snaps vertical against the anchor and skips the x alignment', () => {
    const s = anchorScene();
    const r = infer(
      s.sketch,
      { x: 3, y: 300 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 250 }, id: s.free },
      },
    );
    expect(r.constraints).toEqual([{ kind: 'vertical' }]);
    expect(r.alignments).toEqual([]);
    expect(r.position).toEqual({ x: 0, y: 300 });
  });

  it('does not infer H/V when the cursor is within tolerance of the anchor', () => {
    const b = new SketchBuilder();
    const start = b.point(0, 250);
    const sketch = b.build();
    const r = infer(
      sketch,
      { x: 2, y: 253 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 250 }, id: start },
        exclude: new Set([start]),
      },
    );
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([]);
    expect(r.position).toEqual({ x: 2, y: 253 });
  });

  it('respects a custom angle tolerance', () => {
    const b = new SketchBuilder();
    const start = b.point(0, 250);
    const sketch = b.build();
    const anchor = { position: { x: 0, y: 250 }, id: start };
    const cursor = { x: 148, y: 260 };
    expect(
      infer(sketch, cursor, { tolerance: 5, enabled: true, anchor, angleTolerance: 2 }).constraints,
    ).toEqual([]);
    const loose = infer(sketch, cursor, {
      tolerance: 5,
      enabled: true,
      anchor,
      angleTolerance: 10,
    });
    expect(loose.constraints).toEqual([{ kind: 'horizontal' }]);
    expect(loose.position).toEqual({ x: 148, y: 250 });
  });

  it('snaps parallel to a diagonal reference line', () => {
    const s = referenceScene();
    const ref = Math.atan2(50, 100);
    const cursor = {
      x: 200 + 100 * Math.cos(ref + degToRad(2)),
      y: 200 + 100 * Math.sin(ref + degToRad(2)),
    };
    const r = infer(s.sketch, cursor, {
      tolerance: 5,
      enabled: true,
      anchor: { position: { x: 200, y: 200 }, id: s.anchor },
      reference: s.reference,
    });
    expect(r.constraints).toEqual([{ kind: 'parallel', target: s.reference }]);
    expect(r.position.x).toBeCloseTo(200 + 100 * Math.cos(ref), 6);
    expect(r.position.y).toBeCloseTo(200 + 100 * Math.sin(ref), 6);
    expect(r.alignments).toEqual([]);
  });

  it('snaps perpendicular to a reference line', () => {
    const s = referenceScene();
    const ref = Math.atan2(50, 100) + Math.PI / 2;
    const cursor = {
      x: 200 + 100 * Math.cos(ref + degToRad(2)),
      y: 200 + 100 * Math.sin(ref + degToRad(2)),
    };
    const r = infer(s.sketch, cursor, {
      tolerance: 5,
      enabled: true,
      anchor: { position: { x: 200, y: 200 }, id: s.anchor },
      reference: s.reference,
    });
    expect(r.constraints).toEqual([{ kind: 'perpendicular', target: s.reference }]);
    expect(r.position.x).toBeCloseTo(200 + 100 * Math.cos(ref), 6);
    expect(r.position.y).toBeCloseTo(200 + 100 * Math.sin(ref), 6);
  });

  it('infers horizontal and vertical in either drawing direction', () => {
    const b = new SketchBuilder();
    const start = b.point(0, 250);
    const sketch = b.build();
    const opts = {
      tolerance: 5,
      enabled: true,
      anchor: { position: { x: 0, y: 250 }, id: start },
      exclude: new Set([start]),
    };
    const left = infer(sketch, { x: -150, y: 253 }, opts);
    expect(left.constraints).toEqual([{ kind: 'horizontal' }]);
    expect(left.position).toEqual({ x: -150, y: 250 });
    const up = infer(sketch, { x: 3, y: 100 }, opts);
    expect(up.constraints).toEqual([{ kind: 'vertical' }]);
    expect(up.position).toEqual({ x: 0, y: 100 });
  });

  it('infers parallel and perpendicular against the reference in either direction', () => {
    const s = referenceScene();
    const opts = {
      tolerance: 5,
      enabled: true,
      anchor: { position: { x: 200, y: 200 }, id: s.anchor },
      reference: s.reference,
    };
    const back = Math.atan2(50, 100) + Math.PI;
    const r = infer(
      s.sketch,
      { x: 200 + 100 * Math.cos(back + degToRad(2)), y: 200 + 100 * Math.sin(back + degToRad(2)) },
      opts,
    );
    expect(r.constraints).toEqual([{ kind: 'parallel', target: s.reference }]);
    expect(r.position.x).toBeCloseTo(200 + 100 * Math.cos(back), 6);
    expect(r.position.y).toBeCloseTo(200 + 100 * Math.sin(back), 6);

    const down = Math.atan2(50, 100) - Math.PI / 2;
    const p = infer(
      s.sketch,
      { x: 200 + 100 * Math.cos(down - degToRad(2)), y: 200 + 100 * Math.sin(down - degToRad(2)) },
      opts,
    );
    expect(p.constraints).toEqual([{ kind: 'perpendicular', target: s.reference }]);
    expect(p.position.x).toBeCloseTo(200 + 100 * Math.cos(down), 6);
  });

  it('ignores the reference line outside the angle tolerance', () => {
    const s = referenceScene();
    const ref = Math.atan2(50, 100) + degToRad(10);
    const cursor = { x: 200 + 100 * Math.cos(ref), y: 200 + 100 * Math.sin(ref) };
    const r = infer(s.sketch, cursor, {
      tolerance: 5,
      enabled: true,
      anchor: { position: { x: 200, y: 200 }, id: s.anchor },
      reference: s.reference,
    });
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([]);
    expect(r.position).toEqual(cursor);
  });

  it('continues an arc smoothly from its start endpoint', () => {
    const s = arcScene();
    const r = infer(
      s.sketch,
      { x: 52, y: -60 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 50, y: 0 }, id: s.start },
      },
    );
    expect(r.constraints).toEqual([{ kind: 'tangent', target: s.arc }]);
    expect(r.position.x).toBeCloseTo(50, 6);
    expect(r.position.y).toBeCloseTo(-Math.hypot(2, 60), 6);
    expect(r.alignments).toEqual([]);
  });

  it('continues an arc smoothly from its end endpoint', () => {
    const s = arcScene();
    const r = infer(
      s.sketch,
      { x: -60, y: 52 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 50 }, id: s.end },
      },
    );
    expect(r.constraints).toEqual([{ kind: 'tangent', target: s.arc }]);
    expect(r.position.x).toBeCloseTo(-Math.hypot(60, 2), 6);
    expect(r.position.y).toBeCloseTo(50, 6);
    expect(r.alignments).toEqual([]);
  });

  it('does not infer tangent when the cursor points back into the arc', () => {
    const s = arcScene();
    const cursor = { x: 56, y: 60 };
    const r = infer(s.sketch, cursor, {
      tolerance: 5,
      enabled: true,
      anchor: { position: { x: 50, y: 0 }, id: s.start },
    });
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([]);
    expect(r.position).toEqual(cursor);
  });

  it('combines a horizontal constraint with a circle intersection', () => {
    const s = curveScene();
    const r = infer(
      s.sketch,
      { x: 163, y: 2 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 0 }, id: s.a },
      },
    );
    expect(r.constraints).toEqual([
      { kind: 'horizontal' },
      { kind: 'pointOnCurve', target: s.circle },
    ]);
    expect(r.position).toEqual({ x: 160, y: 0 });
    expect(r.alignments).toEqual([]);
  });

  it('aligns to the nearest point on x', () => {
    const s = anchorScene();
    const r = infer(s.sketch, { x: 152, y: 200 }, { tolerance: 5, enabled: true });
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([{ source: s.p, axis: 'x' }]);
    expect(r.position).toEqual({ x: 150, y: 200 });
  });

  it('aligns to the nearest point on y', () => {
    const s = anchorScene();
    const r = infer(s.sketch, { x: 320, y: 82 }, { tolerance: 5, enabled: true });
    expect(r.constraints).toEqual([]);
    expect(r.alignments).toEqual([{ source: s.p, axis: 'y' }]);
    expect(r.position).toEqual({ x: 320, y: 80 });
  });

  it('skips a point already on the horizontal line through the anchor', () => {
    const s = anchorScene();
    const r = infer(
      s.sketch,
      { x: 148, y: 260 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 250 }, id: s.free },
      },
    );
    expect(r.constraints).toEqual([{ kind: 'horizontal' }]);
    expect(r.alignments).toEqual([{ source: s.p, axis: 'x' }]);
    expect(r.position).toEqual({ x: 150, y: 250 });
  });

  it('honors the exclude set', () => {
    const s = curveScene();
    const noLine = infer(
      s.sketch,
      { x: 50, y: 8 },
      { tolerance: 5, enabled: true, exclude: new Set([s.line]) },
    );
    expect(noLine.constraints).toEqual([]);
    expect(noLine.position).toEqual({ x: 50, y: 8 });

    const noPoint = infer(
      s.sketch,
      { x: 100, y: 1 },
      { tolerance: 5, enabled: true, exclude: new Set([s.c]) },
    );
    expect(noPoint.constraints).toEqual([{ kind: 'pointOnCurve', target: s.line }]);
    expect(noPoint.position).toEqual({ x: 100, y: 0 });
  });
});

describe('materialize', () => {
  it('maps every inferred kind', () => {
    const s = materializeScene();
    const inputs = materialize(
      [
        { kind: 'coincident', target: 'reused' },
        { kind: 'pointOnCurve', target: s.line },
        { kind: 'horizontal' },
        { kind: 'vertical' },
        { kind: 'parallel', target: s.ref },
        { kind: 'perpendicular', target: s.ref },
        { kind: 'tangent', target: s.arc },
      ],
      { point: 'new', segment: 'seg', anchor: 'anc' },
      s.sketch,
    );
    expect(inputs).toEqual([
      { kind: 'pointOnLine', point: 'new', line: s.line },
      { kind: 'horizontal', a: 'seg' },
      { kind: 'vertical', a: 'seg' },
      { kind: 'parallel', a: 'seg', b: s.ref },
      { kind: 'perpendicular', a: 'seg', b: s.ref },
      { kind: 'tangent', a: 'seg', b: s.arc },
    ]);
  });

  it('falls back to anchor and point without a segment', () => {
    const s = materializeScene();
    expect(
      materialize([{ kind: 'pointOnCurve', target: s.circle }], { point: 'new' }, s.sketch),
    ).toEqual([{ kind: 'pointOnCurve', point: 'new', curve: s.circle }]);
    expect(
      materialize([{ kind: 'horizontal' }], { point: 'new', anchor: 'anc' }, s.sketch),
    ).toEqual([{ kind: 'horizontal', a: 'anc', b: 'new' }]);
    expect(materialize([{ kind: 'vertical' }], { point: 'new' }, s.sketch)).toEqual([]);
    expect(
      materialize([{ kind: 'parallel', target: s.ref }], { point: 'new', anchor: 'anc' }, s.sketch),
    ).toEqual([]);
    expect(materialize([{ kind: 'tangent', target: s.arc }], { point: 'new' }, s.sketch)).toEqual(
      [],
    );
  });

  it('turns an inference result into constraints', () => {
    const s = curveScene();
    const r = infer(
      s.sketch,
      { x: 163, y: 2 },
      {
        tolerance: 5,
        enabled: true,
        anchor: { position: { x: 0, y: 0 }, id: s.a },
      },
    );
    const inputs = materialize(
      r.constraints,
      { point: 'p1', segment: 'l1', anchor: s.a },
      s.sketch,
    );
    expect(inputs).toEqual([
      { kind: 'horizontal', a: 'l1' },
      { kind: 'pointOnCurve', point: 'p1', curve: s.circle },
    ]);
  });
});

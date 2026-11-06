import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { SketchError } from '../core/sketch';
import { translate } from './translate';

describe('translate', () => {
  it('orders points before curves before constraints', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    const line = b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: line });

    const { primitives } = translate(b.build());
    expect(primitives.map((p) => p.type)).toEqual(['point', 'point', 'line', 'horizontal_l']);
    expect(primitives.map((p) => p.id)).toEqual(['1', '2', '3', '4']);
  });

  it('adds hidden arc rules and derives arc angles from its points', () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const e = b.point(0, 10);
    b.arc(c, s, e);

    const { primitives, constraintOf } = translate(b.build());
    const arc = primitives.find((p) => p.type === 'arc');
    expect(arc).toMatchObject({ radius: 10, start_angle: 0, end_angle: Math.PI / 2 });
    expect(primitives.at(-1)).toMatchObject({ type: 'arc_rules', a_id: arc?.id });
    expect(constraintOf.size).toBe(0);
  });

  it('maps every lowered primitive back to its sketch constraint', () => {
    const b = new SketchBuilder();
    const p = b.point(3, 4);
    const fix = b.fix(p);

    const { primitives, constraintOf } = translate(b.build());
    const lowered = primitives.filter((x) => x.type.startsWith('coordinate_'));
    expect(lowered).toHaveLength(2);
    for (const prim of lowered) {
      expect(constraintOf.get(prim.id)).toBe(fix);
    }
  });

  it('lowers tangency at a shared endpoint to an angle at that point', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const joint = b.point(80, 0);
    const c = b.point(80, 20);
    const end = b.point(100, 20);
    const line = b.line(p1, joint);
    const arc = b.arc(c, joint, end);
    b.constrain({ kind: 'tangent', a: line, b: arc });

    const { primitives, gcsIdOf } = translate(b.build());
    const lowered = primitives.at(-1);
    expect(lowered).toMatchObject({ type: 'angle_via_point', p_id: gcsIdOf.get(joint) });
    expect([0, Math.PI]).toContain(lowered?.type === 'angle_via_point' ? lowered.angle : undefined);
  });

  it('resolves named parameters', () => {
    const b = new SketchBuilder().param('gap', 16);
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 'gap' });

    const { primitives } = translate(b.build());
    expect(primitives.at(-1)).toMatchObject({ type: 'p2p_distance', distance: 16 });
  });

  it('marks drag targets as temporary', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);

    const { primitives } = translate(b.build(), { point: p, x: 5, y: 6 });
    expect(primitives.slice(1)).toEqual([
      { id: '2', type: 'coordinate_x', p_id: '1', x: 5, temporary: true },
      { id: '3', type: 'coordinate_y', p_id: '1', y: 6, temporary: true },
    ]);
  });

  it('rejects invalid operands', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.constrain({ kind: 'parallel', a: p1, b: p2 });
    expect(() => translate(b.build())).toThrow(SketchError);
  });

  it('rejects unknown parameters and references', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.constrain({ kind: 'distance', a: p1, b: 'nope', value: 1 });
    expect(() => translate(b.build())).toThrow(/unknown entity/);

    const c = new SketchBuilder();
    const q1 = c.point(0, 0);
    const q2 = c.point(1, 0);
    c.constrain({ kind: 'distance', a: q1, b: q2, value: 'missing' });
    expect(() => translate(c.build())).toThrow(/Unknown parameter/);
  });
});

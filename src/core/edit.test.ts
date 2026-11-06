import { describe, expect, it } from 'vitest';
import { SketchBuilder } from './builder';
import { deleteItems, toggleConstruction } from './edit';

function lShape() {
  const b = new SketchBuilder();
  const p1 = b.point(0, 0);
  const p2 = b.point(10, 0);
  const p3 = b.point(10, 10);
  const l1 = b.line(p1, p2);
  const l2 = b.line(p2, p3);
  const h = b.constrain({ kind: 'horizontal', a: l1 });
  const v = b.constrain({ kind: 'vertical', a: l2 });
  return { sketch: b.build(), p1, p2, p3, l1, l2, h, v };
}

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('deleteItems', () => {
  it('deleting a curve removes its unshared points and its constraints', () => {
    const s = lShape();
    const out = deleteItems(s.sketch, [s.l1]);
    expect(ids(out.entities)).toEqual([s.p2, s.p3, s.l2]);
    expect(ids(out.constraints)).toEqual([s.v]);
  });

  it('deleting a shared point removes every curve built on it', () => {
    const s = lShape();
    const out = deleteItems(s.sketch, [s.p2]);
    expect(out.entities).toEqual([]);
    expect(out.constraints).toEqual([]);
  });

  it('deletes a constraint on its own', () => {
    const s = lShape();
    const out = deleteItems(s.sketch, [s.h]);
    expect(out.entities).toEqual(s.sketch.entities);
    expect(ids(out.constraints)).toEqual([s.v]);
  });

  it('returns the same sketch when nothing matches', () => {
    const s = lShape();
    expect(deleteItems(s.sketch, ['nope'])).toBe(s.sketch);
  });
});

describe('toggleConstruction', () => {
  it('turns a mixed selection into construction, then back', () => {
    const s = lShape();
    const once = toggleConstruction(toggleConstruction(s.sketch, [s.l1]), [s.l1, s.l2]);
    expect(once.entities.filter((e) => e.kind === 'line').every((e) => e.kind === 'line' && e.construction)).toBe(true);
    const twice = toggleConstruction(once, [s.l1, s.l2]);
    expect(twice.entities.some((e) => e.kind === 'line' && e.construction === true)).toBe(false);
  });

  it('ignores points', () => {
    const s = lShape();
    expect(toggleConstruction(s.sketch, [s.p1])).toBe(s.sketch);
  });
});

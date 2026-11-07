import { describe, expect, it } from 'vitest';
import { SketchBuilder } from './builder';
import { constraintValue, deleteItems, setConstraintValue, toggleConstruction } from './edit';
import type { Constraint } from './model';
import type { Sketch } from './sketch';

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

const at = (sketch: Sketch, id: string): Constraint => {
  const found = sketch.constraints.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing constraint "${id}"`);
  return found;
};

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
    expect(
      once.entities
        .filter((e) => e.kind === 'line')
        .every((e) => e.kind === 'line' && e.construction),
    ).toBe(true);
    const twice = toggleConstruction(once, [s.l1, s.l2]);
    expect(twice.entities.some((e) => e.kind === 'line' && e.construction === true)).toBe(false);
  });

  it('ignores points', () => {
    const s = lShape();
    expect(toggleConstruction(s.sketch, [s.p1])).toBe(s.sketch);
  });
});

/** A sketch holding one of each dimension kind, plus a non-dimension one. */
function dims() {
  const b = new SketchBuilder().param('gap', 25).param('span', 40);
  const p1 = b.point(0, 0);
  const p2 = b.point(30, 0);
  const p3 = b.point(30, 30);
  const l1 = b.line(p1, p2);
  const l2 = b.line(p2, p3);
  const cir = b.circle(p1, 5);
  const dist = b.constrain({ kind: 'distance', a: p1, b: p2, value: 30 });
  const rad = b.constrain({ kind: 'radius', curve: cir, value: 'gap' });
  const ang = b.constrain({ kind: 'angle', a: l1, b: l2, value: 90 });
  const horiz = b.constrain({ kind: 'horizontal', a: l1 });
  return { sketch: b.build(), l1, l2, cir, dist, rad, ang, horiz };
}

describe('setConstraintValue', () => {
  it('rewrites the value of distance, radius and angle constraints', () => {
    const s = dims();
    let out = setConstraintValue(s.sketch, s.dist, 12);
    out = setConstraintValue(out, s.rad, 'span');
    out = setConstraintValue(out, s.ang, 45);
    expect(at(out, s.dist)).toMatchObject({ kind: 'distance', value: 12 });
    expect(at(out, s.rad)).toMatchObject({ kind: 'radius', value: 'span' });
    expect(at(out, s.ang)).toMatchObject({ kind: 'angle', value: 45 });
  });

  it('leaves entities, params and the other constraints untouched', () => {
    const s = dims();
    const out = setConstraintValue(setConstraintValue(s.sketch, s.dist, 12), s.rad, 'gap');
    expect(out.entities).toBe(s.sketch.entities);
    expect(out.params).toBe(s.sketch.params);
    const others = (sketch: Sketch) =>
      sketch.constraints.filter((c) => c.id !== s.dist && c.id !== s.rad);
    expect(others(out)).toEqual(others(s.sketch));
  });

  it('leaves other constraint kinds and unknown ids unchanged', () => {
    const s = dims();
    expect(setConstraintValue(s.sketch, s.horiz, 5)).toBe(s.sketch);
    expect(setConstraintValue(s.sketch, 'nope', 5)).toBe(s.sketch);
  });

  it('returns the same sketch when the value is already set', () => {
    const s = dims();
    expect(setConstraintValue(s.sketch, s.dist, 30)).toBe(s.sketch);
    expect(setConstraintValue(s.sketch, s.rad, 'gap')).toBe(s.sketch);
    expect(setConstraintValue(s.sketch, s.ang, 90)).toBe(s.sketch);
  });
});

describe('constraintValue', () => {
  it('reads a plain number and resolves a parameter name', () => {
    const s = dims();
    expect(constraintValue(at(s.sketch, s.dist), s.sketch.params)).toBe(30);
    expect(constraintValue(at(s.sketch, s.rad), s.sketch.params)).toBe(25);
  });

  it('is undefined for a non-dimension constraint and an unknown parameter name', () => {
    const s = dims();
    expect(constraintValue(at(s.sketch, s.horiz), s.sketch.params)).toBeUndefined();
    const renamed = setConstraintValue(s.sketch, s.rad, 'nope');
    expect(constraintValue(at(renamed, s.rad), renamed.params)).toBeUndefined();
  });
});

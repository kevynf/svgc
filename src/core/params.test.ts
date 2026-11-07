import { describe, expect, it } from 'vitest';
import { SketchBuilder } from './builder';
import { emptySketch } from './sketch';
import {
  paramDefs,
  paramRefCount,
  resolveSketchParams,
  withParam,
  withParamExpression,
  withRenamedParam,
  withoutParam,
} from './params';
import type { ParamResult } from './params';
import type { Constraint } from './model';
import type { Sketch } from './sketch';

/** Two plain parameters, and one dimension of each kind that reads them. */
function dims() {
  const b = new SketchBuilder().param('gap', 25).param('span', 40);
  const p1 = b.point(0, 0);
  const p2 = b.point(30, 0);
  const l1 = b.line(p1, p2);
  const cir = b.circle(p1, 5);
  const dist = b.constrain({ kind: 'distance', a: p1, b: p2, value: 'gap' });
  const rad = b.constrain({ kind: 'radius', curve: cir, value: 'gap' });
  const ang = b.constrain({ kind: 'angle', a: l1, b: l1, value: 90 });
  const horiz = b.constrain({ kind: 'horizontal', a: l1 });
  return { sketch: b.build(), dist, rad, ang, horiz };
}

const at = (sketch: Sketch, id: string): Constraint => {
  const found = sketch.constraints.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing constraint "${id}"`);
  return found;
};

/** The sketch of an accepted edit, so the tests read straight from it. */
function edited(result: ParamResult): Sketch {
  if (!result.ok) throw new Error(`expected the edit to be accepted, got "${result.error}"`);
  return result.sketch;
}

describe('paramDefs', () => {
  it('reports the stored source of a parameter and the number of a plain one', () => {
    const s = dims();
    expect(paramDefs(s.sketch)).toEqual([
      { name: 'gap', expression: '25' },
      { name: 'span', expression: '40' },
    ]);
    const out = edited(withParam(s.sketch, 'side', 'gap * 2'));
    expect(paramDefs(out)).toEqual([
      { name: 'gap', expression: '25' },
      { name: 'span', expression: '40' },
      { name: 'side', expression: 'gap * 2' },
    ]);
  });

  it('is empty for a sketch without parameters', () => {
    expect(paramDefs(emptySketch())).toEqual([]);
  });
});

describe('resolveSketchParams', () => {
  it('resolves a dependent before the parameter that reads it', () => {
    let out = edited(withParam(emptySketch(), 'b', '4'));
    out = edited(withParam(out, 'a', '2'));
    // `b` is declared first, but from here on it reads `a`.
    out = edited(withParamExpression(out, 'b', 'a * 2'));
    const res = resolveSketchParams(out);
    expect(res.order).toEqual(['a', 'b']);
    expect([...res.values]).toEqual([
      ['a', 2],
      ['b', 4],
    ]);
    expect(res.errors.size).toBe(0);
  });

  it('reports every value, plain and computed', () => {
    const out = edited(withParam(dims().sketch, 'side', 'gap * 2'));
    const res = resolveSketchParams(out);
    expect(res.errors.size).toBe(0);
    expect([...res.values]).toEqual([
      ['gap', 25],
      ['span', 40],
      ['side', 50],
    ]);
  });
});

describe('paramRefCount', () => {
  it('counts the dimensions that take their value from a parameter', () => {
    const s = dims();
    expect(paramRefCount(s.sketch, 'gap')).toBe(2);
    expect(paramRefCount(s.sketch, 'span')).toBe(0);
    expect(paramRefCount(s.sketch, 'nope')).toBe(0);
  });

  it('counts the other parameters that reference it', () => {
    const s = dims();
    const side = edited(withParam(s.sketch, 'side', 'gap * 2'));
    const area = edited(withParam(side, 'area', 'side * span'));
    expect(paramRefCount(area, 'gap')).toBe(3);
    expect(paramRefCount(area, 'side')).toBe(1);
    expect(paramRefCount(area, 'area')).toBe(0);
    expect(paramRefCount(area, 'span')).toBe(1);
  });
});

describe('withParam', () => {
  it('adds a parameter and re-solves the values', () => {
    const s = dims();
    const out = withParam(s.sketch, 'side', 'gap * 2');
    if (!out.ok) return;
    expect(out.sketch.params).toEqual({ gap: 25, span: 40, side: 50 });
    // The map stays sparse: the plain parameters keep no source.
    expect(out.sketch.expressions).toEqual({ side: 'gap * 2' });
    expect(out.sketch.entities).toBe(s.sketch.entities);
    expect(out.sketch.constraints).toBe(s.sketch.constraints);
  });

  it('refuses an invalid name', () => {
    const s = dims();
    expect(withParam(s.sketch, '1x', '5')).toEqual({ ok: false, error: 'invalidName' });
    expect(withParam(s.sketch, 'a b', '5')).toEqual({ ok: false, error: 'invalidName' });
    expect(withParam(s.sketch, '', '5')).toEqual({ ok: false, error: 'invalidName' });
    expect(withParam(s.sketch, 'PI', '5')).toEqual({ ok: false, error: 'invalidName' });
    expect(withParam(s.sketch, 'sqrt', '5')).toEqual({ ok: false, error: 'invalidName' });
  });

  it('refuses a name the sketch already has', () => {
    const s = dims();
    expect(withParam(s.sketch, 'gap', '5')).toEqual({ ok: false, error: 'duplicateName' });
  });

  it('refuses an expression it cannot evaluate', () => {
    const s = dims();
    expect(withParam(s.sketch, 'side', '1 2')).toEqual({ ok: false, error: 'syntax' });
    expect(withParam(s.sketch, 'side', '1 +')).toEqual({ ok: false, error: 'unexpectedEnd' });
    expect(withParam(s.sketch, 'side', 'foo(1)')).toEqual({ ok: false, error: 'unknownFunction' });
    expect(withParam(s.sketch, 'side', 'sin(1, 2)')).toEqual({ ok: false, error: 'arity' });
    expect(withParam(s.sketch, 'side', 'sqrt(0 - 1)')).toEqual({ ok: false, error: 'domain' });
    expect(withParam(s.sketch, 'side', 'gap / (span - 40)')).toEqual({ ok: false, error: 'divisionByZero' });
    expect(withParam(s.sketch, 'side', '1e308 * 10')).toEqual({ ok: false, error: 'notFinite' });
  });

  it('names the unknown parameter in a refused expression', () => {
    const s = dims();
    expect(withParam(s.sketch, 'side', 'nope * 2')).toEqual({ ok: false, error: 'unknownName', detail: 'nope' });
  });

  it('refuses a parameter that references itself', () => {
    const s = dims();
    expect(withParam(s.sketch, 'side', 'side * 2')).toEqual({ ok: false, error: 'cycle' });
  });

  it('refuses an expression that would close a cycle', () => {
    // `b` reads a parameter that does not exist yet; adding it as a reader of
    // `b` would close b → a → b.
    const dangling: Sketch = { entities: [], constraints: [], params: { b: 4 }, expressions: { b: 'a * 2' } };
    expect(withParam(dangling, 'a', 'b * 3')).toEqual({ ok: false, error: 'cycle' });
  });
});

describe('withParamExpression', () => {
  /** `a` is a plain value, `b` reads it. */
  function chain(): Sketch {
    const a = edited(withParam(emptySketch(), 'a', '10'));
    return edited(withParam(a, 'b', 'a * 2'));
  }

  it('re-solves the parameters that read the edited one', () => {
    const out = withParamExpression(chain(), 'a', '20');
    if (!out.ok) return;
    expect(out.sketch.params).toEqual({ a: 20, b: 40 });
    // The source of the parameter that was not edited survives.
    expect(out.sketch.expressions).toEqual({ a: '20', b: 'a * 2' });
  });

  it('refuses a parameter the sketch does not have', () => {
    expect(withParamExpression(chain(), 'nope', '1')).toEqual({ ok: false, error: 'unknownName', detail: 'nope' });
    expect(withParamExpression(chain(), 'a', 'nope')).toEqual({ ok: false, error: 'unknownName', detail: 'nope' });
  });

  it('refuses an edit that would close a cycle', () => {
    const out = withParamExpression(chain(), 'a', 'b * 3');
    expect(out).toEqual({ ok: false, error: 'cycle' });
    expect(withParamExpression(chain(), 'a', 'a')).toEqual({ ok: false, error: 'cycle' });
  });
});

describe('withRenamedParam', () => {
  /** `gap` and `span` are plain, `side` reads `gap`, `area` reads `side`. */
  function named(): Sketch {
    const s = dims();
    const side = edited(withParam(s.sketch, 'side', 'gap * 2'));
    return edited(withParam(side, 'area', 'side * span'));
  }

  it('rewrites the constraint values and the references in other expressions', () => {
    const s = dims();
    const out = withRenamedParam(named(), 'gap', 'width');
    if (!out.ok) return;
    expect(out.sketch.params).toEqual({ width: 25, span: 40, side: 50, area: 2000 });
    expect(out.sketch.expressions).toEqual({ side: 'width * 2', area: 'side * span' });
    expect(at(out.sketch, s.dist)).toMatchObject({ kind: 'distance', value: 'width' });
    expect(at(out.sketch, s.rad)).toMatchObject({ kind: 'radius', value: 'width' });
    // The angle kept its plain number, and the horizontal has no value at all.
    expect(at(out.sketch, s.ang)).toMatchObject({ value: 90 });
    expect(at(out.sketch, s.horiz)).not.toHaveProperty('value');
  });

  it('keeps the source of the renamed parameter', () => {
    const out = edited(withRenamedParam(named(), 'side', 'edge'));
    expect(out.expressions).toEqual({ edge: 'gap * 2', area: 'edge * span' });
    expect(out.params).toEqual({ gap: 25, span: 40, edge: 50, area: 2000 });
  });

  it('drops the expression field when no parameter has a source', () => {
    const out = edited(withRenamedParam(dims().sketch, 'gap', 'width'));
    expect(out.params).toEqual({ width: 25, span: 40 });
    expect(out.expressions).toBeUndefined();
  });

  it('renaming to the same name returns the sketch unchanged', () => {
    const sketch = named();
    const out = withRenamedParam(sketch, 'gap', 'gap');
    if (!out.ok) return;
    expect(out.sketch).toBe(sketch);
  });

  it('refuses an invalid, taken or unknown name', () => {
    const sketch = named();
    expect(withRenamedParam(sketch, 'gap', '2x')).toEqual({ ok: false, error: 'invalidName' });
    expect(withRenamedParam(sketch, 'gap', 'span')).toEqual({ ok: false, error: 'duplicateName' });
    expect(withRenamedParam(sketch, 'nope', 'width')).toEqual({ ok: false, error: 'unknownName', detail: 'nope' });
  });
});

describe('withoutParam', () => {
  it('refuses while a dimension takes its value from the parameter', () => {
    const s = dims();
    expect(withoutParam(s.sketch, 'gap')).toEqual({ ok: false, error: 'inUse', count: 2 });
  });

  it('refuses while another parameter references it', () => {
    const s = dims();
    const side = edited(withParam(s.sketch, 'side', 'gap * 2'));
    const area = edited(withParam(side, 'area', 'side * span'));
    expect(withoutParam(area, 'gap')).toEqual({ ok: false, error: 'inUse', count: 3 });
    expect(withoutParam(area, 'side')).toEqual({ ok: false, error: 'inUse', count: 1 });
  });

  it('drops a parameter nothing references', () => {
    const s = dims();
    const out = withoutParam(s.sketch, 'span');
    if (!out.ok) return;
    expect(out.sketch.params).toEqual({ gap: 25 });
    expect(out.sketch.expressions).toBeUndefined();
  });

  it('drops a parameter only its own expression used', () => {
    const side = edited(withParam(dims().sketch, 'side', 'gap * 2'));
    const out = withoutParam(side, 'side');
    if (!out.ok) return;
    expect(out.sketch.params).toEqual({ gap: 25, span: 40 });
    expect(paramDefs(out.sketch)).toEqual([
      { name: 'gap', expression: '25' },
      { name: 'span', expression: '40' },
    ]);
  });

  it('refuses a parameter the sketch does not have', () => {
    expect(withoutParam(dims().sketch, 'nope')).toEqual({ ok: false, error: 'unknownName', detail: 'nope' });
  });
});

describe('immutability', () => {
  it('leaves the sketch untouched on every refusal', () => {
    const s = dims();
    withParam(s.sketch, 'gap', '5');
    withParam(s.sketch, '1x', '5');
    withParam(s.sketch, 'side', 'nope');
    withParam(s.sketch, 'side', 'side');
    withParamExpression(s.sketch, 'nope', '5');
    withParamExpression(s.sketch, 'gap', 'gap * 2');
    withRenamedParam(s.sketch, 'nope', 'width');
    withRenamedParam(s.sketch, 'gap', 'span');
    withoutParam(s.sketch, 'gap');
    withoutParam(s.sketch, 'nope');
    expect(s.sketch).toEqual(dims().sketch);
  });
});

describe('round trip', () => {
  it('carries the typed source into the next sketch', () => {
    const side = edited(withParam(dims().sketch, 'side', 'gap * 2'));
    expect(paramDefs(side)).toEqual([
      { name: 'gap', expression: '25' },
      { name: 'span', expression: '40' },
      { name: 'side', expression: 'gap * 2' },
    ]);
    // An edit on top of it still resolves from the stored sources.
    const next = edited(withParamExpression(side, 'gap', '30'));
    expect(paramDefs(next)).toEqual([
      { name: 'gap', expression: '30' },
      { name: 'span', expression: '40' },
      { name: 'side', expression: 'gap * 2' },
    ]);
    expect(next.params).toEqual({ gap: 30, span: 40, side: 60 });
  });
});

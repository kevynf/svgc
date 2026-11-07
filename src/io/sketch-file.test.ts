import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { withParam } from '../core/params';
import type { ParamResult } from '../core/params';
import type { Sketch } from '../core/sketch';
import {
  parseSketch,
  serializeSketch,
  SKETCH_FILE_FORMAT,
  SKETCH_FILE_VERSION,
} from './sketch-file';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** The sketch of an accepted edit, so the tests read straight from it. */
function edited(result: ParamResult): Sketch {
  if (!result.ok) throw new Error(`expected the edit to be accepted, got "${result.error}"`);
  return result.sketch;
}

/**
 * One of everything: every entity kind, every constraint kind, a parameter with a source, one
 * without, and an artboard.
 */
function rich(): Sketch {
  const b = new SketchBuilder().param('gap', 24).param('span', 60);

  const origin = b.point(0, 0);
  b.fix(origin);
  const right = b.point(100, 0);
  const above = b.point(0, 60);
  const top = b.line(origin, right);
  const left = b.line(origin, above);

  const landing = b.point(0, 0);
  b.constrain({ kind: 'coincident', a: landing, b: origin });

  b.constrain({ kind: 'horizontal', a: top });
  b.constrain({ kind: 'vertical', a: left });
  b.constrain({ kind: 'horizontal', a: origin, b: right });
  b.constrain({ kind: 'vertical', a: origin, b: above });
  b.constrain({ kind: 'parallel', a: top, b: left });
  b.constrain({ kind: 'perpendicular', a: top, b: left });
  b.constrain({ kind: 'equal', a: top, b: left });

  const hub = b.point(50, 30);
  const ring = b.circle(hub, 20, { construction: true });
  const bow = b.arc(hub, origin, right);
  b.constrain({ kind: 'pointOnLine', point: hub, line: top });
  b.constrain({ kind: 'pointOnCurve', point: origin, curve: bow });
  b.constrain({ kind: 'midpoint', point: hub, line: top });
  b.constrain({ kind: 'tangent', a: top, b: ring });
  b.constrain({ kind: 'symmetric', a: landing, b: above, line: left });

  b.constrain({ kind: 'distance', a: origin, b: right, value: 'gap', placement: 18 });
  b.constrain({ kind: 'radius', curve: ring, value: 20, placement: 0.5 });
  b.constrain({ kind: 'angle', a: top, b: left, value: 90, placement: 24 });

  return { ...edited(withParam(b.build(), 'side', 'gap * 2')), artboard: box(-20, -20, 240, 120) };
}

/** A valid document around `sketch`, so each refusal test breaks exactly one thing. */
function file(sketch: unknown, version: number = SKETCH_FILE_VERSION): string {
  return JSON.stringify({ format: SKETCH_FILE_FORMAT, version, sketch });
}

const bare: Sketch = { entities: [], constraints: [], params: {} };

describe('serializeSketch', () => {
  it('writes a pretty-printed document with a stable layout', () => {
    const text = serializeSketch(bare);
    expect(text).toBe(
      [
        '{',
        '  "format": "svgc-sketch",',
        '  "version": 1,',
        '  "sketch": {',
        '    "entities": [],',
        '    "constraints": [],',
        '    "params": {}',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(serializeSketch(bare)).toBe(text);
    expect(serializeSketch(rich())).toBe(serializeSketch(rich()));
    expect(text).not.toContain('\t');
  });

  it('leaves out the sections a sketch does not have', () => {
    const text = serializeSketch(bare);
    expect(text).not.toContain('expressions');
    expect(text).not.toContain('artboard');
  });

  it('writes the sections a sketch does have', () => {
    const sketch: Sketch = {
      ...bare,
      expressions: { side: 'gap * 2' },
      artboard: box(0, 0, 10, 10),
    };
    expect(JSON.parse(serializeSketch(sketch))).toEqual({
      format: SKETCH_FILE_FORMAT,
      version: SKETCH_FILE_VERSION,
      sketch: {
        entities: [],
        constraints: [],
        params: {},
        expressions: { side: 'gap * 2' },
        artboard: box(0, 0, 10, 10),
      },
    });
  });
});

describe('round trip', () => {
  it('reads a rich sketch back exactly as it was written', () => {
    const sketch = rich();
    expect(parseSketch(serializeSketch(sketch))).toEqual({ ok: true, sketch });
  });

  it('reads a bare sketch back without inventing a section', () => {
    expect(parseSketch(serializeSketch(bare))).toEqual({ ok: true, sketch: bare });
  });
});

describe('refusals', () => {
  it('refuses text that is not JSON', () => {
    expect(parseSketch('not json at all')).toEqual({ ok: false, error: 'invalidJson' });
    expect(parseSketch('{"format": "svgc-sketch",')).toEqual({ ok: false, error: 'invalidJson' });
  });

  it('refuses a JSON document that is not an object', () => {
    expect(parseSketch('[]')).toEqual({ ok: false, error: 'invalidJson' });
    expect(parseSketch('42')).toEqual({ ok: false, error: 'invalidJson' });
    expect(parseSketch('null')).toEqual({ ok: false, error: 'invalidJson' });
  });

  it('refuses a document that does not carry the format tag', () => {
    expect(parseSketch(JSON.stringify({ version: SKETCH_FILE_VERSION, sketch: bare }))).toEqual({
      ok: false,
      error: 'unknownFormat',
    });
  });

  it('refuses a document of another format', () => {
    expect(parseSketch(JSON.stringify({ format: 'svgc-scene', version: 1, sketch: bare }))).toEqual(
      {
        ok: false,
        error: 'unknownFormat',
      },
    );
  });

  it('refuses a version newer than the one it writes', () => {
    expect(parseSketch(file(bare, SKETCH_FILE_VERSION + 1))).toEqual({
      ok: false,
      error: 'unsupportedVersion',
    });
  });

  it('refuses a version that is not a number', () => {
    expect(
      parseSketch(JSON.stringify({ format: SKETCH_FILE_FORMAT, version: '1', sketch: bare })),
    ).toEqual({
      ok: false,
      error: 'unsupportedVersion',
    });
  });

  it('accepts a version older than the one it writes', () => {
    expect(parseSketch(file(bare, 0))).toEqual({ ok: true, sketch: bare });
  });

  it('refuses a sketch that is missing a core section', () => {
    expect(parseSketch(file({ constraints: [], params: {} }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
    expect(parseSketch(file({ entities: [], params: {} }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
    expect(parseSketch(file({ entities: [], constraints: [] }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
  });

  it('refuses a sketch that is not an object', () => {
    expect(parseSketch(file([]))).toEqual({ ok: false, error: 'invalidSketch' });
    expect(parseSketch(file('sketch'))).toEqual({ ok: false, error: 'invalidSketch' });
    expect(parseSketch(JSON.stringify({ format: SKETCH_FILE_FORMAT, version: 1 }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
  });

  it('refuses a core section of the wrong type', () => {
    expect(parseSketch(file({ entities: {}, constraints: [], params: {} }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
    expect(parseSketch(file({ entities: [], constraints: {}, params: {} }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
    expect(parseSketch(file({ entities: [], constraints: [], params: [] }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
  });

  it('refuses an entity of an unknown kind', () => {
    expect(
      parseSketch(file({ entities: [{ kind: 'spline', id: 'e1' }], constraints: [], params: {} })),
    ).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
  });

  it('refuses an entity without a usable id', () => {
    const entities = [
      { kind: 'point', x: 0, y: 0 },
      { kind: 'point', id: 7, x: 0, y: 0 },
      { kind: 'point', id: '', x: 0, y: 0 },
      { kind: 'line', id: 'e1', p1: 'e2' },
    ];
    for (const entity of entities) {
      expect(parseSketch(file({ entities: [entity], constraints: [], params: {} }))).toEqual({
        ok: false,
        error: 'invalidSketch',
      });
    }
  });

  it('refuses a coordinate that is not a finite number', () => {
    const entities = [
      { kind: 'point', id: 'e1', x: 1e999, y: 0 },
      { kind: 'point', id: 'e1', x: null, y: 0 },
      { kind: 'point', id: 'e1', x: '0', y: 0 },
      { kind: 'circle', id: 'e1', center: 'e2', radius: '20' },
    ];
    for (const entity of entities) {
      expect(parseSketch(file({ entities: [entity], constraints: [], params: {} }))).toEqual({
        ok: false,
        error: 'invalidSketch',
      });
    }
  });

  it('refuses a constraint of an unknown kind', () => {
    expect(
      parseSketch(
        file({ entities: [], constraints: [{ kind: 'symmetric', id: 'c1', a: 'e1' }], params: {} }),
      ),
    ).toEqual({
      ok: false,
      error: 'invalidSketch',
    });
  });

  it('refuses a constraint whose operands are malformed', () => {
    const constraints = [
      { kind: 'coincident', id: 'c1', a: 'e1' },
      { kind: 'coincident', id: 'c1', a: 1, b: 'e1' },
      { kind: 'coincident', a: 'e1', b: 'e1' },
      { kind: 'fix', id: 'c1', point: 'e1', x: 0 },
      { kind: 'midpoint', id: 'c1', point: 'e1' },
      { kind: 'symmetric', id: 'c1', a: 'e1', b: 'e2' },
      { kind: 'distance', id: 'c1', a: 'e1', b: 'e2' },
      { kind: 'radius', id: 'c1', curve: 'e1' },
    ];
    for (const constraint of constraints) {
      expect(parseSketch(file({ entities: [], constraints: [constraint], params: {} }))).toEqual({
        ok: false,
        error: 'invalidSketch',
      });
    }
  });

  it('refuses an optional field that is present but malformed', () => {
    const entities = [{ kind: 'line', id: 'e1', p1: 'e2', p2: 'e3', construction: 'yes' }];
    expect(parseSketch(file({ entities, constraints: [], params: {} }))).toEqual({
      ok: false,
      error: 'invalidSketch',
    });

    const constraints = [
      { kind: 'horizontal', id: 'c1', a: 'e1', b: 5 },
      { kind: 'distance', id: 'c1', a: 'e1', b: 'e2', value: 10, placement: null },
      { kind: 'distance', id: 'c1', a: 'e1', b: 'e2', value: null },
      { kind: 'angle', id: 'c1', a: 'e1', b: 'e2', value: {} },
    ];
    for (const constraint of constraints) {
      expect(parseSketch(file({ entities: [], constraints: [constraint], params: {} }))).toEqual({
        ok: false,
        error: 'invalidSketch',
      });
    }
  });

  it('refuses a malformed artboard', () => {
    const artboards = [
      { x: 0, y: 0, width: 10 },
      { x: '0', y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 1e999, height: 10 },
      [],
      null,
    ];
    for (const artboard of artboards) {
      expect(parseSketch(file({ ...bare, artboard }))).toEqual({
        ok: false,
        error: 'invalidSketch',
      });
    }
  });

  it('refuses a malformed expressions record', () => {
    const records = [{ gap: 24 }, { gap: null }, [], 'gap'];
    for (const expressions of records) {
      expect(parseSketch(file({ ...bare, expressions }))).toEqual({
        ok: false,
        error: 'invalidSketch',
      });
    }
  });

  it('never throws, whatever it is given', () => {
    const docs = [
      '',
      '{',
      '[]',
      'null',
      '"svgc-sketch"',
      file({}),
      file({ entities: [null], constraints: [], params: {} }),
      file({ entities: [{}], constraints: [], params: {} }),
      file({ entities: [], constraints: [{}], params: {} }),
      file({ entities: [], constraints: [], params: { gap: {} } }),
      file({ entities: [], constraints: [], params: {}, expressions: 'gap' }),
      file({ ...bare, artboard: null }),
      file({ ...bare, artboard: 5 }),
    ];
    for (const doc of docs) {
      expect(() => parseSketch(doc)).not.toThrow();
      expect(parseSketch(doc).ok).toBe(false);
    }
  });
});

describe('forward compatibility', () => {
  it('ignores the fields it does not know, at every level', () => {
    const doc = {
      format: SKETCH_FILE_FORMAT,
      version: SKETCH_FILE_VERSION,
      sketch: {
        entities: [{ kind: 'point', id: 'e1', x: 1, y: 2, label: 'origin', locked: true }],
        constraints: [{ kind: 'fix', id: 'c1', point: 'e1', x: 1, y: 2, note: 'anchor' }],
        params: { gap: 24, spare: 1 },
        note: 'hand-edited',
      },
      meta: { app: 'svgc' },
    };
    expect(parseSketch(JSON.stringify(doc))).toEqual({
      ok: true,
      sketch: {
        entities: [{ kind: 'point', id: 'e1', x: 1, y: 2 }],
        constraints: [{ kind: 'fix', id: 'c1', point: 'e1', x: 1, y: 2 }],
        params: { gap: 24, spare: 1 },
      },
    });
  });

  it('ignores an extra field on the artboard', () => {
    const artboard = { ...box(0, 0, 10, 10), unit: 'px' };
    expect(parseSketch(file({ ...bare, artboard }))).toEqual({
      ok: true,
      sketch: { ...bare, artboard: box(0, 0, 10, 10) },
    });
  });
});

describe('normalisation', () => {
  it('copies the artboard as it is', () => {
    const artboard = box(-20, -20, 240, 120);
    expect(parseSketch(serializeSketch({ ...bare, artboard }))).toEqual({
      ok: true,
      sketch: { ...bare, artboard },
    });
  });

  it('keeps an empty expressions record as it is', () => {
    expect(parseSketch(file({ ...bare, expressions: {} }))).toEqual({
      ok: true,
      sketch: { ...bare, expressions: {} },
    });
  });

  it('keeps ids verbatim', () => {
    const sketch: Sketch = {
      entities: [
        { kind: 'point', id: 'p 1', x: 0, y: 0 },
        { kind: 'point', id: 'λ', x: 1, y: 0 },
        { kind: 'line', id: 'a/b', p1: 'p 1', p2: 'λ' },
      ],
      constraints: [{ kind: 'coincident', id: 'c.1', a: 'p 1', b: 'λ' }],
      params: {},
    };
    expect(parseSketch(serializeSketch(sketch))).toEqual({ ok: true, sketch });
  });

  it('keeps an optional operand only when the file carries it', () => {
    const sketch = {
      entities: [{ kind: 'line', id: 'e1', p1: 'p1', p2: 'p2' }],
      constraints: [
        { kind: 'horizontal', id: 'c1', a: 'e1' },
        { kind: 'horizontal', id: 'c2', a: 'p1', b: 'p2' },
      ],
      params: {},
    };
    const result = parseSketch(file(sketch));
    expect(result).toEqual({ ok: true, sketch });
    if (!result.ok) return;
    expect(result.sketch.constraints[0]).not.toHaveProperty('b');
    expect(result.sketch.constraints[1]).toHaveProperty('b', 'p2');
  });

  it('keeps the construction flag only when the file carries it', () => {
    const sketch = {
      entities: [
        { kind: 'line', id: 'e1', p1: 'p1', p2: 'p2' },
        { kind: 'line', id: 'e2', p1: 'p1', p2: 'p2', construction: false },
        { kind: 'circle', id: 'e3', center: 'p1', radius: 5, construction: true },
        { kind: 'arc', id: 'e4', center: 'p1', start: 'p1', end: 'p2' },
      ],
      constraints: [],
      params: {},
    };
    const result = parseSketch(file(sketch));
    expect(result).toEqual({ ok: true, sketch });
    if (!result.ok) return;
    expect(result.sketch.entities[0]).not.toHaveProperty('construction');
    expect(result.sketch.entities[1]).toHaveProperty('construction', false);
    expect(result.sketch.entities[2]).toHaveProperty('construction', true);
    expect(result.sketch.entities[3]).not.toHaveProperty('construction');
  });

  it('keeps a dimension value that names a parameter', () => {
    const sketch = {
      entities: [],
      constraints: [{ kind: 'distance', id: 'c1', a: 'e1', b: 'e2', value: 'gap', placement: 18 }],
      params: { gap: 24 },
    };
    expect(parseSketch(file(sketch))).toEqual({ ok: true, sketch });
  });
});

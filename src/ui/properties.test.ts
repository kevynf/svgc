import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { indexEntities } from '../core/sketch';
import type { Constraint, Entity } from '../core/model';
import type { Sketch } from '../core/sketch';
import { Translator } from '../i18n/i18n';
import { Names } from './names';
import {
  buildModel,
  constructionState,
  entityFields,
  findField,
  parseNumber,
  screenAngle,
  screenDeg,
  selectionBounds,
} from './properties-model';
import type { ModelContext } from './properties-model';

const t = new Translator('en');

/** A fixed point, a line to the upper right, a construction circle, an arc and two parameters. */
function testSketch(): Sketch {
  const b = new SketchBuilder().param('w', 50).param('gap', 25);
  const a = b.point(0, 0);
  b.fix(a);
  const c = b.point(100, -100);
  const line = b.line(a, c);
  b.constrain({ kind: 'horizontal', a: line });
  const center = b.point(200, 50);
  const circle = b.circle(center, 30, { construction: true });
  b.constrain({ kind: 'radius', curve: circle, value: 'w' });
  const arcCenter = b.point(400, 50);
  const arcStart = b.point(450, 50);
  const arcEnd = b.point(400, 100);
  b.arc(arcCenter, arcStart, arcEnd);
  return b.build();
}

const sketch = testSketch();
const only = (kind: Entity['kind']): Entity => {
  const found = sketch.entities.find((e) => e.kind === kind);
  if (found === undefined) throw new Error(`No ${kind} in the test sketch`);
  return found;
};
const line = only('line') as Extract<Entity, { kind: 'line' }>;
const circle = only('circle') as Extract<Entity, { kind: 'circle' }>;
const arc = only('arc') as Extract<Entity, { kind: 'arc' }>;
const origin = only('point') as Extract<Entity, { kind: 'point' }>;
const constraint = (kind: Constraint['kind']): Constraint => {
  const found = sketch.constraints.find((c) => c.kind === kind);
  if (found === undefined) throw new Error(`No ${kind} constraint in the test sketch`);
  return found;
};
const horizontal = constraint('horizontal');
const radius = constraint('radius');

function context(selection: readonly string[], statuses: Readonly<Record<string, 'fully' | 'under'>> = {}): ModelContext {
  return {
    sketch,
    selection: new Set(selection),
    status: new Map(Object.entries(statuses)),
    solve: { outcome: 'solved', sketch, dof: 2, conflicting: [], redundant: [], partiallyRedundant: [] },
    names: new Names(sketch, t),
    t,
  };
}

const field = (entity: Entity, suffix: string) => {
  const fields = entityFields(entity, indexEntities(sketch), t);
  const found = fields.find((f) => f.key.endsWith(`.${suffix}`));
  if (found === undefined) throw new Error(`No field "${suffix}" in ${fields.map((f) => f.key).join(', ')}`);
  return found;
};

describe('screenAngle', () => {
  it('measures counterclockwise on screen, with Y pointing down', () => {
    expect(screenAngle(100, -100)).toBe(45);
    expect(screenAngle(100, 100)).toBe(-45);
    expect(screenAngle(1, 0)).toBe(0);
    expect(screenAngle(0, -1)).toBe(90);
    expect(screenAngle(0, 1)).toBe(-90);
    expect(screenAngle(-1, 0)).toBe(-180);
  });

  it('normalizes polar angles to a full turn', () => {
    expect(screenDeg(0)).toBe(0);
    expect(screenDeg(-Math.PI / 2)).toBe(90);
    expect(screenDeg(Math.PI / 2)).toBe(270);
    expect(screenDeg(Math.PI)).toBe(180);
  });
});

describe('entityFields', () => {
  it('edits both ends of a line and reads back its length and angle', () => {
    const fields = entityFields(line, indexEntities(sketch), t);
    expect(fields.map((f) => f.label)).toEqual(['Start X', 'Start Y', 'End X', 'End Y', 'Length', 'Angle']);
    expect(fields.map((f) => f.editable)).toEqual([true, true, true, true, false, false]);
    expect(fields[4]!.value).toBeCloseTo(Math.hypot(100, 100), 10);
    expect(fields[5]!.value).toBe(45);
    expect(fields[0]!.target).toEqual({ kind: 'point', point: line.p1, axis: 'x' });
    expect(fields[3]!.target).toEqual({ kind: 'point', point: line.p2, axis: 'y' });
  });

  it('edits a circle radius and derives the diameter', () => {
    const fields = entityFields(circle, indexEntities(sketch), t);
    expect(fields.map((f) => f.label)).toEqual(['Center X', 'Center Y', 'Radius', 'Diameter']);
    expect(fields[2]).toMatchObject({ editable: true, value: 30, target: { kind: 'radius', curve: circle.id } });
    expect(fields[3]).toMatchObject({ editable: false, value: 60 });
  });

  it('reads an arc radius, start angle and sweep from its three points', () => {
    const fields = entityFields(arc, indexEntities(sketch), t);
    expect(fields.map((f) => f.label)).toEqual(['Center X', 'Center Y', 'Radius', 'Start angle', 'Sweep']);
    expect(fields.slice(2).map((f) => f.editable)).toEqual([false, false, false]);
    expect(fields[2]!.value).toBe(50);
    expect(fields[3]!.value).toBe(0);
    expect(fields[4]!.value).toBe(90);
  });

  it('exposes point coordinates for editing', () => {
    const fields = entityFields(origin, indexEntities(sketch), t);
    expect(fields.map((f) => f.label)).toEqual(['X', 'Y']);
    expect(fields.every((f) => f.editable)).toBe(true);
  });
});

describe('selectionBounds', () => {
  it('is the common bounding box of the selected entities', () => {
    expect(selectionBounds(sketch, [line.id, circle.id])).toEqual({ x: 0, y: -100, width: 230, height: 180 });
  });

  it('is exact for arcs, including the axis crossings inside the sweep', () => {
    // Quarter arc centered at (400, 50) from (450, 50) to (400, 100).
    expect(selectionBounds(sketch, [arc.id])).toEqual({ x: 400, y: 50, width: 50, height: 50 });
  });

  it('is undefined for an empty selection', () => {
    expect(selectionBounds(sketch, [])).toBeUndefined();
  });
});

describe('constructionState', () => {
  it('reports on, off and mixed selections', () => {
    expect(constructionState([line, arc])).toBe('off');
    expect(constructionState([circle])).toBe('on');
    expect(constructionState([line, circle])).toBe('mixed');
    expect(constructionState([origin])).toBe('off');
  });
});

describe('parseNumber', () => {
  it('evaluates arithmetic, units and parameters', () => {
    expect(parseNumber('10*2', {})).toEqual({ ok: true, value: 20 });
    expect(parseNumber('25.4mm', {})).toEqual({ ok: true, value: 96 });
    expect(parseNumber('w*2', { w: 50 })).toEqual({ ok: true, value: 100 });
    expect(parseNumber(' 40 ', {})).toEqual({ ok: true, value: 40 });
  });

  it('accepts full-width digits and operators', () => {
    expect(parseNumber('１０＊２', {})).toEqual({ ok: true, value: 20 });
  });

  it('rejects empty, unknown and malformed input', () => {
    expect(parseNumber('', {})).toMatchObject({ ok: false });
    expect(parseNumber('1+', {})).toMatchObject({ ok: false });
    expect(parseNumber('nope', {})).toMatchObject({ ok: false });
    expect(parseNumber('w*2', {})).toMatchObject({ ok: false });
  });
});

describe('buildModel', () => {
  it('summarizes the sketch when nothing is selected', () => {
    const model = buildModel(context([]));
    expect(model.title).toBe('Properties');
    expect(model.status).toBeUndefined();
    const [summary, params] = model.sections;
    expect(summary).toMatchObject({ kind: 'rows', title: 'Sketch' });
    expect(params).toMatchObject({ kind: 'rows', title: 'Parameters' });
    const rows = (section: (typeof model.sections)[number] | undefined, kind: string) =>
      section?.kind === kind && section.kind === 'rows' ? section.rows.map((r) => [r.label, r.text]) : undefined;
    expect(rows(summary, 'rows')).toEqual([
      ['Point', '6'],
      ['Line', '1'],
      ['Circle', '1'],
      ['Arc', '1'],
      ['Constraints', '3'],
      ['State', '2 dimensions needed'],
    ]);
    expect(rows(params, 'rows')).toEqual([
      ['w', '50.00'],
      ['gap', '25.00'],
    ]);
  });

  it('shows one entity with its status badge and its constraints', () => {
    const model = buildModel(context([line.id], { [line.id]: 'under' }));
    expect(model.title).toBe('Line1');
    expect(model.status).toBe('under');
    const [fields, construction, items] = model.sections;
    expect(fields).toMatchObject({ kind: 'fields', title: 'Line1' });
    expect(construction).toEqual({ kind: 'construction', title: 'Construction', curves: [line.id], state: 'off' });
    expect(items).toMatchObject({ kind: 'items', title: 'Constraints' });
    expect(items?.kind === 'items' && items.items.map((i) => i.name)).toEqual(['Horizontal (Line1)']);
    expect(items?.kind === 'items' && items.items[0]?.glyph).toBe('horizontal');
  });

  it('reports a fully constrained entity and offers the construction toggle', () => {
    const model = buildModel(context([circle.id], { [circle.id]: 'fully' }));
    expect(model.status).toBe('fully');
    expect(model.sections.filter((s) => s.kind === 'construction')).toHaveLength(1);
    expect(model.title).toBe('Circle1 (construction)');
  });

  it('omits the construction toggle for a point', () => {
    const model = buildModel(context([origin.id]));
    expect(model.sections.some((s) => s.kind === 'construction')).toBe(false);
  });

  it('counts a multi-selection and shows its bounds and mixed construction', () => {
    const model = buildModel(context([line.id, circle.id]));
    expect(model.title).toBe('2 objects selected');
    const [construction, bounds] = model.sections;
    expect(construction).toMatchObject({ kind: 'construction', state: 'mixed' });
    expect(construction?.kind === 'construction' && construction.curves).toEqual([line.id, circle.id]);
    expect(bounds?.kind === 'rows' && bounds.rows.map((r) => [r.label, r.text])).toEqual([
      ['X', '0.00'],
      ['Y', '-100.00'],
      ['Width', '230.00'],
      ['Height', '180.00'],
    ]);
  });

  it('lists every constraint that references the selected entity', () => {
    const model = buildModel(context([origin.id]));
    const items = model.sections.find((s) => s.kind === 'items');
    expect(items?.kind === 'items' && items.items.map((i) => i.name)).toEqual(['Fix (Point1)']);
  });
});

describe('findField', () => {
  it('finds a field of the current selection by its key', () => {
    const model = buildModel(context([circle.id]));
    expect(findField(model, `${circle.id}.radius`)).toMatchObject({ editable: true, value: 30 });
    expect(findField(model, `${circle.id}.diameter`)).toMatchObject({ editable: false });
    expect(findField(model, 'missing')).toBeUndefined();
  });

  it('exposes the field the caller asked for', () => {
    expect(field(line, 'angle')).toMatchObject({ editable: false, value: 45 });
    expect(field(circle, 'radius')).toMatchObject({ editable: true, target: { kind: 'radius', curve: circle.id } });
  });

  it('finds the value field of a selected dimension constraint', () => {
    const model = buildModel(context([radius.id]));
    expect(findField(model, `${radius.id}.value`)).toEqual({
      key: `${radius.id}.value`,
      label: 'Radius',
      value: 50,
      editable: true,
      target: { kind: 'constraintValue', constraint: radius.id },
    });
  });
});

describe('constraint selection', () => {
  it('edits a dimension constraint, resolving the parameter it is bound to', () => {
    const model = buildModel(context([radius.id]));
    // The title is the same string the browser shows for the constraint.
    expect(model.title).toBe('Radius (Circle1)');
    expect(model.status).toBeUndefined();
    expect(model.sections).toHaveLength(1);
    const [section] = model.sections;
    expect(section).toMatchObject({ kind: 'fields', title: 'Radius' });
    expect(section?.kind === 'fields' && section.fields).toEqual([
      {
        key: `${radius.id}.value`,
        label: 'Radius',
        // `value: 'w'` and params `w` = 50.
        value: 50,
        editable: true,
        target: { kind: 'constraintValue', constraint: radius.id },
      },
    ]);
  });

  it('shows nothing to edit for a constraint without a value', () => {
    const model = buildModel(context([horizontal.id]));
    expect(model.title).toBe('Horizontal (Line1)');
    expect(model.status).toBeUndefined();
    expect(model.sections).toEqual([]);
    expect(findField(model, `${horizontal.id}.value`)).toBeUndefined();
  });

  it('lists two constraints as read-only rows, with no text for a valueless one', () => {
    const model = buildModel(context([horizontal.id, radius.id]));
    expect(model.title).toBe('2 objects selected');
    const [section] = model.sections;
    expect(section).toMatchObject({ kind: 'rows', title: 'Constraints' });
    // Rows carry no target, so unlike a field they can never be edited.
    expect(section?.kind === 'rows' && section.rows.map((r) => [r.key, r.label, r.text])).toEqual([
      [`${horizontal.id}.value`, 'Horizontal (Line1)', ''],
      [`${radius.id}.value`, 'Radius (Circle1)', '50.00'],
    ]);
  });

  it('keeps entity behaviour when an entity is selected', () => {
    const model = buildModel(context([circle.id]));
    const items = model.sections.find((s) => s.kind === 'items');
    expect(items?.kind === 'items' && items.items.map((i) => i.name)).toEqual(['Radius (Circle1)']);
    expect(findField(model, `${circle.id}.radius`)).toMatchObject({ editable: true, value: 30 });
  });
});

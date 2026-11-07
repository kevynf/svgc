import { constraintRefs, constraintValue } from '../core/edit';
import { evaluateSource } from '../core/expr';
import { arcParams, normalizeDeg, screenAngle } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Entity, EntityKind, Id, Point } from '../core/model';
import type { Constraint } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { EntityIndex, Sketch } from '../core/sketch';
import type { SolveResult } from '../solver/solver';
import type { EntityStatus } from '../solver/status';
import type { Key, Translator } from '../i18n/i18n';
import type { ConstraintGlyph } from './constraint-icons';
import type { Names } from './names';

const TAU = Math.PI * 2;

/** Kind -> message key of its plain (unnumbered) name. */
const KIND_LABEL: Record<EntityKind, Key> = {
  point: 'properties.point',
  line: 'properties.line',
  circle: 'properties.circle',
  arc: 'properties.arc',
};

/** What an editable field changes when the user commits a value. */
export type EditTarget =
  | { readonly kind: 'point'; readonly point: Id; readonly axis: 'x' | 'y' }
  | { readonly kind: 'radius'; readonly curve: Id }
  | { readonly kind: 'constraintValue'; readonly constraint: Id };

/** One value row: editable when it carries a target. */
export interface Field {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly editable: boolean;
  readonly target?: EditTarget;
}

/** One read-only "label — text" row. */
export interface Row {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  /** Identifiers such as parameter names are shown in the monospace face. */
  readonly mono?: boolean;
}

export interface ConstraintItem {
  readonly id: Id;
  readonly name: string;
  readonly glyph: ConstraintGlyph;
}

export type TriState = 'on' | 'off' | 'mixed';

export type Section =
  | { readonly kind: 'fields'; readonly title: string; readonly fields: readonly Field[] }
  | { readonly kind: 'rows'; readonly title: string; readonly rows: readonly Row[] }
  | { readonly kind: 'items'; readonly title: string; readonly items: readonly ConstraintItem[] }
  | {
      readonly kind: 'construction';
      readonly title: string;
      readonly curves: readonly Id[];
      readonly state: TriState;
    };

export interface PropertiesModel {
  /** Panel header text: the entity name, the selection count, or the sketch name. */
  readonly title: string;
  /** Constraint status of the selected entity, when exactly one is selected. */
  readonly status: EntityStatus | undefined;
  readonly sections: readonly Section[];
}

export interface ModelContext {
  readonly sketch: Sketch;
  readonly selection: ReadonlySet<Id>;
  readonly status: ReadonlyMap<Id, EntityStatus>;
  readonly solve: SolveResult;
  readonly names: Names;
  readonly t: Translator;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ParsedNumber =
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string };

// ── Angles ───────────────────────────────────────────────────────────────

/** The panel's readouts share the core angle convention; re-exported for its tests. */
export { screenAngle };

/** Polar angle in degrees, normalized to [0, 360). */
export function screenDeg(radians: number): number {
  return normalizeDeg((-radians * 180) / Math.PI);
}

// ── Fields ───────────────────────────────────────────────────────────────

function pointAt(index: EntityIndex, id: Id): Point | undefined {
  const entity = index.get(id);
  return entity?.kind === 'point' ? entity : undefined;
}

function coordinates(index: EntityIndex, id: Id, labels: readonly [x: string, y: string]): Field[] {
  const point = pointAt(index, id);
  if (point === undefined) return [];
  return [
    {
      key: `${id}.x`,
      label: labels[0],
      value: point.x,
      editable: true,
      target: { kind: 'point', point: id, axis: 'x' },
    },
    {
      key: `${id}.y`,
      label: labels[1],
      value: point.y,
      editable: true,
      target: { kind: 'point', point: id, axis: 'y' },
    },
  ];
}

function readout(key: string, label: string, value: number): Field[] {
  return [{ key, label, value, editable: false }];
}

/** Editable and read-only fields of one entity, in display order. */
export function entityFields(entity: Entity, index: EntityIndex, t: Translator): Field[] {
  switch (entity.kind) {
    case 'point':
      return coordinates(index, entity.id, [t.t('properties.x'), t.t('properties.y')]);
    case 'line': {
      const a = pointAt(index, entity.p1);
      const b = pointAt(index, entity.p2);
      const fields = [
        ...coordinates(index, entity.p1, [t.t('properties.startX'), t.t('properties.startY')]),
        ...coordinates(index, entity.p2, [t.t('properties.endX'), t.t('properties.endY')]),
      ];
      if (a === undefined || b === undefined) return fields;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      return [
        ...fields,
        ...readout(`${entity.id}.length`, t.t('properties.length'), Math.hypot(dx, dy)),
        ...readout(`${entity.id}.angle`, t.t('properties.angle'), screenAngle(dx, dy)),
      ];
    }
    case 'circle': {
      const radius: Field = {
        key: `${entity.id}.radius`,
        label: t.t('properties.radius'),
        value: entity.radius,
        editable: true,
        target: { kind: 'radius', curve: entity.id },
      };
      const fields = [
        ...coordinates(index, entity.center, [
          t.t('properties.centerX'),
          t.t('properties.centerY'),
        ]),
        radius,
      ];
      return [
        ...fields,
        ...readout(`${entity.id}.diameter`, t.t('properties.diameter'), entity.radius * 2),
      ];
    }
    case 'arc': {
      const center = pointAt(index, entity.center);
      const start = pointAt(index, entity.start);
      const end = pointAt(index, entity.end);
      const fields = coordinates(index, entity.center, [
        t.t('properties.centerX'),
        t.t('properties.centerY'),
      ]);
      if (center === undefined || start === undefined || end === undefined) return fields;
      const { radius, startAngle, endAngle } = arcParams(center, start, end);
      return [
        ...fields,
        ...readout(`${entity.id}.radius`, t.t('properties.radius'), radius),
        ...readout(`${entity.id}.startAngle`, t.t('properties.startAngle'), screenDeg(startAngle)),
        ...readout(
          `${entity.id}.sweep`,
          t.t('properties.sweep'),
          (endAngle - startAngle) * (180 / Math.PI),
        ),
      ];
    }
  }
}

export function findField(model: PropertiesModel, key: string): Field | undefined {
  for (const section of model.sections) {
    if (section.kind !== 'fields') continue;
    const field = section.fields.find((f) => f.key === key);
    if (field !== undefined) return field;
  }
  return undefined;
}

// ── Constraints and construction ─────────────────────────────────────────

export function constraintsOf(sketch: Sketch, id: Id): readonly Constraint[] {
  return sketch.constraints.filter((c) => constraintRefs(c).includes(id));
}

/** Tri-state of the construction flag over a set of curves; points are ignored. */
export function constructionState(curves: readonly Entity[]): TriState {
  const flags = curves.filter((e) => e.kind !== 'point').map((e) => e.construction === true);
  if (flags.length === 0) return 'off';
  if (flags.every((on) => on)) return 'on';
  return flags.some((on) => on) ? 'mixed' : 'off';
}

// ── Bounds ───────────────────────────────────────────────────────────────

interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function extentOf(points: readonly Vec2[]): Extent {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('Empty extent');
  let box: Extent = { minX: first.x, minY: first.y, maxX: first.x, maxY: first.y };
  for (const p of rest) {
    box = {
      minX: Math.min(box.minX, p.x),
      minY: Math.min(box.minY, p.y),
      maxX: Math.max(box.maxX, p.x),
      maxY: Math.max(box.maxY, p.y),
    };
  }
  return box;
}

/** Exact extent of a circular arc: its ends plus every axis crossing in the sweep. */
function arcExtent(center: Vec2, radius: number, startAngle: number, endAngle: number): Extent {
  const points = [
    { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) },
    { x: center.x + radius * Math.cos(endAngle), y: center.y + radius * Math.sin(endAngle) },
  ];
  for (const axis of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    let angle = axis;
    while (angle < startAngle) angle += TAU;
    if (angle > endAngle) continue;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return extentOf(points);
}

function entityExtent(entity: Entity, index: EntityIndex): Extent | undefined {
  switch (entity.kind) {
    case 'point':
      return { minX: entity.x, minY: entity.y, maxX: entity.x, maxY: entity.y };
    case 'line': {
      const a = pointAt(index, entity.p1);
      const b = pointAt(index, entity.p2);
      return a === undefined || b === undefined ? undefined : extentOf([a, b]);
    }
    case 'circle': {
      const center = pointAt(index, entity.center);
      return center === undefined
        ? undefined
        : {
            minX: center.x - entity.radius,
            minY: center.y - entity.radius,
            maxX: center.x + entity.radius,
            maxY: center.y + entity.radius,
          };
    }
    case 'arc': {
      const center = pointAt(index, entity.center);
      const start = pointAt(index, entity.start);
      const end = pointAt(index, entity.end);
      if (center === undefined || start === undefined || end === undefined) return undefined;
      const { radius, startAngle, endAngle } = arcParams(center, start, end);
      return arcExtent(center, radius, startAngle, endAngle);
    }
  }
}

/** Common bounding box of the given entities, or undefined when none of them exists. */
export function selectionBounds(sketch: Sketch, ids: Iterable<Id>): Bounds | undefined {
  const index = indexEntities(sketch);
  let box: Extent | undefined;
  for (const id of ids) {
    const entity = index.get(id);
    if (entity === undefined) continue;
    const extent = entityExtent(entity, index);
    if (extent === undefined) continue;
    box =
      box === undefined
        ? extent
        : {
            minX: Math.min(box.minX, extent.minX),
            minY: Math.min(box.minY, extent.minY),
            maxX: Math.max(box.maxX, extent.maxX),
            maxY: Math.max(box.maxY, extent.maxY),
          };
  }
  return box === undefined
    ? undefined
    : { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

// ── Input ────────────────────────────────────────────────────────────────

/**
 * Evaluates what the user typed in a field: `10*2`, `25.4mm`, full-width
 * digits and parameter names all resolve against the sketch's parameters.
 */
export function parseNumber(
  source: string,
  params: Readonly<Record<string, number>>,
): ParsedNumber {
  const text = source.trim();
  if (text === '') return { ok: false, error: 'Empty expression' };
  try {
    return { ok: true, value: evaluateSource(text, (name) => params[name]) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Model ────────────────────────────────────────────────────────────────

/** Constraint state of the whole sketch, worded exactly like the status bar. */
function stateText(solve: SolveResult, t: Translator): string {
  if (solve.conflicting.length > 0)
    return t.t('status.conflicting', { count: solve.conflicting.length });
  if (solve.outcome === 'failed') return t.t('status.solveFailed');
  if (solve.dof === 0) return t.t('status.fullyConstrained');
  return t.t('status.dimensionsNeeded', { count: solve.dof });
}

function sketchSummary({ sketch, solve, t }: ModelContext): PropertiesModel {
  const rows: Row[] = [];
  for (const kind of ['point', 'line', 'circle', 'arc'] as const) {
    const count = sketch.entities.filter((e) => e.kind === kind).length;
    if (count > 0)
      rows.push({ key: `count.${kind}`, label: t.t(KIND_LABEL[kind]), text: t.number(count, 0) });
  }
  rows.push({
    key: 'count.constraints',
    label: t.t('browser.constraints'),
    text: t.number(sketch.constraints.length, 0),
  });
  rows.push({ key: 'state', label: t.t('properties.status'), text: stateText(solve, t) });
  const params: Row[] = Object.entries(sketch.params).map(([name, value]) => ({
    key: `param.${name}`,
    label: name,
    text: t.number(value, 2),
    mono: true,
  }));
  return {
    title: t.t('properties.label'),
    status: undefined,
    sections: [
      { kind: 'rows', title: t.t('properties.sketch'), rows },
      { kind: 'rows', title: t.t('properties.params'), rows: params },
    ],
  };
}

function singleEntity(entity: Entity, ctx: ModelContext): PropertiesModel {
  const { sketch, status, names, t } = ctx;
  const sections: Section[] = [
    {
      kind: 'fields',
      title: names.entity(entity.id),
      fields: entityFields(entity, indexEntities(sketch), t),
    },
  ];
  if (entity.kind !== 'point') {
    sections.push({
      kind: 'construction',
      title: t.t('properties.construction'),
      curves: [entity.id],
      state: constructionState([entity]),
    });
  }
  sections.push({
    kind: 'items',
    title: t.t('browser.constraints'),
    items: constraintsOf(sketch, entity.id).map((c) => ({
      id: c.id,
      name: names.constraint(c),
      glyph: c.kind,
    })),
  });
  return { title: names.entity(entity.id), status: status.get(entity.id), sections };
}

function multipleEntities(selected: readonly Entity[], ctx: ModelContext): PropertiesModel {
  const { sketch, selection, t } = ctx;
  const curves = selected.filter((e) => e.kind !== 'point');
  const bounds = selectionBounds(sketch, selection);
  const sections: Section[] = [];
  if (curves.length > 0) {
    sections.push({
      kind: 'construction',
      title: t.t('properties.construction'),
      curves: curves.map((e) => e.id),
      state: constructionState(curves),
    });
  }
  const boundsRows: Row[] =
    bounds === undefined
      ? []
      : [
          { key: 'bounds.x', label: t.t('properties.x'), text: t.number(bounds.x) },
          { key: 'bounds.y', label: t.t('properties.y'), text: t.number(bounds.y) },
          { key: 'bounds.width', label: t.t('properties.width'), text: t.number(bounds.width) },
          { key: 'bounds.height', label: t.t('properties.height'), text: t.number(bounds.height) },
        ];
  sections.push({ kind: 'rows', title: t.t('properties.bounds'), rows: boundsRows });
  return {
    title: t.t('properties.selected', { count: selected.length }),
    status: undefined,
    sections,
  };
}

/** One selected constraint: a dimension gets an editable value, the rest just a name. */
function singleConstraint(c: Constraint, ctx: ModelContext): PropertiesModel {
  const { sketch, names, t } = ctx;
  const label = t.t(`constraints.${c.kind}`);
  const value = constraintValue(c, sketch.params);
  const sections: Section[] =
    value === undefined
      ? // Non-dimension constraints (coincident, horizontal, …) have nothing to edit.
        []
      : [
          {
            kind: 'fields',
            title: label,
            fields: [
              {
                key: `${c.id}.value`,
                label,
                value,
                editable: true,
                target: { kind: 'constraintValue', constraint: c.id },
              },
            ],
          },
        ];
  // Constraint status is tracked per entity, not per constraint, so there is no badge.
  return { title: names.constraint(c), status: undefined, sections };
}

function multipleConstraints(
  constraints: readonly Constraint[],
  ctx: ModelContext,
): PropertiesModel {
  const { sketch, names, t } = ctx;
  const rows: Row[] = constraints.map((c) => {
    const value = constraintValue(c, sketch.params);
    return {
      key: `${c.id}.value`,
      label: names.constraint(c),
      // Empty rather than a dash: a non-dimension constraint simply has no value.
      text: value === undefined ? '' : t.number(value, 2),
    };
  });
  return {
    title: t.t('properties.selected', { count: constraints.length }),
    status: undefined,
    sections: [{ kind: 'rows', title: t.t('browser.constraints'), rows }],
  };
}

/** Everything the properties panel shows for the current selection. */
export function buildModel(ctx: ModelContext): PropertiesModel {
  const { sketch, selection } = ctx;
  const selected = sketch.entities.filter((e) => selection.has(e.id));
  const constraints = sketch.constraints.filter((c) => selection.has(c.id));
  // A mixed entity+constraint selection keeps the entity behaviour: entities win,
  // and constraints only get their own panel when they are the whole selection.
  if (selected.length === 1) return singleEntity(selected[0]!, ctx);
  if (selected.length > 1) return multipleEntities(selected, ctx);
  if (constraints.length === 1) return singleConstraint(constraints[0]!, ctx);
  if (constraints.length > 1) return multipleConstraints(constraints, ctx);
  return sketchSummary(ctx);
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { arcParams, directionDeg, distance, lineAngleDeg, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Constraint, Id } from '../../core/model';
import { emptySketch, indexEntities } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { dimensionLayout, layoutDimension } from '../../render/dimensions';
import type { DimensionLayout, DimensionSpec } from '../../render/dimensions';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { OverlayShape, PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import type { Operand } from './constrain';
import { DimensionCommand } from './dimension';
import { SelectCommand } from './select';

let solver: Solver;

beforeAll(async () => {
  solver = await createSolver();
});

afterAll(() => {
  solver.dispose();
});

const commands = new Map<string, CommandFactory>([
  ['select', (e) => new SelectCommand(e)],
  ['dimension', (e) => new DimensionCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch(), dimension: CommandFactory = (e) => new DimensionCommand(e)): Editor {
  const editor = new Editor(solver, sketch, new Map([...commands, ['dimension', dimension]]), 'select');
  editor.viewport.resize(800, 600);
  return editor;
}

function at(x: number, y: number): PointerInput {
  return { screen: { x, y }, world: { x, y }, shift: false, ctrl: false, alt: false };
}

function click(editor: Editor, x: number, y: number): void {
  const input = at(x, y);
  editor.activeCommand.pointerMove?.(input);
  editor.activeCommand.pointerDown?.(input);
  editor.activeCommand.pointerUp?.(input);
}

/** Where a point currently sits; the solver may have moved it since it was built. */
function pointOf(editor: Editor, id: Id): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'point') throw new Error(`"${id}" is not a point`);
  return { x: e.x, y: e.y };
}

/** A point on the middle of a line, or on the rim of a circle or arc. */
function onCurve(editor: Editor, id: Id): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  const pt = (p: Id) => pointOf(editor, p);
  if (e?.kind === 'line') {
    const [a, b] = [pt(e.p1), pt(e.p2)];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (e?.kind === 'circle') {
    const c = pt(e.center);
    return { x: c.x + e.radius, y: c.y };
  }
  if (e?.kind === 'arc') {
    const c = pt(e.center);
    const { radius, startAngle, endAngle } = arcParams(c, pt(e.start), pt(e.end));
    const a = (startAngle + endAngle) / 2;
    return { x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) };
  }
  throw new Error(`"${id}" is not a curve`);
}

function clickEntity(editor: Editor, id: Id): void {
  const p = pointOf(editor, id);
  click(editor, p.x, p.y);
}

function clickCurve(editor: Editor, id: Id): void {
  const p = onCurve(editor, id);
  click(editor, p.x, p.y);
}

/**
 * A dimension command handed its picks by the test. A zero-length line can
 * never be clicked — the point at the same spot always wins the hit test — so
 * such a pick is delivered the way a clicked one is.
 */
class Handed extends DimensionCommand {
  /** Picks `operand`, exactly as a click on it would. */
  hand(operand: Operand): void {
    const picks = [...this.picks, operand];
    const constraint = this.build(picks);
    // An operand the command cannot dimension from leaves the pick pending.
    if (constraint === undefined) {
      this.picks = picks;
      this.editor.viewChanged();
      return;
    }
    this.complete(constraint);
  }
}

/** Hands the active dimension command a pick, as a click on the entity would. */
function hand(editor: Editor, operand: Operand): void {
  (editor.activeCommand as Handed).hand(operand);
}

const kinds = (s: Sketch) => s.constraints.map((c) => c.kind);

function last(editor: Editor): Constraint {
  const all = editor.sketch.constraints;
  const c = all[all.length - 1];
  if (c === undefined) throw new Error('no constraint was added');
  return c;
}

/** Every point's position, so a dimension can be proven to have moved nothing. */
function snapshot(editor: Editor): Map<Id, Vec2> {
  const points = new Map<Id, Vec2>();
  for (const e of editor.sketch.entities) {
    if (e.kind === 'point') points.set(e.id, { x: e.x, y: e.y });
  }
  return points;
}

function expectUnmoved(editor: Editor, before: Map<Id, Vec2>): void {
  for (const [id, was] of before) {
    const now = pointOf(editor, id);
    expect(now.x).toBeCloseTo(was.x, 6);
    expect(now.y).toBeCloseTo(was.y, 6);
  }
}

/** The entities a command is highlighting, e.g. the operands it has picked. */
function highlightIds(editor: Editor): readonly Id[] {
  type Highlight = Extract<OverlayShape, { kind: 'highlight' }>;
  const shape = (editor.activeCommand.overlay?.() ?? []).find((s): s is Highlight => s.kind === 'highlight');
  return shape?.ids ?? [];
}

function radiusOf(editor: Editor, id: Id): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind === 'circle') return e.radius;
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not a curve`);
  return arcParams(pointOf(editor, e.center), pointOf(editor, e.start), pointOf(editor, e.end)).radius;
}

/** The dimension shape a command is drawing, or undefined when it draws none. */
type DimensionShape = Extract<OverlayShape, { kind: 'dimension' }>;

function dimensionShape(editor: Editor): DimensionShape | undefined {
  const shapes = editor.activeCommand.overlay?.() ?? [];
  return shapes.find((s): s is DimensionShape => s.kind === 'dimension');
}

/** A click that places the dimension at a world point. */
function place(editor: Editor, x: number, y: number): void {
  editor.activeCommand.pointerUp?.(at(x, y));
}

/** Applies what the user typed in the value box; false keeps it open. */
function commitEdit(editor: Editor, text: string, edited: boolean): boolean {
  return editor.activeCommand.commitEdit?.(text, edited) ?? false;
}

/** Places the dimension and accepts the measurement untouched. */
function acceptMeasurement(editor: Editor, x: number, y: number): void {
  place(editor, x, y);
  expect(commitEdit(editor, '', false)).toBe(true);
}

/** Layout of a committed dimension, failing loudly when it has none. */
function layoutOf(constraint: Constraint, sketch: Sketch, scale = 1): DimensionLayout {
  const layout = dimensionLayout(constraint, indexEntities(sketch), scale);
  if (layout === undefined) throw new Error(`no layout for a ${constraint.kind} constraint`);
  return layout;
}

/** Layout of a dimension spec, failing loudly when the geometry cannot carry one. */
function specLayout(spec: DimensionSpec, sketch: Sketch, scale = 1): DimensionLayout {
  const layout = layoutDimension(spec, indexEntities(sketch), scale);
  if (layout === undefined) throw new Error(`no layout for a ${spec.kind} spec`);
  return layout;
}

describe('dimension', () => {
  it('asks for an object, then for the second one', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    clickEntity(editor, p1);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
    // The rubber band starts on the picked operand and ends on the cursor.
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [p1] },
      { kind: 'previewLine', from: pointOf(editor, p1), to: pointOf(editor, p1) },
    ]);
  });

  it('draws a rubber band from the first operand to the cursor', () => {
    const b = new SketchBuilder();
    const p = b.point(20, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p);
    editor.activeCommand.pointerMove?.(at(70, 90));
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [p] },
      { kind: 'previewLine', from: pointOf(editor, p), to: { x: 70, y: 90 } },
    ]);
  });

  it('dimensions a line with its length, on the one pick it takes', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(60, 30);
    const line = b.line(a, c);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, line);
    const value = distance(pointOf(editor, a), pointOf(editor, c));
    // A line is its own dimension, so no second operand is asked for; the hint
    // says a second line would turn it into the angle between the two.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionPlaceLine' });
    expect(editor.activeCommand.edit).toBeUndefined();
    // It is measured end to end, so the dimension runs parallel to the line.
    expect(highlightIds(editor)).toEqual([a, c]);
    expect(dimensionShape(editor)?.radius).toBe(false);
    expect(dimensionShape(editor)?.value).toBe(value);
    // The length is only measured, as a radius is: nothing is committed yet.
    expect(editor.sketch.constraints).toEqual([]);
    expectUnmoved(editor, before);
  });

  it('follows the cursor with the line length, as it does with two points', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(60, 30);
    const line = b.line(a, c);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, line);
    const value = distance(pointOf(editor, a), pointOf(editor, c));
    const placed = dimensionShape(editor)?.layout.textAt;
    // The dimension hangs off the line while it follows the cursor, and the
    // measurement rides along with it.
    editor.activeCommand.pointerMove?.(at(-60, -60));
    expect(dimensionShape(editor)?.layout.textAt).not.toEqual(placed);
    expect(dimensionShape(editor)?.value).toBe(value);
  });

  it('applies the line length untouched, moving nothing', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(30, 40);
    const line = b.line(a, c);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, line);
    const value = distance(pointOf(editor, a), pointOf(editor, c));
    place(editor, 10, 90);
    const before = snapshot(editor);
    expect(commitEdit(editor, '', false)).toBe(true);
    // The dimension that lands is the distance between the line's two ends.
    expect(last(editor)).toMatchObject({ kind: 'distance', a, b: c, value });
    expectUnmoved(editor, before);
    expect(editor.activeCommand.id).toBe('dimension');
  });

  it('drives the line length to the typed value', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const line = b.line(a, c);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, line);
    place(editor, 50, 60);
    expect(commitEdit(editor, '60', true)).toBe(true);
    expect(distance(pointOf(editor, a), pointOf(editor, c))).toBeCloseTo(60, 9);
  });

  it('turns a second line into the angle between the two', () => {
    const b = new SketchBuilder();
    const v = b.point(100, 300);
    const end = b.point(160, 300);
    const tip = b.point(100, 240);
    const first = b.line(v, end);
    const second = b.line(v, tip);
    // Both ends of the first line are pinned, so the second line is the one the
    // solver moves when the angle is driven to a typed value.
    b.fix(v);
    b.fix(end);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    const expected = lineAngleDeg(pointOf(editor, v), pointOf(editor, end), pointOf(editor, v), pointOf(editor, tip));
    clickCurve(editor, first);
    // The length is pending, and the hint says a second line would take over.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionPlaceLine' });
    expect(dimensionShape(editor)?.value).toBe(distance(pointOf(editor, v), pointOf(editor, end)));
    // A second line turns it into the angle between the two, and the arc starts
    // following the cursor from where that line was clicked.
    const on = onCurve(editor, second);
    clickCurve(editor, second);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionPlace' });
    const shape = dimensionShape(editor);
    expect(shape?.layout.kind).toBe('angle');
    expect(shape?.layout).toEqual(specLayout({ kind: 'angle', operands: [first, second], placement: on }, editor.sketch));
    expect(shape?.value).toBe(expected);
    expect(highlightIds(editor)).toEqual([first, second]);
    editor.activeCommand.pointerMove?.(at(on.x + 40, on.y - 40));
    expect(dimensionShape(editor)?.layout.textAt).not.toEqual(shape?.layout.textAt);
    // Measuring an angle commits nothing, exactly as a length does not.
    expect(kinds(editor.sketch)).toEqual(['fix', 'fix']);
    expectUnmoved(editor, before);

    place(editor, on.x + 40, on.y - 40);
    expect(commitEdit(editor, '', false)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'angle', a: first, b: second, value: expected });
    expectUnmoved(editor, before);
    expect(editor.activeCommand.id).toBe('dimension');
  });

  it('drives a converted angle to the typed value', () => {
    const b = new SketchBuilder();
    const v = b.point(100, 300);
    const end = b.point(160, 300);
    const tip = b.point(100, 240);
    const first = b.line(v, end);
    const second = b.line(v, tip);
    b.fix(v);
    b.fix(end);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, first);
    clickCurve(editor, second);
    place(editor, 140, 260);
    expect(commitEdit(editor, '45', true)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'angle', a: first, b: second, value: 45 });
    // The pinned line held its direction, so the other one carries the angle.
    expect(directionDeg(pointOf(editor, v), pointOf(editor, tip))).toBeCloseTo(45, 6);
  });

  it('places the length when the click lands on the same line', () => {
    const b = new SketchBuilder();
    const v = b.point(100, 300);
    const end = b.point(160, 300);
    const first = b.line(v, end);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, first);
    // The same line is no second line, so the click places the length.
    clickCurve(editor, first);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionValue' });
    expect(commitEdit(editor, '', false)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: v, b: end, value: 60 });
  });

  it('places the length when the click lands on a curve', () => {
    const b = new SketchBuilder();
    const v = b.point(0, 0);
    const end = b.point(60, 0);
    const first = b.line(v, end);
    const w = b.point(0, 100);
    const far = b.point(60, 100);
    const other = b.line(w, far);
    const circle = b.circle(b.point(300, 0), 30);
    const arc = b.arc(b.point(300, 200), b.point(330, 200), b.point(300, 230));
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    // A curve is no second line, so the click places the length: a circle…
    clickCurve(editor, first);
    clickCurve(editor, circle);
    expect(commitEdit(editor, '', false)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: v, b: end });
    // …and an arc, on the next dimension.
    clickCurve(editor, other);
    clickCurve(editor, arc);
    expect(commitEdit(editor, '', false)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: w, b: far });
  });

  it('Esc backs out of a placement, converted or not', () => {
    const b = new SketchBuilder();
    const v = b.point(100, 300);
    const end = b.point(160, 300);
    const tip = b.point(100, 240);
    const first = b.line(v, end);
    const second = b.line(v, tip);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    // Esc while a line's length is being placed.
    clickCurve(editor, first);
    editor.escape();
    expect(editor.activeCommand.id).toBe('dimension');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.sketch.constraints).toEqual([]);
    // And again after the second line turned it into the angle.
    clickCurve(editor, first);
    clickCurve(editor, second);
    editor.escape();
    expect(editor.activeCommand.id).toBe('dimension');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.sketch.constraints).toEqual([]);
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });

  it('leaves a zero-length line pending', () => {
    const b = new SketchBuilder();
    const p = b.point(40, 40);
    const line = b.line(p, p);
    const editor = editorWith(b.build(), (e) => new Handed(e));
    editor.startCommand('dimension');
    hand(editor, { id: line, kind: 'line' });
    // A line with no length has no direction to lay a dimension along, so the
    // pick does not complete: it stays pending and the command waits for the
    // second operand, as it does for any pick it cannot dimension.
    expect(editor.sketch.constraints).toEqual([]);
    expect(dimensionShape(editor)).toBeUndefined();
    expect(editor.activeCommand.id).toBe('dimension');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
  });

  it('follows the cursor with the circle radius instead of committing it', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, circle);
    // The radius is measured, but nothing is committed until it is valued.
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionPlace' });
    const shape = dimensionShape(editor);
    expect(shape?.radius).toBe(true);
    expect(shape?.value).toBe(30);
    expectUnmoved(editor, before);
  });

  it('follows the cursor with the distance between two points', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    const value = distance(pointOf(editor, p1), pointOf(editor, p2));
    const shape = dimensionShape(editor);
    expect(shape?.value).toBe(value);
    expect(shape?.radius).toBe(false);
    const placed = shape?.layout.textAt;
    expect(Number.isFinite(placed?.x) && Number.isFinite(placed?.y)).toBe(true);
    // Moving the cursor moves the dimension with it.
    editor.activeCommand.pointerMove?.(at(-60, -60));
    expect(dimensionShape(editor)?.layout.textAt).not.toEqual(placed);
  });

  it('opens the value box where the dimension was placed', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    const value = distance(pointOf(editor, p1), pointOf(editor, p2));
    place(editor, 10, 90);
    expect(editor.activeCommand.edit).toEqual({
      at: specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 10, y: 90 } }, editor.sketch).textAt,
      value,
      label: { key: 'prompts.dimensionValue' },
    });
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionValue' });
    // The box carries the value, so the dimension stops drawing it.
    expect(dimensionShape(editor)?.value).toBeUndefined();
  });

  it('applies the measurement untouched, moving nothing', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    const value = distance(pointOf(editor, p1), pointOf(editor, p2));
    place(editor, 10, 90);
    const before = snapshot(editor);
    expect(commitEdit(editor, '', false)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: p1, b: p2, value });
    expectUnmoved(editor, before);
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.id).toBe('dimension');
  });

  it('drives the geometry to the typed value', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    place(editor, 50, 60);
    expect(commitEdit(editor, '50', true)).toBe(true);
    expect(distance(pointOf(editor, p1), pointOf(editor, p2))).toBeCloseTo(50, 9);
  });

  it('binds a parameter name, so the dimension tracks it', () => {
    const b = new SketchBuilder();
    b.param('corner', 12);
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    place(editor, 10, 90);
    expect(commitEdit(editor, 'corner', true)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: p1, b: p2, value: 'corner' });
    expect(distance(pointOf(editor, p1), pointOf(editor, p2))).toBeCloseTo(12, 9);
  });

  it('evaluates an expression', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    place(editor, 10, 90);
    expect(commitEdit(editor, '2*30', true)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', value: 60 });
    expect(distance(pointOf(editor, p1), pointOf(editor, p2))).toBeCloseTo(60, 9);
  });

  it('keeps the value box open on an unusable value', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    place(editor, 10, 90);
    expect(commitEdit(editor, 'abc', true)).toBe(false);
    expect(editor.sketch.constraints).toEqual([]);
    // The rejection surfaces as the command's prompt, as it does everywhere else.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'properties.invalid' });
    expect(editor.activeCommand.edit).toBeDefined();
  });

  it('rejects a second radius on the same circle', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    b.constrain({ kind: 'radius', curve: circle, value: 30 });
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, circle);
    place(editor, 120, 50);
    const before = snapshot(editor);
    expect(commitEdit(editor, '40', true)).toBe(false);
    expect(kinds(editor.sketch)).toEqual(['radius']);
    expectUnmoved(editor, before);
    expect(editor.activeCommand.edit).toBeDefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.conflict.radius' });
  });

  it('Esc backs out of the placement, then out of the command', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    editor.escape();
    // Back to picking, with the pending operand dropped and nothing committed.
    expect(editor.activeCommand.id).toBe('dimension');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.sketch.constraints).toEqual([]);
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });

  it('Esc in the value box goes back to placing', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    const value = distance(pointOf(editor, p1), pointOf(editor, p2));
    place(editor, 10, 90);
    editor.activeCommand.cancelEdit?.();
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionPlace' });
    // The operands are kept, and the dimension draws the measurement again.
    expect(dimensionShape(editor)?.value).toBe(value);
    expect(editor.sketch.constraints).toEqual([]);
  });

  it('keeps the placement the user chose', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    // Placed far below the segment it measures, not at the default offset.
    acceptMeasurement(editor, 50, 100);
    const added = last(editor);
    if (added.kind !== 'distance') throw new Error('not a distance');
    expect(added.value).toBe(100);
    expect(added.placement).toBeCloseTo(-100, 9);
    const layout = layoutOf(added, editor.sketch);
    const [a, c] = [pointOf(editor, p1), pointOf(editor, p2)];
    expect(perpendicularDistance(layout.textAt, a, c)).toBeCloseTo(100, 6);
  });

  it('drives the radius to the typed value', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, circle);
    place(editor, 120, 50);
    expect(commitEdit(editor, '12', true)).toBe(true);
    expect(radiusOf(editor, circle)).toBeCloseTo(12, 9);
  });

  it('places the dimension with Enter', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, circle);
    editor.activeCommand.pointerMove?.(at(120, 50));
    expect(editor.activeCommand.keyDown!({ key: 'Enter' } as unknown as KeyboardEvent)).toBe(true);
    // The box opens where the dimension was following the cursor.
    expect(editor.activeCommand.edit?.at).toEqual(
      specLayout({ kind: 'radius', operands: [circle], placement: { x: 120, y: 50 } }, editor.sketch).textAt,
    );
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionValue' });
  });

  it('dimensions an arc with the radius through its three points', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    const arc = b.arc(center, start, end);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, arc);
    acceptMeasurement(editor, 90, 90);
    const expected = arcParams(pointOf(editor, center), pointOf(editor, start), pointOf(editor, end)).radius;
    expect(last(editor)).toMatchObject({ kind: 'radius', curve: arc, value: expected });
    expectUnmoved(editor, before);
  });

  it('dimensions a point and a line with the distance between them', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const line = b.line(a, c);
    const p = b.point(20, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickEntity(editor, p);
    clickCurve(editor, line);
    acceptMeasurement(editor, 20, 90);
    const value = perpendicularDistance(pointOf(editor, p), pointOf(editor, a), pointOf(editor, c));
    expect(last(editor)).toMatchObject({ kind: 'distance', a: p, b: line, value });
    expectUnmoved(editor, before);
  });

  it('rejects a curve as the second operand', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const circle = b.circle(b.point(50, 50), 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p);
    clickCurve(editor, circle);
    expect(editor.sketch.constraints).toEqual([]);
    // The rejection surfaces as the command's prompt, as it does for every
    // other constraint command.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
  });

  it('stays active and starts a fresh dimension after one is applied', () => {
    const b = new SketchBuilder();
    const circle = b.circle(b.point(50, 50), 30);
    const p = b.point(-50, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, circle);
    acceptMeasurement(editor, 120, 50);
    expect(editor.activeCommand.id).toBe('dimension');
    clickEntity(editor, p);
    expect(kinds(editor.sketch)).toEqual(['radius']);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [p] },
      { kind: 'previewLine', from: pointOf(editor, p), to: pointOf(editor, p) },
    ]);
  });

  it('Esc backs out of the pending operand, then ends the command', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    editor.escape();
    expect(editor.activeCommand.id).toBe('dimension');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.sketch.constraints).toEqual([]);
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });
});

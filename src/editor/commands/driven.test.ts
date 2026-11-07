import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { arcParams, distance, lineAngleDeg, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Constraint, Id } from '../../core/model';
import { emptySketch, indexEntities } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { dimensionLayout } from '../../render/dimensions';
import type { DimensionLayout } from '../../render/dimensions';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { OverlayShape, PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import type { Operand } from './constrain';
import { DimensionCommand } from './dimension';
import { DrivenDimensionCommand } from './driven';
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
  ['driven', (e) => new DrivenDimensionCommand(e)],
  // The driving dimension, for the degrees of freedom a driven one leaves alone.
  ['dimension', (e) => new DimensionCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch(), driven: CommandFactory = (e) => new DrivenDimensionCommand(e)): Editor {
  const editor = new Editor(solver, sketch, new Map([...commands, ['driven', driven]]), 'select');
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
 * A driven dimension command handed its picks by the test. The angle between
 * two lines is the one dimension no click can reach here: a line completes on
 * its own first pick, and a driven dimension has no second line to convert that
 * length into an angle — so such a pick is delivered the way a click would.
 */
class Handed extends DrivenDimensionCommand {
  /** Picks `operands` together, exactly as consecutive clicks on them would. */
  hand(...operands: Operand[]): void {
    const picks = [...this.picks, ...operands];
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

/** Hands the active driven dimension command a pick, as a click on the entity would. */
function hand(editor: Editor, ...operands: Operand[]): void {
  (editor.activeCommand as Handed).hand(...operands);
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

/** The dimension shape a command is drawing, or undefined when it draws none. */
type DimensionShape = Extract<OverlayShape, { kind: 'dimension' }>;

function dimensionShape(editor: Editor): DimensionShape | undefined {
  const shapes = editor.activeCommand.overlay?.() ?? [];
  return shapes.find((s): s is DimensionShape => s.kind === 'dimension');
}

/** A click that places the dimension at a world point, which commits it. */
function place(editor: Editor, x: number, y: number): void {
  editor.activeCommand.pointerUp?.(at(x, y));
}

/** Layout of a committed dimension, failing loudly when it has none. */
function layoutOf(constraint: Constraint, sketch: Sketch, scale = 1): DimensionLayout {
  const layout = dimensionLayout(constraint, indexEntities(sketch), scale);
  if (layout === undefined) throw new Error(`no layout for a ${constraint.kind} constraint`);
  return layout;
}

describe('driven', () => {
  it('asks for an object, then for the second one', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    clickEntity(editor, p1);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
    // While a pick is pending there is no dimension to follow the cursor yet,
    // so the operands picked so far are all it highlights.
    expect(editor.activeCommand.overlay?.()).toEqual([{ kind: 'highlight', ids: [p1] }]);
  });

  it('measures two points and constrains nothing', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    const before = snapshot(editor);
    const dof = editor.solve.dof;
    const value = distance(pointOf(editor, p1), pointOf(editor, p2));
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    // Nothing is committed until the click that places it.
    expect(editor.sketch.constraints).toEqual([]);
    place(editor, 10, 90);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: p1, b: p2, value, driven: true });
    // Measured and drawn, never enforced: the sketch is exactly as free as it
    // was, and nothing moved to make room for the dimension.
    expect(editor.solve.dof).toBe(dof);
    expectUnmoved(editor, before);
    expect(editor.activeCommand.id).toBe('driven');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
  });

  it('measures a point and a line with the distance between them', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const line = b.line(a, c);
    const p = b.point(20, 30);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    const before = snapshot(editor);
    const dof = editor.solve.dof;
    clickEntity(editor, p);
    clickCurve(editor, line);
    place(editor, 20, 90);
    const value = perpendicularDistance(pointOf(editor, p), pointOf(editor, a), pointOf(editor, c));
    // The point comes first, the order the solver's operands are read in.
    expect(last(editor)).toMatchObject({ kind: 'distance', a: p, b: line, value, driven: true });
    expect(editor.solve.dof).toBe(dof);
    expectUnmoved(editor, before);
  });

  it('measures two lines with the angle between them', () => {
    const b = new SketchBuilder();
    const v = b.point(100, 300);
    const end = b.point(160, 300);
    const tip = b.point(100, 240);
    const first = b.line(v, end);
    const second = b.line(v, tip);
    const editor = editorWith(b.build(), (e) => new Handed(e));
    editor.startCommand('driven');
    const before = snapshot(editor);
    const dof = editor.solve.dof;
    const expected = lineAngleDeg(pointOf(editor, v), pointOf(editor, end), pointOf(editor, v), pointOf(editor, tip));
    hand(editor, { id: first, kind: 'line' }, { id: second, kind: 'line' });
    expect(dimensionShape(editor)?.layout.kind).toBe('angle');
    expect(dimensionShape(editor)?.value).toBe(expected);
    place(editor, 140, 260);
    expect(last(editor)).toMatchObject({ kind: 'angle', a: first, b: second, value: expected, driven: true });
    expect(editor.solve.dof).toBe(dof);
    expectUnmoved(editor, before);
  });

  it('measures a circle with its radius', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    const before = snapshot(editor);
    const dof = editor.solve.dof;
    clickCurve(editor, circle);
    // The radius is measured, but nothing is committed until it is placed.
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.edit).toBeUndefined();
    place(editor, 120, 50);
    expect(last(editor)).toMatchObject({ kind: 'radius', curve: circle, value: 30, driven: true });
    expect(editor.solve.dof).toBe(dof);
    expectUnmoved(editor, before);
  });

  it('measures an arc with the radius through its three points', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    const arc = b.arc(center, start, end);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    const before = snapshot(editor);
    const dof = editor.solve.dof;
    clickCurve(editor, arc);
    place(editor, 90, 90);
    const expected = arcParams(pointOf(editor, center), pointOf(editor, start), pointOf(editor, end)).radius;
    expect(last(editor)).toMatchObject({ kind: 'radius', curve: arc, value: expected, driven: true });
    expect(editor.solve.dof).toBe(dof);
    expectUnmoved(editor, before);
  });

  it('keeps the placement the user chose', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    // Placed far below the segment it measures, not at the default offset.
    place(editor, 50, 100);
    const added = last(editor);
    if (added.kind !== 'distance') throw new Error('not a distance');
    expect(added.value).toBe(100);
    expect(added.placement).toBeCloseTo(-100, 9);
    const layout = layoutOf(added, editor.sketch);
    const [a, c] = [pointOf(editor, p1), pointOf(editor, p2)];
    expect(perpendicularDistance(layout.textAt, a, c)).toBeCloseTo(100, 6);
  });

  it('draws the measurement while the dimension follows the cursor', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    clickCurve(editor, circle);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionPlace' });
    const shape = dimensionShape(editor);
    expect(shape?.radius).toBe(true);
    // There is no value box to carry the measurement, so the dimension itself
    // draws it — and keeps drawing it once it is placed.
    expect(shape?.value).toBe(30);
    expect(highlightIds(editor)).toEqual([circle]);
    // The leader swings round to the cursor, so the value rides along with it.
    editor.activeCommand.pointerMove?.(at(50, 120));
    expect(dimensionShape(editor)?.layout.textAt).not.toEqual(shape?.layout.textAt);
    expect(dimensionShape(editor)?.value).toBe(30);
    place(editor, 120, 50);
    expect(dimensionShape(editor)).toBeUndefined();
  });

  it('places the dimension with Enter', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    clickCurve(editor, circle);
    editor.activeCommand.pointerMove?.(at(120, 50));
    expect(editor.activeCommand.keyDown!({ key: 'Enter' } as unknown as KeyboardEvent)).toBe(true);
    // Enter is the keyboard path to the click that places and commits.
    expect(last(editor)).toMatchObject({ kind: 'radius', curve: circle, value: 30, driven: true });
    expect(editor.sketch.constraints).toHaveLength(1);
    expect(editor.activeCommand.id).toBe('driven');
  });

  it('takes no notice of a dimension the sketch already carries', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    b.constrain({ kind: 'radius', curve: circle, value: 30 });
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    const dof = editor.solve.dof;
    clickCurve(editor, circle);
    place(editor, 120, 50);
    // The same measurement as a driving dimension would conflict with the one
    // already there; a driven one lowers to nothing, so the solver never sees it.
    expect(kinds(editor.sketch)).toEqual(['radius', 'radius']);
    expect(last(editor)).toMatchObject({ driven: true });
    expect(editor.solve.dof).toBe(dof);
  });

  it('leaves the sketch as free as it was, where the driving dimension does not', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);

    const driven = editorWith(b.build());
    driven.startCommand('driven');
    const free = driven.solve.dof;
    clickEntity(driven, p1);
    clickEntity(driven, p2);
    place(driven, 10, 90);
    expect(driven.solve.dof).toBe(free);

    // The same dimension, driven: it takes the degree of freedom the driven one
    // left alone, which is what makes that comparison mean something.
    const driving = editorWith(b.build());
    driving.startCommand('dimension');
    clickEntity(driving, p1);
    clickEntity(driving, p2);
    place(driving, 10, 90);
    expect(driving.activeCommand.commitEdit?.('', false)).toBe(true);
    expect(driving.solve.dof).toBe(free - 1);
  });

  it('rejects a curve as the second operand', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const circle = b.circle(b.point(50, 50), 30);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    clickEntity(editor, p);
    clickCurve(editor, circle);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
  });

  it('stays active and starts a fresh dimension after one is placed', () => {
    const b = new SketchBuilder();
    const circle = b.circle(b.point(50, 50), 30);
    const p = b.point(-50, 0);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    clickCurve(editor, circle);
    place(editor, 120, 50);
    expect(editor.activeCommand.id).toBe('driven');
    clickEntity(editor, p);
    expect(kinds(editor.sketch)).toEqual(['radius']);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
  });

  it('Esc backs out of the placement, then out of the command', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('driven');
    // Esc while the radius is being placed.
    clickCurve(editor, circle);
    editor.escape();
    expect(editor.activeCommand.id).toBe('driven');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.sketch.constraints).toEqual([]);
    // And again from a pending operand.
    clickEntity(editor, center);
    editor.escape();
    expect(editor.activeCommand.id).toBe('driven');
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
    editor.startCommand('driven');
    hand(editor, { id: line, kind: 'line' });
    // A line with no length has no direction to lay a dimension along, so the
    // pick does not complete: it stays pending, exactly as it does for the
    // driving dimension.
    expect(editor.sketch.constraints).toEqual([]);
    expect(dimensionShape(editor)).toBeUndefined();
    expect(editor.activeCommand.id).toBe('driven');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
  });
});

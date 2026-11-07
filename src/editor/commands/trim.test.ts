import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { arcParams, distance, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { OverlayShape, PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { ExtendCommand, TrimCommand } from './trim';
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
  ['trim', (e) => new TrimCommand(e)],
  ['extend', (e) => new ExtendCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch()): Editor {
  const editor = new Editor(solver, sketch, commands, 'select');
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

/** Moves the cursor without clicking: what the command previews while hovering. */
function hover(editor: Editor, x: number, y: number): void {
  editor.activeCommand.pointerMove?.(at(x, y));
}

/** Where a point currently sits; the solver may have moved it since it was built. */
function pointOf(editor: Editor, id: Id): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'point') throw new Error(`"${id}" is not a point`);
  return { x: e.x, y: e.y };
}

/** Asserts where a point sits now. */
function expectAt(editor: Editor, id: Id, at: Vec2, precision = 9): void {
  const p = pointOf(editor, id);
  expect(p.x).toBeCloseTo(at.x, precision);
  expect(p.y).toBeCloseTo(at.y, precision);
}

/** Every point's position, so a trim can be proven to have moved nothing. */
function snapshot(editor: Editor): Map<Id, Vec2> {
  const points = new Map<Id, Vec2>();
  for (const e of editor.sketch.entities) {
    if (e.kind === 'point') points.set(e.id, { x: e.x, y: e.y });
  }
  return points;
}

function expectUnmoved(editor: Editor, before: Map<Id, Vec2>): void {
  expectUnmovedExcept(editor, before, []);
}

/** The points a trim left alone: everything but the ones it was meant to move. */
function expectUnmovedExcept(editor: Editor, before: Map<Id, Vec2>, moved: readonly Id[]): void {
  for (const [id, was] of before) {
    if (moved.includes(id)) continue;
    const now = pointOf(editor, id);
    expect(now.x).toBeCloseTo(was.x, 6);
    expect(now.y).toBeCloseTo(was.y, 6);
  }
}

/** The marker the command draws, or undefined when it draws none. */
function snapAt(editor: Editor): Vec2 | undefined {
  type Snap = Extract<OverlayShape, { kind: 'snap' }>;
  const shape = (editor.activeCommand.overlay?.() ?? []).find((s): s is Snap => s.kind === 'snap');
  return shape?.at;
}

/** The entities the command is highlighting. */
function highlightIds(editor: Editor): readonly Id[] {
  type Highlight = Extract<OverlayShape, { kind: 'highlight' }>;
  const shape = (editor.activeCommand.overlay?.() ?? []).find((s): s is Highlight => s.kind === 'highlight');
  return shape?.ids ?? [];
}

/** A line crossing the x axis at `x`, long enough to be clicked anywhere along it. */
function across(b: SketchBuilder, x: number): void {
  b.line(b.point(x, -200), b.point(x, 200));
}

describe('trim and extend', () => {
  it('trims a line to the crossing, and refuses to extend there', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    b.line(a, c);
    const top = b.point(50, -200);
    const bottom = b.point(50, 200);
    b.line(top, bottom);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    click(editor, 100, 0);

    // The end landed exactly on the other line, and the curve is shorter for it.
    expectAt(editor, c, { x: 50, y: 0 });
    expect(distance(pointOf(editor, a), pointOf(editor, c))).toBeCloseTo(50, 9);
    expect(perpendicularDistance(pointOf(editor, c), pointOf(editor, top), pointOf(editor, bottom))).toBeCloseTo(0, 9);
    expectUnmovedExcept(editor, before, [c]);
    // The command stays active for the next trim.
    expect(editor.activeCommand.id).toBe('trim');

    // The same click under extend: the crossing is inside the span, not beyond
    // the end, so there is nowhere to lengthen the line to.
    const extend = editorWith(b.build());
    extend.startCommand('extend');
    const untouched = snapshot(extend);
    click(extend, 100, 0);
    expect(extend.message).toEqual({ key: 'prompts.extendNone' });
    expectUnmoved(extend, untouched);
    expect(extend.activeCommand.id).toBe('extend');
  });

  it('extends a short line to the crossing, and refuses to trim there', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(30, 0);
    b.line(a, c);
    across(b, 60);

    const editor = editorWith(b.build());
    editor.startCommand('extend');
    const before = snapshot(editor);
    click(editor, 30, 0);

    expectAt(editor, c, { x: 60, y: 0 });
    expect(distance(pointOf(editor, a), pointOf(editor, c))).toBeCloseTo(60, 9);
    expectUnmovedExcept(editor, before, [c]);
    expect(editor.activeCommand.id).toBe('extend');

    // The same click under trim: the crossing lies beyond the end, so there is
    // nothing inside the span to shorten the line to.
    const trim = editorWith(b.build());
    trim.startCommand('trim');
    const untouched = snapshot(trim);
    click(trim, 30, 0);
    expect(trim.message).toEqual({ key: 'prompts.trimNone' });
    expectUnmoved(trim, untouched);
    expect(trim.activeCommand.id).toBe('trim');
  });

  it('trims both ends of a line independently', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    b.line(a, c);
    across(b, 30);
    across(b, 70);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    // The far end goes to the nearer crossing, the near end to its own.
    click(editor, 100, 0);
    click(editor, 0, 0);

    expectAt(editor, a, { x: 30, y: 0 });
    expectAt(editor, c, { x: 70, y: 0 });
    expect(editor.activeCommand.id).toBe('trim');
  });

  it('extends both ends of a line independently', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(10, 0);
    b.line(a, c);
    across(b, -20);
    across(b, 40);

    const editor = editorWith(b.build());
    editor.startCommand('extend');
    click(editor, 10, 0);
    click(editor, 0, 0);

    expectAt(editor, a, { x: -20, y: 0 });
    expectAt(editor, c, { x: 40, y: 0 });
    expect(editor.activeCommand.id).toBe('extend');
  });

  it('trims a line to the nearer crossing of a circle', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(200, 0);
    b.line(a, c);
    const center = b.point(100, 0);
    b.circle(center, 60);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    click(editor, 200, 0);

    // The circle meets the line at x = 40 and x = 160; the end goes to the
    // nearer of the two.
    expectAt(editor, c, { x: 160, y: 0 });
    expect(distance(pointOf(editor, c), pointOf(editor, center))).toBeCloseTo(60, 9);
    expectUnmovedExcept(editor, before, [c]);
  });

  it('trims an arc at its end to the crossing inside its sweep', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    b.arc(center, start, end);
    // A line through the centre at 60°: it meets the arc's circle at 60°, inside
    // the quarter turn, and at 240°, outside it.
    const dir = Math.PI / 3;
    const far = b.point(-100 * Math.cos(dir), -100 * Math.sin(dir));
    const near = b.point(100 * Math.cos(dir), 100 * Math.sin(dir));
    b.line(far, near);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    click(editor, 0, 50);

    // The end lands on the crossing inside the sweep, never on the one past it.
    const landing = { x: 50 * Math.cos(dir), y: 50 * Math.sin(dir) };
    expectAt(editor, end, landing);
    expect(perpendicularDistance(pointOf(editor, end), pointOf(editor, far), pointOf(editor, near))).toBeCloseTo(0, 9);
    // The arc kept its centre and radius, and is shorter for it.
    const params = arcParams(pointOf(editor, center), pointOf(editor, start), pointOf(editor, end));
    expect(params.radius).toBeCloseTo(50, 9);
    expect(params.endAngle - params.startAngle).toBeCloseTo(dir, 9);
    expectUnmovedExcept(editor, before, [end]);
    expect(editor.activeCommand.id).toBe('trim');
  });

  it('leaves an arc alone when its crossings all lie outside its sweep', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    b.arc(center, start, end);
    // A line through the centre at 100°: both of its crossings sit past the
    // quarter turn's end angle, so neither of them is on the arc.
    const dir = (100 * Math.PI) / 180;
    b.line(b.point(-100 * Math.cos(dir), -100 * Math.sin(dir)), b.point(100 * Math.cos(dir), 100 * Math.sin(dir)));

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    click(editor, 0, 50);

    expect(editor.message).toEqual({ key: 'prompts.trimNone' });
    expectUnmoved(editor, before);
    expect(editor.activeCommand.id).toBe('trim');
  });

  it('does nothing when the click misses every end', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    b.line(a, c);
    across(b, 50);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    // The middle of the span: the cursor is on the curve, but no end of either
    // curve is within reach of it.
    click(editor, 50, 0);
    expectUnmoved(editor, before);
    expect(editor.message).toBeUndefined();
    expect(editor.activeCommand.id).toBe('trim');

    // And empty space, where there is no curve at all.
    click(editor, 400, 400);
    expectUnmoved(editor, before);
    expect(editor.message).toBeUndefined();
    expect(editor.activeCommand.id).toBe('trim');
  });

  it('hovers a circle without ever picking an end', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const round = b.circle(center, 50);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    // On the rim, to the right of the centre: a curve is hovered, but a circle
    // has no ends, so there is nothing to pick.
    hover(editor, 50, 0);
    expect(editor.hover).toBe(round);
    click(editor, 50, 0);

    expectUnmoved(editor, before);
    expect(editor.message).toBeUndefined();
    expect(editor.activeCommand.id).toBe('trim');
  });

  it('marks where the hovered end would land', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const span = b.line(a, c);
    across(b, 50);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.trim' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);

    hover(editor, 100, 0);
    expect(editor.hover).toBe(span);
    expect(snapAt(editor)).toEqual({ x: 50, y: 0 });
    expect(highlightIds(editor)).toEqual([span]);

    // Extending aims the same end the other way: beyond it, where nothing is.
    const extend = editorWith(b.build());
    extend.startCommand('extend');
    hover(extend, 100, 0);
    expect(extend.activeCommand.prompt()).toEqual({ key: 'prompts.extend' });
    expect(snapAt(extend)).toBeUndefined();
    expect(highlightIds(extend)).toEqual([span]);
  });

  it('highlights the hovered curve even when its end has nowhere to go', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const span = b.line(a, c);
    const center = b.point(300, 0);
    const round = b.circle(center, 40);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    // The middle of the span: no end is within reach, so there is nowhere to mark.
    hover(editor, 50, 0);
    expect(snapAt(editor)).toBeUndefined();
    expect(highlightIds(editor)).toEqual([span]);

    // A circle has no ends at all, so hovering one never marks anything either.
    hover(editor, 340, 0);
    expect(editor.hover).toBe(round);
    expect(snapAt(editor)).toBeUndefined();
    expect(highlightIds(editor)).toEqual([round]);
  });

  it('takes the curves built on a shared end along with it', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const shared = b.point(100, 0);
    b.line(a, shared);
    const tip = b.point(100, 60);
    b.line(shared, tip);
    across(b, 50);

    const editor = editorWith(b.build());
    editor.startCommand('trim');
    const before = snapshot(editor);
    // Both curves run through the clicked point; the hit test keeps the earlier
    // one, the span drawn first.
    click(editor, 100, 0);

    // The end moved to the crossing, and the leg built on it followed: it now
    // runs from the new position of the shared point to its own end, which the
    // trim never touched.
    expectAt(editor, shared, { x: 50, y: 0 });
    expectAt(editor, tip, { x: 100, y: 60 });
    expectUnmovedExcept(editor, before, [shared]);
  });

  it('leaves the sketch alone when the solver refuses the trim', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(10, 1);
    const span = b.line(a, c);
    across(b, 5);
    // The end's own line is already over-constrained: it cannot be horizontal,
    // vertical and 50 long at once, so no position the trim asks for solves.
    b.constrain({ kind: 'horizontal', a: span });
    b.constrain({ kind: 'vertical', a: span });
    b.constrain({ kind: 'distance', a: a, b: c, value: 50 });

    const editor = editorWith(b.build());
    expect(editor.solve.outcome).toBe('failed');
    editor.startCommand('trim');
    const before = snapshot(editor);
    click(editor, 10, 1);

    expectUnmoved(editor, before);
    expect(editor.message).toEqual({ key: 'status.solveFailed' });
    expect(editor.activeCommand.id).toBe('trim');
  });

  it('ends on Esc, there being no step to back out of', () => {
    const b = new SketchBuilder();
    b.line(b.point(0, 0), b.point(100, 0));
    const editor = editorWith(b.build());
    editor.startCommand('trim');
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });
});

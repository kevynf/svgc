import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { constraintRefs } from '../../core/edit';
import { arcParams, distance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Constraint, Id } from '../../core/model';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { Translator } from '../../i18n/i18n';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { CONSTRAINT_COMMANDS } from './constrain';
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
  ...CONSTRAINT_COMMANDS,
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

const kinds = (s: Sketch) => s.constraints.map((c) => c.kind);

function last(editor: Editor): Constraint {
  const all = editor.sketch.constraints;
  const c = all[all.length - 1];
  if (c === undefined) throw new Error('no constraint was added');
  return c;
}

/** Direction of a line, from its endpoints' current positions. */
function direction(editor: Editor, id: Id): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'line') throw new Error(`"${id}" is not a line`);
  const a = pointOf(editor, e.p1);
  const b = pointOf(editor, e.p2);
  return { x: b.x - a.x, y: b.y - a.y };
}

function length(editor: Editor, id: Id): number {
  const d = direction(editor, id);
  return Math.hypot(d.x, d.y);
}

/** Perpendicular distance from `p` to the line through `id`'s endpoints. */
function distanceToLine(editor: Editor, id: Id, p: Vec2): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'line') throw new Error(`"${id}" is not a line`);
  const d = direction(editor, id);
  const a = pointOf(editor, e.p1);
  return Math.abs(d.x * (p.y - a.y) - d.y * (p.x - a.x)) / Math.hypot(d.x, d.y);
}

function radiusOf(editor: Editor, id: Id): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind === 'circle') return e.radius;
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not a curve`);
  return arcParams(pointOf(editor, e.center), pointOf(editor, e.start), pointOf(editor, e.end))
    .radius;
}

describe('coincident', () => {
  it('merges two points', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('coincident');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.pickPoint' });
    clickEntity(editor, p1);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.pickSecondPoint' });
    clickEntity(editor, p2);
    expect(kinds(editor.sketch)).toEqual(['coincident']);
    expect(constraintRefs(last(editor))).toEqual([p1, p2]);
    expect(pointOf(editor, p1)).toEqual(pointOf(editor, p2));
  });
});

describe('fix', () => {
  it('pins a point where it is', () => {
    const b = new SketchBuilder();
    const p = b.point(10, 20);
    const editor = editorWith(b.build());
    editor.startCommand('fix');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.pickFixPoint' });
    clickEntity(editor, p);
    expect(editor.sketch.constraints).toEqual([{ kind: 'fix', id: 'e2', point: p, x: 10, y: 20 }]);
    expect(editor.solve.dof).toBe(0);
    expect(pointOf(editor, p)).toEqual({ x: 10, y: 20 });
  });

  it('holds the point while the rest of the sketch moves', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(50, 30);
    const editor = editorWith(b.build());
    editor.startCommand('fix');
    clickEntity(editor, p1);
    editor.startCommand('horizontal');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    expect(pointOf(editor, p1)).toEqual({ x: 0, y: 0 });
    expect(pointOf(editor, p2).y).toBeCloseTo(0, 9);
  });
});

describe('horizontal and vertical', () => {
  it('constrains a line on its own', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 10);
    const p2 = b.point(50, 40);
    const line = b.line(p1, p2);
    const editor = editorWith(b.build());
    editor.startCommand('horizontal');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.pickLineOrPoint' });
    clickCurve(editor, line);
    expect(editor.sketch.constraints).toEqual([{ kind: 'horizontal', id: 'e4', a: line }]);
    expect(pointOf(editor, p1).y).toBeCloseTo(pointOf(editor, p2).y, 9);
  });

  it('constrains two points', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(50, 20);
    const editor = editorWith(b.build());
    editor.startCommand('horizontal');
    clickEntity(editor, p1);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.pickSecondPoint' });
    clickEntity(editor, p2);
    expect(editor.sketch.constraints).toEqual([{ kind: 'horizontal', id: 'e3', a: p1, b: p2 }]);
    expect(pointOf(editor, p1).y).toBeCloseTo(pointOf(editor, p2).y, 9);
  });

  it('makes a line vertical', () => {
    const b = new SketchBuilder();
    const p1 = b.point(10, 0);
    const p2 = b.point(40, 50);
    const line = b.line(p1, p2);
    const editor = editorWith(b.build());
    editor.startCommand('vertical');
    clickCurve(editor, line);
    expect(editor.sketch.constraints).toEqual([{ kind: 'vertical', id: 'e4', a: line }]);
    expect(pointOf(editor, p1).x).toBeCloseTo(pointOf(editor, p2).x, 9);
  });

  it('keeps the command active for the next constraint', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 10), b.point(60, 40));
    const l2 = b.line(b.point(0, 80), b.point(60, 50));
    const editor = editorWith(b.build());
    editor.startCommand('horizontal');
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    expect(kinds(editor.sketch)).toEqual(['horizontal', 'horizontal']);
    expect(editor.activeCommand.id).toBe('horizontal');
  });
});

describe('parallel and perpendicular', () => {
  it('makes two lines parallel', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 0), b.point(50, 20));
    const l2 = b.line(b.point(0, 60), b.point(60, 95));
    const editor = editorWith(b.build());
    editor.startCommand('parallel');
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    expect(kinds(editor.sketch)).toEqual(['parallel']);
    expect(constraintRefs(last(editor))).toEqual([l1, l2]);
    const [a, c] = [direction(editor, l1), direction(editor, l2)];
    expect(a.x * c.y - a.y * c.x).toBeCloseTo(0, 9);
  });

  it('makes two lines perpendicular', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 0), b.point(50, 20));
    const l2 = b.line(b.point(0, 60), b.point(20, 95));
    const editor = editorWith(b.build());
    editor.startCommand('perpendicular');
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    expect(kinds(editor.sketch)).toEqual(['perpendicular']);
    const [a, c] = [direction(editor, l1), direction(editor, l2)];
    expect(a.x * c.x + a.y * c.y).toBeCloseTo(0, 9);
  });

  it('picks the line even when the click lands on a shared end point', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const l1 = b.line(p1, p2);
    const l2 = b.line(p2, b.point(160, 80));
    const editor = editorWith(b.build());
    editor.startCommand('parallel');
    click(editor, 100, 0);
    clickCurve(editor, l2);
    expect(kinds(editor.sketch)).toEqual(['parallel']);
    expect([...constraintRefs(last(editor))].sort()).toEqual([l1, l2].sort());
  });
});

describe('equal', () => {
  it('gives two lines the same length', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 0), b.point(50, 0));
    const l2 = b.line(b.point(0, 60), b.point(30, 60));
    const editor = editorWith(b.build());
    editor.startCommand('equal');
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    expect(kinds(editor.sketch)).toEqual(['equal']);
    expect(length(editor, l1)).toBeCloseTo(length(editor, l2), 9);
  });

  it('gives two circles the same radius', () => {
    const b = new SketchBuilder();
    const c1 = b.circle(b.point(0, 0), 30);
    const c2 = b.circle(b.point(100, 0), 50);
    const editor = editorWith(b.build());
    editor.startCommand('equal');
    clickCurve(editor, c1);
    clickCurve(editor, c2);
    expect(kinds(editor.sketch)).toEqual(['equal']);
    expect(radiusOf(editor, c1)).toBeCloseTo(radiusOf(editor, c2), 9);
  });

  it('ignores a line and a circle', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(0, 0), b.point(100, 0));
    const circle = b.circle(b.point(50, 50), 30);
    const editor = editorWith(b.build());
    editor.startCommand('equal');
    clickCurve(editor, line);
    clickCurve(editor, circle);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
  });
});

describe('tangent', () => {
  it('touches a line to a circle', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(0, 0), b.point(100, 0));
    const circle = b.circle(b.point(50, 50), 20);
    const editor = editorWith(b.build());
    editor.startCommand('tangent');
    clickCurve(editor, line);
    clickCurve(editor, circle);
    expect(kinds(editor.sketch)).toEqual(['tangent']);
    expect(constraintRefs(last(editor))).toEqual([line, circle]);
    const c = editor.sketch.entities.find((e) => e.id === circle);
    const center = c?.kind === 'circle' ? pointOf(editor, c.center) : undefined;
    expect(center).toBeDefined();
    expect(distanceToLine(editor, line, center!) - radiusOf(editor, circle)).toBeCloseTo(0, 6);
  });

  it('touches an arc to an arc', () => {
    const b = new SketchBuilder();
    const a1 = b.arc(b.point(0, 0), b.point(50, 0), b.point(0, 50));
    const a2 = b.arc(b.point(110, 0), b.point(160, 0), b.point(110, 50));
    const editor = editorWith(b.build());
    editor.startCommand('tangent');
    clickCurve(editor, a1);
    clickCurve(editor, a2);
    expect(kinds(editor.sketch)).toEqual(['tangent']);
    const center = (id: Id) => {
      const e = editor.sketch.entities.find((x) => x.id === id);
      return e?.kind === 'arc' ? pointOf(editor, e.center) : undefined;
    };
    const [c1, c2] = [center(a1), center(a2)];
    const [r1, r2] = [radiusOf(editor, a1), radiusOf(editor, a2)];
    const d = distance(c1!, c2!);
    expect(Math.min(Math.abs(d - (r1 + r2)), Math.abs(d - Math.abs(r1 - r2)))).toBeLessThan(1e-6);
  });

  it('ignores two lines', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 0), b.point(100, 0));
    const l2 = b.line(b.point(0, 60), b.point(100, 60));
    const editor = editorWith(b.build());
    editor.startCommand('tangent');
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
  });
});

describe('midpoint', () => {
  it('places the point at the middle of the line', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(50, 20);
    const p3 = b.point(10, 60);
    b.fix(p1);
    b.fix(p2);
    const line = b.line(p1, p2);
    const editor = editorWith(b.build());
    editor.startCommand('midpoint');
    clickEntity(editor, p3);
    clickCurve(editor, line);
    expect(kinds(editor.sketch)).toEqual(['fix', 'fix', 'midpoint']);
    expect(pointOf(editor, p3).x).toBeCloseTo(25, 9);
    expect(pointOf(editor, p3).y).toBeCloseTo(10, 9);
  });
});

describe('point on geometry', () => {
  it('keeps a point on a line', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    b.fix(p1);
    b.fix(p2);
    const line = b.line(p1, p2);
    const p = b.point(10, 30);
    const editor = editorWith(b.build());
    editor.startCommand('pointOnLine');
    clickEntity(editor, p);
    clickCurve(editor, line);
    expect(kinds(editor.sketch)).toEqual(['fix', 'fix', 'pointOnLine']);
    expect(pointOf(editor, p).y).toBeCloseTo(0, 9);
  });

  it('keeps a point on a circle', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    b.fix(center);
    const circle = b.circle(center, 40);
    const p = b.point(10, 30);
    const editor = editorWith(b.build());
    editor.startCommand('pointOnCurve');
    clickEntity(editor, p);
    clickCurve(editor, circle);
    expect(kinds(editor.sketch)).toEqual(['fix', 'pointOnCurve']);
    expect(
      Math.abs(distance(pointOf(editor, center), pointOf(editor, p)) - radiusOf(editor, circle)),
    ).toBeCloseTo(0, 6);
  });
});

describe('rejections', () => {
  it('leaves the sketch unchanged and names a conflicting constraint', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(50, 20);
    b.fix(p1);
    b.fix(p2);
    const editor = editorWith(b.build());
    editor.startCommand('coincident');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    expect(kinds(editor.sketch)).toEqual(['fix', 'fix']);
    expect(pointOf(editor, p1)).toEqual({ x: 0, y: 0 });
    expect(pointOf(editor, p2)).toEqual({ x: 50, y: 20 });
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.conflict.coincident' });
    expect(editor.activeCommand.id).toBe('coincident');
    // The key resolves in both catalogs, so the status bar never shows a raw key.
    const message = editor.activeCommand.prompt();
    expect(new Translator('zh-CN').t(message.key, message.params)).toContain('重合');
    expect(new Translator('en').t(message.key, message.params)).toContain('Coincident');
  });

  it('reports a redundant constraint without adding it', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(50, 20);
    const line = b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: line });
    const editor = editorWith(b.build());
    editor.startCommand('horizontal');
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    expect(kinds(editor.sketch)).toEqual(['horizontal']);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.redundant' });
  });

  it('ignores a constraint between an entity and itself', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(0, 0), b.point(100, 40));
    const editor = editorWith(b.build());
    editor.startCommand('parallel');
    clickCurve(editor, line);
    expect(editor.activeCommand.overlay?.()).toEqual([{ kind: 'highlight', ids: [line] }]);
    clickCurve(editor, line);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
    expect(editor.activeCommand.id).toBe('parallel');
    // The command is ready for a fresh pair of operands.
    clickCurve(editor, line);
    expect(editor.activeCommand.overlay?.()).toEqual([{ kind: 'highlight', ids: [line] }]);
  });

  it('Esc backs out of the pending operand, then ends the command', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('coincident');
    clickEntity(editor, p1);
    editor.escape();
    expect(editor.activeCommand.id).toBe('coincident');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.pickPoint' });
    expect(editor.sketch.constraints).toEqual([]);
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });
});

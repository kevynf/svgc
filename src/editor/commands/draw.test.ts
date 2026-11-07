import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { ArcCommand, CircleCommand, LineCommand, PointCommand, RectangleCommand } from './draw';
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
  ['line', (e) => new LineCommand(e)],
  ['circle', (e) => new CircleCommand(e)],
  ['rectangle', (e) => new RectangleCommand(e)],
  ['point', (e) => new PointCommand(e)],
  ['arc', (e) => new ArcCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch()): Editor {
  const editor = new Editor(solver, sketch, commands, 'select');
  editor.viewport.resize(800, 600);
  return editor;
}

function at(x: number, y: number, ctrl = false): PointerInput {
  return { screen: { x, y }, world: { x, y }, shift: false, ctrl, alt: false };
}

function click(editor: Editor, x: number, y: number, ctrl = false): void {
  const input = at(x, y, ctrl);
  editor.activeCommand.pointerMove?.(input);
  editor.activeCommand.pointerDown?.(input);
  editor.activeCommand.pointerUp?.(input);
}

const count = (s: Sketch, kind: string) => s.entities.filter((e) => e.kind === kind).length;
const kinds = (s: Sketch) => s.constraints.map((c) => c.kind).sort();

describe('LineCommand', () => {
  it('chains segments, sharing end points, with inferred horizontal/vertical', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0);
    click(editor, 100, 2);
    click(editor, 101, 80);
    const s = editor.sketch;
    expect(count(s, 'line')).toBe(2);
    expect(count(s, 'point')).toBe(3);
    expect(kinds(s)).toEqual(['horizontal', 'vertical']);
    const [l1, l2] = s.entities.filter((e) => e.kind === 'line');
    expect(l1?.kind === 'line' && l2?.kind === 'line' && l1.p2 === l2.p1).toBe(true);
  });

  it('closes a loop by snapping onto the start point', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0);
    click(editor, 100, 30);
    click(editor, 40, 90);
    click(editor, 1, 1);
    expect(count(editor.sketch, 'point')).toBe(3);
    expect(count(editor.sketch, 'line')).toBe(3);
  });

  it('starts on an existing curve with a point-on-line constraint', () => {
    const b = new SketchBuilder();
    b.line(b.point(0, 0), b.point(200, 0));
    const editor = editorWith(b.build());
    editor.startCommand('line');
    click(editor, 50, 3);
    click(editor, 70, 120);
    expect(kinds(editor.sketch)).toContain('pointOnLine');
  });

  it('Ctrl disables inference', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0, true);
    click(editor, 100, 2, true);
    expect(editor.sketch.constraints).toEqual([]);
  });

  it('Esc ends the current chain, then the command', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0);
    click(editor, 100, 40);
    editor.escape();
    expect(editor.activeCommand.id).toBe('line');
    click(editor, 300, 300);
    click(editor, 380, 340);
    expect(count(editor.sketch, 'point')).toBe(4);
    editor.escape();
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });

  it('each segment is one undo step', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0);
    click(editor, 100, 40);
    click(editor, 150, 140);
    editor.undo();
    expect(count(editor.sketch, 'line')).toBe(1);
  });
});

describe('CircleCommand', () => {
  it('creates a circle from center and rim', () => {
    const editor = editorWith();
    editor.startCommand('circle');
    click(editor, 100, 100);
    click(editor, 130, 140);
    const circle = editor.sketch.entities.find((e) => e.kind === 'circle');
    expect(circle?.kind === 'circle' && circle.radius).toBeCloseTo(50, 6);
  });
});

describe('RectangleCommand', () => {
  it('creates four constrained edges', () => {
    const editor = editorWith();
    editor.startCommand('rectangle');
    click(editor, 0, 0);
    click(editor, 120, 80);
    expect(count(editor.sketch, 'line')).toBe(4);
    expect(kinds(editor.sketch)).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical']);
    expect(editor.solve.dof).toBe(4);
  });
});

describe('ArcCommand', () => {
  it('creates an arc through a third point', () => {
    const editor = editorWith();
    editor.startCommand('arc');
    click(editor, 100, 0);
    click(editor, 0, 100);
    click(editor, 0, 0);
    const arc = editor.sketch.entities.find((e) => e.kind === 'arc');
    expect(arc).toBeDefined();
    // The three points lie on a circle of radius ~70.7 about (50, 50).
    const center = editor.sketch.entities.find(
      (e) => e.kind === 'point' && Math.abs(e.x - 50) < 1e-6,
    );
    expect(center).toBeDefined();
  });

  it('orients the arc clockwise from start to end', () => {
    const editor = editorWith();
    editor.startCommand('arc');
    // Start right, end top, through the origin: sweeps through the origin, so
    // the model stores it start→end the long way round.
    click(editor, 100, 0);
    click(editor, 0, 100);
    click(editor, 0, 0);
    const arc = editor.sketch.entities.find((e) => e.kind === 'arc');
    const sketch = editor.sketch;
    const pt = (id: string) => sketch.entities.find((e) => e.id === id);
    const start = arc?.kind === 'arc' ? pt(arc.start) : undefined;
    const end = arc?.kind === 'arc' ? pt(arc.end) : undefined;
    expect(start?.kind).toBe('point');
    expect(end?.kind).toBe('point');
    // The stored start is the one at the origin: the arc sweeps clockwise from
    // there to (100, 0).
    expect(start?.kind === 'point' && start.x === 0).toBe(true);
  });
});

describe('LineCommand tangent arc', () => {
  it('drags a tangent arc out of the chain start point', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0);
    click(editor, 100, 0);
    const command = editor.activeCommand as LineCommand;
    // Grab the shared end point and drag downwards.
    command.pointerDown(at(100, 0));
    command.pointerMove(at(100, 60));
    command.pointerMove(at(100, 61));
    command.pointerUp(at(100, 60));
    const s = editor.sketch;
    expect(count(s, 'arc')).toBe(1);
    expect(kinds(s)).toContain('tangent');
  });

  it('Esc during the drag keeps the chain and drops the arc', () => {
    const editor = editorWith();
    editor.startCommand('line');
    click(editor, 0, 0);
    click(editor, 100, 0);
    const command = editor.activeCommand as LineCommand;
    command.pointerDown(at(100, 0));
    command.pointerMove(at(100, 61));
    command.pointerMove(at(100, 62));
    editor.escape();
    expect(count(editor.sketch, 'arc')).toBe(0);
    // Chain survives: one more segment still works.
    click(editor, 200, 0);
    expect(count(editor.sketch, 'line')).toBe(2);
  });
});

describe('PointCommand', () => {
  it('adds a point per click but not on top of an existing point', () => {
    const editor = editorWith();
    editor.startCommand('point');
    click(editor, 10, 10);
    click(editor, 11, 11);
    click(editor, 60, 10);
    expect(count(editor.sketch, 'point')).toBe(2);
  });
});

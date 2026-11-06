import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { CircleCommand, LineCommand, PointCommand, RectangleCommand } from './draw';
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

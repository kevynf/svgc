import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { emptySketch } from '../../core/sketch';
import type { Artboard } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { ArtboardCommand } from './artboard';
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
  ['artboard', (e) => new ArtboardCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch()): Editor {
  const editor = new Editor(solver, sketch, commands, 'select');
  editor.viewport.resize(800, 600);
  return editor;
}

function withArtboard(artboard: Artboard): Sketch {
  return { ...emptySketch(), artboard };
}

function at(x: number, y: number, mods: { shift?: boolean; alt?: boolean } = {}): PointerInput {
  return {
    screen: { x, y },
    world: { x, y },
    shift: mods.shift ?? false,
    ctrl: false,
    alt: mods.alt ?? false,
  };
}

function drag(
  editor: Editor,
  from: [number, number],
  to: [number, number],
  mods: { shift?: boolean; alt?: boolean } = {},
): void {
  editor.activeCommand.pointerDown!(at(from[0], from[1], mods));
  editor.activeCommand.pointerMove!(at(to[0], to[1], mods));
  editor.activeCommand.pointerUp!(at(to[0], to[1], mods));
}

const artboard = (e: Editor): Artboard | undefined => e.sketch.artboard;

describe('ArtboardCommand — creating', () => {
  it('draws a new artboard from two corners', () => {
    const editor = editorWith();
    editor.startCommand('artboard');
    expect(artboard(editor)).toBeUndefined();
    drag(editor, [10, 10], [110, 80]);
    expect(artboard(editor)).toEqual({ x: 10, y: 10, width: 100, height: 70 });
  });

  it('normalizes a drag toward the top-left', () => {
    const editor = editorWith();
    editor.startCommand('artboard');
    drag(editor, [110, 80], [10, 10]);
    expect(artboard(editor)).toEqual({ x: 10, y: 10, width: 100, height: 70 });
  });

  it('ignores a drag smaller than 1 px', () => {
    const editor = editorWith();
    editor.startCommand('artboard');
    drag(editor, [50, 50], [50, 50]);
    expect(artboard(editor)).toBeUndefined();
    expect(editor.history.canUndo).toBe(false);
  });

  it('fits to the geometry on Enter', () => {
    const editor = editorWith(fixedLine());
    editor.startCommand('artboard');
    editor.activeCommand.keyDown!({ key: 'Enter' } as unknown as KeyboardEvent);
    expect(artboard(editor)).toEqual({ x: -20, y: -20, width: 140, height: 90 });
  });

  it('fits to the geometry from the marking menu', () => {
    const editor = editorWith(fixedLine());
    editor.startCommand('artboard');
    const fit = editor.activeCommand.menu!().find((i) => i.label.key === 'artboard.fit')!;
    expect(fit.enabled).toBe(true);
    fit.run();
    expect(artboard(editor)).toEqual({ x: -20, y: -20, width: 140, height: 90 });
  });
});

describe('ArtboardCommand — editing', () => {
  it('resizes from a side grip', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    drag(editor, [100, 50], [150, 50]);
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
  });

  it('resizes from a corner grip keeping the aspect ratio with Shift', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    drag(editor, [100, 100], [200, 120], { shift: true });
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('resizes about the centre with Alt', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    drag(editor, [100, 100], [150, 150], { alt: true });
    expect(artboard(editor)).toEqual({ x: -50, y: -50, width: 200, height: 200 });
  });

  it('moves when dragging the interior', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    drag(editor, [50, 50], [70, 60]);
    expect(artboard(editor)).toEqual({ x: 20, y: 10, width: 100, height: 100 });
  });

  it('ignores a press outside the artboard', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    drag(editor, [300, 300], [350, 350]);
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(editor.history.canUndo).toBe(false);
  });

  it('applies a preset centred on the current artboard', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    const preset = editor.activeCommand.menu!().find(
      (i) => i.label.key === 'artboard.preset.square1080',
    )!;
    preset.run();
    expect(artboard(editor)).toEqual({ x: -490, y: -490, width: 1080, height: 1080 });
  });

  it('removes the artboard', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    const remove = editor.activeCommand.menu!().find((i) => i.label.key === 'artboard.remove')!;
    expect(remove.enabled).toBe(true);
    remove.run();
    expect(artboard(editor)).toBeUndefined();
  });
});

describe('ArtboardCommand — undo and escape', () => {
  it('commits each completed drag as a single undo step', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    drag(editor, [100, 50], [150, 50]); // resize → {0,0,150,100}
    drag(editor, [75, 50], [85, 60]); // move → {10,10,150,100}
    expect(artboard(editor)).toEqual({ x: 10, y: 10, width: 150, height: 100 });
    editor.undo();
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    editor.undo();
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(editor.history.canUndo).toBe(false);
  });

  it('cancels an in-progress drag on the first Esc and ends the command on the next', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    editor.activeCommand.pointerDown!(at(100, 50));
    editor.activeCommand.pointerMove!(at(180, 50));
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 100, height: 100 }); // never committed mid-drag

    editor.escape();
    expect(editor.activeCommand.id).toBe('artboard');
    expect(artboard(editor)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(editor.history.canUndo).toBe(false);

    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });
});

describe('ArtboardCommand — overlay and prompts', () => {
  it('exposes the resize grips through the overlay while an artboard exists', () => {
    const editor = editorWith(withArtboard({ x: 0, y: 0, width: 100, height: 100 }));
    editor.startCommand('artboard');
    expect(editor.activeCommand.overlay!()).toEqual([
      { kind: 'artboardHandles', artboard: { x: 0, y: 0, width: 100, height: 100 } },
    ]);
  });

  it('has no overlay before an artboard exists', () => {
    const editor = editorWith();
    editor.startCommand('artboard');
    expect(editor.activeCommand.overlay!()).toEqual([]);
  });

  it('prompts to create when there is no artboard and to edit when there is', () => {
    const editor = editorWith();
    editor.startCommand('artboard');
    expect(editor.activeCommand.prompt().key).toBe('artboard.promptCreate');
    editor.activeCommand.pointerDown!(at(10, 10));
    expect(editor.activeCommand.prompt().key).toBe('artboard.promptCreate');
    editor.activeCommand.pointerUp!(at(60, 60));
    editor.activeCommand.pointerDown!(at(30, 30));
    expect(editor.activeCommand.prompt().key).toBe('artboard.promptMove');
  });
});

/** A diagonal line with both ends fixed, so its bounds are stable at 0,0 → 100,50. */
function fixedLine(): Sketch {
  const b = new SketchBuilder();
  const p1 = b.point(0, 0);
  b.fix(p1);
  const p2 = b.point(100, 50);
  b.fix(p2);
  b.line(p1, p2);
  return b.build();
}

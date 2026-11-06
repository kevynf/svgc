import {
  artboardFromBounds,
  handlePositions,
  normalizeArtboard,
  PRESETS,
  presetArtboard,
  resizeArtboard,
  sameArtboard,
  snapArtboard,
} from '../../core/artboard';
import type { ArtboardPreset, Handle } from '../../core/artboard';
import type { Vec2 } from '../../core/geometry';
import type { Artboard } from '../../core/sketch';
import type { Key } from '../../i18n/i18n';
import type { Command, MenuItem, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { sketchBounds } from '../hit';
import { boxFrom } from '../viewport';
import type { Box } from '../viewport';

/** Hit tolerance for the resize grips, in screen pixels. */
const HIT_PX = 6;
/** Margin (world px) around the geometry when fitting an artboard. */
const FIT_MARGIN = 20;

type Drag =
  | { kind: 'none' }
  | { kind: 'creating'; anchor: Vec2; current: Vec2 }
  | { kind: 'resizing'; handle: Handle; base: Artboard; current: Vec2; keepAspect: boolean; fromCenter: boolean }
  | { kind: 'moving'; base: Artboard; grab: Vec2; current: Vec2 };

type Editing = Exclude<Drag, { kind: 'none' }>;

/**
 * Inventor-style artboard command (the exported SVG page). With no artboard
 * the first drag draws one from two corners; with one, drag a grip to resize,
 * the interior to move. The artboard is not geometry: it never touches the
 * solver, hit testing or the browser, and each completed drag commits as a
 * single undo step.
 */
export class ArtboardCommand implements Command {
  readonly id = 'artboard';
  private drag: Drag = { kind: 'none' };

  constructor(private readonly editor: Editor) {}

  prompt(): Message {
    switch (this.drag.kind) {
      case 'creating':
        return { key: 'artboard.promptCreate' };
      case 'resizing':
        return { key: 'artboard.promptResize' };
      case 'moving':
        return { key: 'artboard.promptMove' };
      default:
        return this.editor.sketch.artboard === undefined
          ? { key: 'artboard.promptCreate' }
          : { key: 'artboard.promptEdit' };
    }
  }

  pointerDown(input: PointerInput): void {
    const a = this.editor.sketch.artboard;
    if (a === undefined) {
      this.drag = { kind: 'creating', anchor: input.world, current: input.world };
      return;
    }
    const handle = this.handleAt(a, input.world);
    if (handle !== undefined) {
      this.drag = { kind: 'resizing', handle, base: a, current: input.world, keepAspect: input.shift, fromCenter: input.alt };
      return;
    }
    if (inside(a, input.world)) {
      this.drag = { kind: 'moving', base: a, grab: input.world, current: input.world };
    }
  }

  pointerMove(input: PointerInput): void {
    const d = this.drag;
    if (d.kind === 'none') return;
    d.current = input.world;
    if (d.kind === 'resizing') {
      d.keepAspect = input.shift;
      d.fromCenter = input.alt;
    }
    this.editor.viewChanged();
  }

  pointerUp(input: PointerInput): void {
    const d = this.drag;
    if (d.kind === 'none') return;
    d.current = input.world;
    if (d.kind === 'resizing') {
      d.keepAspect = input.shift;
      d.fromCenter = input.alt;
    }
    const next = this.resolve(d);
    this.drag = { kind: 'none' };
    this.commit(next);
  }

  keyDown(event: KeyboardEvent): boolean {
    if (event.key !== 'Enter') return false;
    if (this.editor.sketch.artboard === undefined) this.fitToGeometry();
    return true;
  }

  cancel(): boolean {
    if (this.drag.kind === 'none') return false;
    // Nothing was committed during the drag, so dropping the preview restores the artboard.
    this.drag = { kind: 'none' };
    this.editor.viewChanged();
    return true;
  }

  overlay(): readonly OverlayShape[] {
    const d = this.drag;
    if (d.kind === 'creating') {
      const a = this.resolve(d);
      const box = a === undefined ? boxFrom(d.anchor, d.current) : artboardBox(a);
      return [{ kind: 'selectionBox', box, mode: 'window' }];
    }
    if (d.kind === 'resizing' || d.kind === 'moving') {
      const a = this.resolve(d);
      if (a === undefined) return [];
      return [
        { kind: 'selectionBox', box: artboardBox(a), mode: 'window' },
        { kind: 'artboardHandles', artboard: a },
      ];
    }
    const a = this.editor.sketch.artboard;
    return a === undefined ? [] : [{ kind: 'artboardHandles', artboard: a }];
  }

  menu(): readonly MenuItem[] {
    const a = this.editor.sketch.artboard;
    const items: MenuItem[] = [
      {
        label: { key: 'artboard.fit' },
        icon: 'zoomAll',
        enabled: sketchBounds(this.editor.sketch) !== undefined,
        run: () => this.fitToGeometry(),
      },
      {
        label: { key: 'artboard.remove' },
        icon: 'delete',
        enabled: a !== undefined,
        run: () => this.commit(undefined),
      },
    ];
    for (const preset of PRESETS) {
      items.push({
        label: { key: `artboard.preset.${preset.id}` as Key },
        icon: 'artboard',
        enabled: true,
        run: () => this.applyPreset(preset),
      });
    }
    return items;
  }

  dispose(): void {
    this.drag = { kind: 'none' };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private resolve(d: Editing): Artboard | undefined {
    switch (d.kind) {
      case 'creating': {
        const raw = normalizeArtboard({
          x: d.anchor.x,
          y: d.anchor.y,
          width: d.current.x - d.anchor.x,
          height: d.current.y - d.anchor.y,
        });
        if (raw.width < 1 || raw.height < 1) return undefined; // a sub-pixel drag is not a deliberate page
        return snapArtboard(raw);
      }
      case 'resizing':
        return snapArtboard(resizeArtboard(d.base, d.handle, d.current, { keepAspect: d.keepAspect, fromCenter: d.fromCenter }));
      case 'moving':
        return snapArtboard({
          x: d.base.x + (d.current.x - d.grab.x),
          y: d.base.y + (d.current.y - d.grab.y),
          width: d.base.width,
          height: d.base.height,
        });
    }
  }

  private commit(next: Artboard | undefined): void {
    if (sameArtboard(this.editor.sketch.artboard, next)) return;
    this.editor.setArtboard(next);
  }

  private fitToGeometry(): void {
    const bounds = sketchBounds(this.editor.sketch);
    if (bounds === undefined) return;
    this.commit(artboardFromBounds(bounds, FIT_MARGIN));
  }

  private applyPreset(preset: ArtboardPreset): void {
    this.commit(snapArtboard(presetArtboard(preset, this.center())));
  }

  /** Where a preset is centred: the current artboard, else the geometry, else the origin. */
  private center(): Vec2 {
    const a = this.editor.sketch.artboard;
    if (a !== undefined) return { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const bounds = sketchBounds(this.editor.sketch);
    if (bounds !== undefined) return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    return { x: 0, y: 0 };
  }

  private handleAt(a: Artboard, world: Vec2): Handle | undefined {
    const tolerance = this.editor.viewport.toWorldLength(HIT_PX);
    let best: Handle | undefined;
    let bestDistance = tolerance;
    for (const [handle, p] of Object.entries(handlePositions(a)) as [Handle, Vec2][]) {
      const distance = Math.hypot(p.x - world.x, p.y - world.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = handle;
      }
    }
    return best;
  }
}

function inside(a: Artboard, p: Vec2): boolean {
  return p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height;
}

function artboardBox(a: Artboard): Box {
  return { minX: a.x, minY: a.y, maxX: a.x + a.width, maxY: a.y + a.height };
}

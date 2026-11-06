import { deleteItems, toggleConstruction } from '../core/edit';
import type { Vec2 } from '../core/geometry';
import type { Entity, Id } from '../core/model';
import type { Artboard, Sketch } from '../core/sketch';
import type { Solver, SolveResult } from '../solver/solver';
import { analyzeStatus } from '../solver/status';
import type { EntityStatus } from '../solver/status';
import type { Command, Message } from './command';
import { History } from './history';
import { sketchBounds } from './hit';
import { Viewport } from './viewport';

export type CommandFactory = (editor: Editor) => Command;

/**
 * Owns all editor state: the sketch (with undo history), the latest solve
 * diagnostics, selection, hover, the viewport and the active command.
 * Everything that changes state goes through here and ends in `changed()`.
 */
export class Editor {
  readonly viewport = new Viewport();
  readonly history: History<Sketch>;
  private result: SolveResult;
  private selected = new Set<Id>();
  private hovered: Id | undefined;
  private cursor: Vec2 | undefined;
  private command: Command;
  /** Last non-default command, for Space/Enter repeat. */
  private lastCommand: string | undefined;
  private notice: Message | undefined;
  private readonly listeners = new Set<() => void>();
  private statusCache: { sketch: Sketch; entities: ReadonlyMap<Id, EntityStatus> } | undefined;
  private dragging = false;

  constructor(
    private readonly solver: Solver,
    initial: Sketch,
    private readonly commands: ReadonlyMap<string, CommandFactory>,
    private readonly defaultCommand: string,
  ) {
    this.result = solver.solve(initial);
    this.history = new History(this.result.outcome === 'failed' ? initial : this.result.sketch);
    this.command = this.create(defaultCommand);
  }

  get sketch(): Sketch {
    return this.history.current;
  }

  get solve(): SolveResult {
    return this.result;
  }

  /**
   * Per-entity constraint status of the current sketch. Computed on demand
   * and cached per sketch snapshot; while a drag is in progress the last
   * resting state's status is kept, since probing every frame is too costly.
   */
  get status(): ReadonlyMap<Id, EntityStatus> {
    const sketch = this.sketch;
    if (this.dragging && this.statusCache !== undefined) return this.statusCache.entities;
    if (this.statusCache?.sketch !== sketch) {
      this.statusCache = { sketch, entities: analyzeStatus(this.solver, sketch).entities };
    }
    return this.statusCache.entities;
  }

  get selection(): ReadonlySet<Id> {
    return this.selected;
  }

  get hover(): Id | undefined {
    return this.hovered;
  }

  get cursorWorld(): Vec2 | undefined {
    return this.cursor;
  }

  get activeCommand(): Command {
    return this.command;
  }

  get repeatable(): string | undefined {
    return this.lastCommand;
  }

  /** A transient status message that overrides the command prompt until the next change. */
  get message(): Message | undefined {
    return this.notice;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Sketch edits ────────────────────────────────────────────────────────

  /** Solves `next` and records it as an undo step. Rejected (unchanged) when solving fails. */
  commit(next: Sketch): boolean {
    if (next === this.sketch) return true;
    const result = this.solver.solve(next);
    if (result.outcome === 'failed') {
      this.result = { ...result, sketch: this.sketch };
      this.notice = { key: 'status.solveFailed' };
      this.changed();
      return false;
    }
    this.result = result;
    this.history.push(result.sketch);
    this.pruneSelection();
    this.changed();
    return true;
  }

  beginDrag(): void {
    // Make sure the resting status is cached before the sketch starts changing.
    void this.status;
    this.dragging = true;
    this.history.begin();
  }

  /** Moves a point toward `to`, keeping constraints. Part of the current drag transaction. */
  dragPoint(point: Id, to: Vec2): void {
    const result = this.solver.solve(this.sketch, { point, x: to.x, y: to.y });
    this.result = result;
    if (result.outcome !== 'failed') this.history.replace(result.sketch);
    this.changed();
  }

  endDrag(): void {
    // Re-solve without the drag target so diagnostics reflect the resting state.
    const result = this.solver.solve(this.sketch);
    this.result = result;
    if (result.outcome !== 'failed') this.history.replace(result.sketch);
    this.history.end();
    this.dragging = false;
    this.changed();
  }

  /** Esc during a drag: puts everything back where it was. */
  cancelDrag(): void {
    this.history.abort();
    this.dragging = false;
    this.restore();
  }

  undo(): void {
    if (this.history.undo() !== undefined) this.restore();
  }

  redo(): void {
    if (this.history.redo() !== undefined) this.restore();
  }

  deleteSelection(): void {
    if (this.selected.size === 0) return;
    this.commit(deleteItems(this.sketch, this.selected));
  }

  toggleConstruction(): void {
    this.commit(toggleConstruction(this.sketch, this.selected));
  }

  /** Sets the exported page (the artboard), or clears it with `undefined`. One undo step. */
  setArtboard(artboard: Artboard | undefined): boolean {
    return this.commit({ ...this.sketch, artboard });
  }

  /** Moves a point to an exact position; the solver keeps its constraints. */
  setPointPosition(point: Id, x: number, y: number): void {
    const current = this.sketch.entities.find((e) => e.id === point);
    if (current?.kind !== 'point' || (current.x === x && current.y === y)) return;
    const entities = this.sketch.entities.map((e): Entity => (e.kind === 'point' && e.id === point ? { ...e, x, y } : e));
    this.commit({ ...this.sketch, entities });
  }

  /** Sets a circle's radius; arcs derive theirs from their three points. */
  setCircleRadius(curve: Id, radius: number): void {
    const current = this.sketch.entities.find((e) => e.id === curve);
    if (current?.kind !== 'circle' || current.radius === radius || !Number.isFinite(radius)) return;
    const entities = this.sketch.entities.map((e): Entity => (e.kind === 'circle' && e.id === curve ? { ...e, radius } : e));
    this.commit({ ...this.sketch, entities });
  }

  /** Sets the construction flag of the given curves, for the properties panel. */
  setConstruction(ids: Iterable<Id>, construction: boolean): void {
    const targets = new Set(ids);
    if (!this.sketch.entities.some((e) => targets.has(e.id) && e.kind !== 'point')) return;
    const entities = this.sketch.entities.map((e): Entity => {
      if (e.kind === 'point' || !targets.has(e.id)) return e;
      if (construction) return { ...e, construction: true };
      const { construction: _, ...rest } = e;
      return rest as Entity;
    });
    this.commit({ ...this.sketch, entities });
  }

  // ── Selection and hover ────────────────────────────────────────────────

  select(ids: Iterable<Id>, mode: 'replace' | 'add' | 'toggle' | 'remove' = 'replace'): void {
    const next = mode === 'replace' ? new Set<Id>() : new Set(this.selected);
    for (const id of ids) {
      if (mode === 'remove' || (mode === 'toggle' && next.has(id))) next.delete(id);
      else next.add(id);
    }
    this.selected = next;
    this.changed();
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected = new Set();
    this.changed();
  }

  setHover(id: Id | undefined): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.changed();
  }

  setCursor(world: Vec2 | undefined): void {
    this.cursor = world;
    this.changed();
  }

  // ── Commands ────────────────────────────────────────────────────────────

  hasCommand(id: string): boolean {
    return this.commands.has(id);
  }

  startCommand(id: string): void {
    if (!this.commands.has(id)) return;
    this.command.dispose?.();
    this.command = this.create(id);
    if (id !== this.defaultCommand) this.lastCommand = id;
    this.changed();
  }

  /** Esc: back out of the current step, then out of the command, then clear the selection. */
  escape(): void {
    if (this.command.cancel?.() === true) {
      this.changed();
      return;
    }
    if (this.command.id !== this.defaultCommand) {
      this.startCommand(this.defaultCommand);
      return;
    }
    this.clearSelection();
  }

  /** Ends the active command (marking menu "OK"). */
  finishCommand(): void {
    if (this.command.id !== this.defaultCommand) this.startCommand(this.defaultCommand);
  }

  repeatLastCommand(): void {
    if (this.lastCommand !== undefined) this.startCommand(this.lastCommand);
  }

  // ── View ────────────────────────────────────────────────────────────────

  zoomAll(): void {
    const bounds = sketchBounds(this.sketch);
    if (bounds === undefined) {
      this.viewport.fit({ minX: -100, minY: -100, maxX: 100, maxY: 100 });
    } else {
      this.viewport.fit(bounds);
    }
    this.changed();
  }

  /** Notifies listeners after a view-only change (pan, zoom, resize). */
  viewChanged(): void {
    this.changed();
  }

  private restore(): void {
    this.result = this.solver.solve(this.sketch);
    this.pruneSelection();
    this.changed();
  }

  private pruneSelection(): void {
    const alive = new Set<Id>([
      ...this.sketch.entities.map((e) => e.id),
      ...this.sketch.constraints.map((c) => c.id),
    ]);
    this.selected = new Set([...this.selected].filter((id) => alive.has(id)));
    if (this.hovered !== undefined && !alive.has(this.hovered)) this.hovered = undefined;
  }

  private create(id: string): Command {
    const factory = this.commands.get(id);
    if (factory === undefined) throw new Error(`Unknown command "${id}"`);
    return factory(this);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Clears the transient message; called by the UI on user input. */
  clearMessage(): void {
    this.notice = undefined;
  }
}

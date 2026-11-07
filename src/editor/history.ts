/** Undo/redo over immutable snapshots. */
export class History<T> {
  private readonly past: T[] = [];
  private readonly future: T[] = [];
  private base: T | undefined;

  constructor(
    private present: T,
    private readonly limit = 200,
  ) {}

  get current(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.base === undefined && this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.base === undefined && this.future.length > 0;
  }

  /** Records a new state as one undo step. */
  push(next: T): void {
    this.end();
    if (next === this.present) return;
    this.record(this.present);
    this.present = next;
  }

  /**
   * Starts a transaction: states set with `replace` until `end` collapse into a single undo step
   * (e.g. a drag).
   */
  begin(): void {
    this.end();
    this.base = this.present;
  }

  /** Replaces the current state without creating an undo step. */
  replace(next: T): void {
    this.present = next;
  }

  /**
   * Starts a new document: `sketch` becomes the current state and both stacks are emptied, so
   * nothing from the previous document can be reached — the first edit of the new one is the
   * earliest undo step.
   */
  reset(sketch: T): void {
    this.end();
    this.past.length = 0;
    this.future.length = 0;
    this.present = sketch;
  }

  /** Ends the transaction and restores the state it started from. */
  abort(): void {
    if (this.base === undefined) return;
    this.present = this.base;
    this.base = undefined;
  }

  end(): void {
    const base = this.base;
    this.base = undefined;
    if (base !== undefined && base !== this.present) this.record(base);
  }

  undo(): T | undefined {
    this.end();
    const prev = this.past.pop();
    if (prev === undefined) return undefined;
    this.future.push(this.present);
    this.present = prev;
    return prev;
  }

  redo(): T | undefined {
    this.end();
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(this.present);
    this.present = next;
    return next;
  }

  private record(state: T): void {
    this.past.push(state);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }
}

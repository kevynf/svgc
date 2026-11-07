import type { InferredConstraint } from './inference';

/** The constraint kinds inference can produce while drawing. */
export type InferredKind = InferredConstraint['kind'];

export interface Settings {
  /** F8/F9: whether constraint glyphs are drawn on the canvas. */
  readonly showConstraints: boolean;
  /** Constraint kinds inferred while drawing (Inventor's 绾︽潫璁剧疆). */
  readonly inferred: ReadonlySet<InferredKind>;
}

const SHOW_KEY = 'svgc.showConstraints';
const INFER_KEY = 'svgc.inferredConstraints';
const ALL: readonly InferredKind[] = [
  'coincident',
  'pointOnCurve',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
];

/** localStorage is absent under the Node test runner; settings then simply don't persist. */
function storage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function loadShow(): boolean {
  return storage()?.getItem(SHOW_KEY) !== '0';
}

function loadInferred(): Set<InferredKind> {
  const raw = storage()?.getItem(INFER_KEY);
  if (raw === null || raw === undefined) return new Set(ALL);
  return new Set(raw.split(',').filter((k): k is InferredKind => (ALL as string[]).includes(k)));
}

/**
 * Editor-wide display and inference settings, persisted in localStorage. Kept out of `Editor` so
 * the ribbon, the canvas and the drawing commands can all read it without threading it through.
 */
class SettingsStore {
  private show = loadShow();
  private inferred = loadInferred();
  private readonly listeners = new Set<() => void>();

  get value(): Settings {
    return { showConstraints: this.show, inferred: this.inferred };
  }

  setShow(show: boolean): void {
    if (show === this.show) return;
    this.show = show;
    storage()?.setItem(SHOW_KEY, show ? '1' : '0');
    this.changed();
  }

  toggleShow(): void {
    this.setShow(!this.show);
  }

  setInferred(kind: InferredKind, on: boolean): void {
    if (this.inferred.has(kind) === on) return;
    const next = new Set(this.inferred);
    if (on) next.add(kind);
    else next.delete(kind);
    this.inferred = next;
    storage()?.setItem(INFER_KEY, [...next].join(','));
    this.changed();
  }

  /** Restores every inference kind; returns true when anything changed. */
  resetInferred(): boolean {
    if (this.inferred.size === ALL.length) return false;
    this.inferred = new Set(ALL);
    storage()?.setItem(INFER_KEY, [...ALL].join(','));
    this.changed();
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export const settings = new SettingsStore();
export const INFERRED_KINDS = ALL;

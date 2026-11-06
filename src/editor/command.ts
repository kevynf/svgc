import type { Vec2 } from '../core/geometry';
import type { Id } from '../core/model';
import type { Artboard } from '../core/sketch';
import type { Key, Params } from '../i18n/i18n';
import type { IconName } from '../ui/icons';
import type { Alignment, InferredConstraint } from './inference';
import type { Box } from './viewport';

export interface PointerInput {
  /** Pixels relative to the canvas. */
  readonly screen: Vec2;
  readonly world: Vec2;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export interface Message {
  readonly key: Key;
  readonly params?: Params;
}

/** Transient shapes a command draws on top of the sketch. */
export type OverlayShape =
  /** Screen-space selection rectangle. */
  | { readonly kind: 'selectionBox'; readonly box: Box; readonly mode: 'window' | 'crossing' }
  /** Entities to pre-highlight, e.g. the operands a constraint command has picked. */
  | { readonly kind: 'highlight'; readonly ids: readonly Id[] }
  /** World-space rubber-band geometry. */
  | { readonly kind: 'previewLine'; readonly from: Vec2; readonly to: Vec2 }
  | { readonly kind: 'previewCircle'; readonly center: Vec2; readonly radius: number }
  /** Dotted alignment guide from an existing point to the cursor (world space). */
  | { readonly kind: 'guide'; readonly alignment: Alignment; readonly to: Vec2 }
  /** Glyphs for the constraints that will be created, next to a world point. */
  | { readonly kind: 'inferred'; readonly at: Vec2; readonly constraints: readonly InferredConstraint[] }
  /** Marker on the point or curve position the cursor snapped to. */
  | { readonly kind: 'snap'; readonly at: Vec2 }
  /** The eight resize grips of an artboard, drawn while it is being edited. */
  | { readonly kind: 'artboardHandles'; readonly artboard: Artboard };

export interface MenuItem {
  readonly label: Message;
  readonly icon?: IconName;
  readonly enabled: boolean;
  readonly run: () => void;
}

/**
 * An interactive canvas command (Inventor style: pick the command first,
 * then the geometry). The editor routes pointer and key input to the
 * active command; panning, zooming and global shortcuts are handled before
 * input reaches it.
 */
export interface Command {
  readonly id: string;
  prompt(): Message;
  pointerDown?(input: PointerInput): void;
  pointerMove?(input: PointerInput): void;
  pointerUp?(input: PointerInput): void;
  /** Returns true when the key was consumed. */
  keyDown?(event: KeyboardEvent): boolean;
  /**
   * Esc. Returns true when the command backed out of an in-progress step
   * and stays active; false lets the editor end the command.
   */
  cancel?(): boolean;
  overlay?(): readonly OverlayShape[];
  /** Command-specific marking menu entries. */
  menu?(): readonly MenuItem[];
  dispose?(): void;
}

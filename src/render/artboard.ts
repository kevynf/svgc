import type { Viewport } from '../editor/viewport';
import type { Artboard } from '../core/sketch';

/** Screen-space elements drawing the artboard (page) behind the geometry. Placeholder. */
export function artboardElements(_artboard: Artboard | undefined, _vp: Viewport): SVGElement[] {
  return [];
}

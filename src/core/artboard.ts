import type { Vec2 } from './geometry';
import type { Artboard } from './sketch';

/** An axis-aligned rectangle, structurally compatible with the editor's `Box`. */
export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The eight resize grips of an artboard (Inventor naming: compass directions). */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface ResizeOptions {
  /** Hold the aspect ratio while resizing (Shift). */
  readonly keepAspect?: boolean;
  /** Resize symmetrically about the centre (Alt). */
  readonly fromCenter?: boolean;
}

/** A named page size offered in the marking menu. */
export interface ArtboardPreset {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** Artboards are never smaller than this on either axis, in world px. */
const MIN_SIZE = 1;

/**
 * Page sizes for the marking menu. Sizes are in CSS px at 96 dpi; A4 is
 * 210×297 mm and Letter is 8.5×11 in.
 */
export const PRESETS: readonly ArtboardPreset[] = [
  { id: 'a4Portrait', width: 794, height: 1123 },
  { id: 'a4Landscape', width: 1123, height: 794 },
  { id: 'letter', width: 816, height: 1056 },
  { id: 'fullHd', width: 1920, height: 1080 },
  { id: 'square1080', width: 1080, height: 1080 },
  { id: 'icon512', width: 512, height: 512 },
  { id: 'icon24', width: 24, height: 24 },
];

/** Rewrites an artboard given as any two corners into a top-left origin with positive size. */
export function normalizeArtboard(a: Artboard): Artboard {
  const x = a.width < 0 ? a.x + a.width : a.x;
  const y = a.height < 0 ? a.y + a.height : a.y;
  return { x, y, width: Math.abs(a.width), height: Math.abs(a.height) };
}

/** Rounds an artboard's origin and size to whole px, keeping at least 1 px per axis. */
export function snapArtboard(a: Artboard): Artboard {
  return {
    x: Math.round(a.x) || 0,
    y: Math.round(a.y) || 0,
    width: Math.max(MIN_SIZE, Math.round(a.width)),
    height: Math.max(MIN_SIZE, Math.round(a.height)),
  };
}

/** Fits `bounds` with a `margin`, rounded outward to whole px. */
export function artboardFromBounds(bounds: Bounds, margin: number): Artboard {
  const x = Math.floor(bounds.minX - margin);
  const y = Math.floor(bounds.minY - margin);
  const maxX = Math.ceil(bounds.maxX + margin);
  const maxY = Math.ceil(bounds.maxY + margin);
  return { x, y, width: Math.max(MIN_SIZE, maxX - x), height: Math.max(MIN_SIZE, maxY - y) };
}

/** A preset placed so its centre lands on `center`. */
export function presetArtboard(preset: ArtboardPreset, center: Vec2): Artboard {
  return {
    x: center.x - preset.width / 2,
    y: center.y - preset.height / 2,
    width: preset.width,
    height: preset.height,
  };
}

/** The eight grip positions (corners and edge midpoints), in world coordinates. */
export function handlePositions(a: Artboard): Record<Handle, Vec2> {
  const { x, y, width, height } = a;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return {
    nw: { x, y },
    n: { x: cx, y },
    ne: { x: x + width, y },
    w: { x, y: cy },
    e: { x: x + width, y: cy },
    sw: { x, y: y + height },
    s: { x: cx, y: y + height },
    se: { x: x + width, y: y + height },
  };
}

/** Value equality that treats two absent artboards as equal. */
export function sameArtboard(a: Artboard | undefined, b: Artboard | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Resizes `a` by dragging `handle` to `to`. The gripped edge follows the
 * cursor while the opposite edge stays put; `fromCenter` mirrors the grip
 * about the centre and `keepAspect` preserves the original aspect ratio.
 * The result keeps at least 1 px per axis but is not snapped to whole px.
 */
export function resizeArtboard(
  a: Artboard,
  handle: Handle,
  to: Vec2,
  opts: ResizeOptions = {},
): Artboard {
  const keepAspect = opts.keepAspect ?? false;
  const fromCenter = opts.fromCenter ?? false;
  const aspect = a.height > 0 ? a.width / a.height : 1;

  const left = a.x;
  const top = a.y;
  const right = a.x + a.width;
  const bottom = a.y + a.height;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  const moveLeft = handle.includes('w');
  const moveRight = handle.includes('e');
  const moveTop = handle.includes('n');
  const moveBottom = handle.includes('s');

  // Per-axis size measured from the anchor toward the cursor.
  let w: number;
  if (fromCenter && (moveLeft || moveRight)) w = Math.abs(to.x - cx) * 2;
  else if (moveRight) w = to.x - left;
  else if (moveLeft) w = right - to.x;
  else w = a.width;

  let h: number;
  if (fromCenter && (moveTop || moveBottom)) h = Math.abs(to.y - cy) * 2;
  else if (moveBottom) h = to.y - top;
  else if (moveTop) h = bottom - to.y;
  else h = a.height;

  if (keepAspect && aspect > 0 && Number.isFinite(aspect)) {
    if ((moveLeft || moveRight) && (moveTop || moveBottom)) {
      // Corner grip: the dominant axis drives so the corner tracks the cursor.
      if (w / aspect > h) h = w / aspect;
      else w = h * aspect;
    } else if (moveLeft || moveRight) {
      h = w / aspect; // horizontal edge: width drives
    } else {
      w = h * aspect; // vertical edge: height drives
    }
  }

  if (w < MIN_SIZE) {
    w = MIN_SIZE;
    if (keepAspect) h = w / aspect;
  }
  if (h < MIN_SIZE) {
    h = MIN_SIZE;
    if (keepAspect) w = h * aspect;
  }

  let x: number;
  if (fromCenter && (moveLeft || moveRight)) x = cx - w / 2;
  else if (moveRight) x = left;
  else if (moveLeft) x = right - w;
  else x = cx - w / 2;

  let y: number;
  if (fromCenter && (moveTop || moveBottom)) y = cy - h / 2;
  else if (moveBottom) y = top;
  else if (moveTop) y = bottom - h;
  else y = cy - h / 2;

  return { x, y, width: w, height: h };
}

import type { Vec2 } from '../core/geometry';

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function boxFrom(a: Vec2, b: Vec2): Box {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export interface GridSteps {
  /** World distance between minor grid lines. */
  readonly minor: number;
  readonly major: number;
}

const MIN_SCALE = 1e-3;
const MAX_SCALE = 1e3;
/** Minor grid lines are never closer than this on screen. */
const MIN_GRID_PX = 12;

/**
 * Maps world coordinates (px, Y down) to screen pixels with a uniform scale and translation: screen
 * = world × scale + offset.
 */
export class Viewport {
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  width = 0;
  height = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.scale + this.offsetX, y: p.y * this.scale + this.offsetY };
  }

  toWorld(p: Vec2): Vec2 {
    return { x: (p.x - this.offsetX) / this.scale, y: (p.y - this.offsetY) / this.scale };
  }

  /** Converts a screen distance (e.g. a hit tolerance) to world units. */
  toWorldLength(px: number): number {
    return px / this.scale;
  }

  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  /** Zooms by `factor`, keeping the world point under `anchor` (screen) fixed. */
  zoomAt(anchor: Vec2, factor: number): void {
    const world = this.toWorld(anchor);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    this.offsetX = anchor.x - world.x * this.scale;
    this.offsetY = anchor.y - world.y * this.scale;
  }

  /** Fits a world box into the screen with a margin in screen pixels. */
  fit(box: Box, margin = 48): void {
    const w = Math.max(box.maxX - box.minX, 1e-9);
    const h = Math.max(box.maxY - box.minY, 1e-9);
    const availW = Math.max(this.width - 2 * margin, 1);
    const availH = Math.max(this.height - 2 * margin, 1);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / w, availH / h)));
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    this.offsetX = this.width / 2 - cx * this.scale;
    this.offsetY = this.height / 2 - cy * this.scale;
  }

  /** The visible world region. */
  visibleBox(): Box {
    return boxFrom(this.toWorld({ x: 0, y: 0 }), this.toWorld({ x: this.width, y: this.height }));
  }

  /** Grid spacing on a 1-2-5 progression so minor lines stay at least MIN_GRID_PX apart. */
  gridSteps(): GridSteps {
    const target = MIN_GRID_PX / this.scale;
    const decade = 10 ** Math.floor(Math.log10(target));
    for (const mantissa of [1, 2, 5, 10]) {
      const minor = mantissa * decade;
      if (minor >= target) {
        const major = mantissa === 5 ? minor * 2 : minor * 5;
        return { minor, major };
      }
    }
    return { minor: 10 * decade, major: 50 * decade };
  }
}

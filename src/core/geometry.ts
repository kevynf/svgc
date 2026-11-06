export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface ArcParams {
  readonly radius: number;
  readonly startAngle: number;
  /** Always in (startAngle, startAngle + 2π]. */
  readonly endAngle: number;
}

const TAU = Math.PI * 2;

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function angleOf(center: Vec2, p: Vec2): number {
  return Math.atan2(p.y - center.y, p.x - center.x);
}

export function arcParams(center: Vec2, start: Vec2, end: Vec2): ArcParams {
  const startAngle = angleOf(center, start);
  let endAngle = angleOf(center, end);
  while (endAngle <= startAngle) {
    endAngle += TAU;
  }
  while (endAngle > startAngle + TAU) {
    endAngle -= TAU;
  }
  return { radius: distance(center, start), startAngle, endAngle };
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

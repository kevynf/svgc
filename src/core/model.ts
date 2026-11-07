export type Id = string;

/**
 * Coordinates use the SVG convention: origin top-left, Y axis pointing down.
 */
export interface Point {
  readonly kind: 'point';
  readonly id: Id;
  readonly x: number;
  readonly y: number;
}

export interface Line {
  readonly kind: 'line';
  readonly id: Id;
  readonly p1: Id;
  readonly p2: Id;
  readonly construction?: boolean;
}

export interface Circle {
  readonly kind: 'circle';
  readonly id: Id;
  readonly center: Id;
  readonly radius: number;
  readonly construction?: boolean;
}

/**
 * Runs from `start` to `end` clockwise on screen (increasing angle in Y-down
 * coordinates). Radius and angles are derived from the three points.
 */
export interface Arc {
  readonly kind: 'arc';
  readonly id: Id;
  readonly center: Id;
  readonly start: Id;
  readonly end: Id;
  readonly construction?: boolean;
}

export type Entity = Point | Line | Circle | Arc;
export type EntityKind = Entity['kind'];

/** A literal number or the name of a sketch parameter. */
export type Value = number | string;

export type Constraint =
  | { readonly kind: 'coincident'; readonly id: Id; readonly a: Id; readonly b: Id }
  /** Locks a point at the given position. */
  | {
      readonly kind: 'fix';
      readonly id: Id;
      readonly point: Id;
      readonly x: number;
      readonly y: number;
    }
  /** A line, or two points when `b` is given. */
  | { readonly kind: 'horizontal'; readonly id: Id; readonly a: Id; readonly b?: Id }
  /** A line, or two points when `b` is given. */
  | { readonly kind: 'vertical'; readonly id: Id; readonly a: Id; readonly b?: Id }
  | { readonly kind: 'parallel'; readonly id: Id; readonly a: Id; readonly b: Id }
  | { readonly kind: 'perpendicular'; readonly id: Id; readonly a: Id; readonly b: Id }
  /** Equal length for two lines, equal radius for circles and arcs. */
  | { readonly kind: 'equal'; readonly id: Id; readonly a: Id; readonly b: Id }
  /** Between a line and a circle/arc, or two circles/arcs. */
  | { readonly kind: 'tangent'; readonly id: Id; readonly a: Id; readonly b: Id }
  | { readonly kind: 'pointOnLine'; readonly id: Id; readonly point: Id; readonly line: Id }
  | { readonly kind: 'pointOnCurve'; readonly id: Id; readonly point: Id; readonly curve: Id }
  | { readonly kind: 'midpoint'; readonly id: Id; readonly point: Id; readonly line: Id }
  /** Two points mirrored about a line. */
  | {
      readonly kind: 'symmetric';
      readonly id: Id;
      readonly a: Id;
      readonly b: Id;
      readonly line: Id;
    }
  /**
   * The dimensions: the constraints that carry a measured value. Each may also
   * carry a `placement` — where the user put the dimension when they placed it,
   * in the units the per-kind comments give. It is presentation only: the
   * solver ignores it, and absent means the default anchor (see
   * `render/dimensions.ts`). A `driven` one is a measurement that is drawn but
   * never enforced: the solver ignores it, so the geometry stays exactly as free
   * as it was.
   */
  /**
   * Point-to-point, or point-to-line when either side is a line. `placement` is
   * the signed perpendicular distance (world px) from the measured segment to
   * the dimension line, positive on the side `segmentNormal` points — above a
   * left-to-right segment. For a point and a line it is instead the signed
   * distance (world px) along the line, from the perpendicular foot, that the
   * dimension line is shifted.
   */
  | {
      readonly kind: 'distance';
      readonly id: Id;
      readonly a: Id;
      readonly b: Id;
      readonly value: Value;
      readonly placement?: number;
      readonly driven?: boolean;
    }
  /** `placement` is the leader's direction in radians — atan2, Y pointing down — clamped onto the arc's sweep for an arc. */
  | {
      readonly kind: 'radius';
      readonly id: Id;
      readonly curve: Id;
      readonly value: Value;
      readonly placement?: number;
      readonly driven?: boolean;
    }
  /**
   * Degrees, measured counterclockwise on screen from line `a` to line `b`.
   * `placement` is the dimension arc's radius, in world px.
   */
  | {
      readonly kind: 'angle';
      readonly id: Id;
      readonly a: Id;
      readonly b: Id;
      readonly value: Value;
      readonly placement?: number;
      readonly driven?: boolean;
    };

export type ConstraintKind = Constraint['kind'];

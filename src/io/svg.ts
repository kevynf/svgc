import { arcParams, sketchExtent } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Entity, Id, Point } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { Artboard, EntityIndex, Sketch } from '../core/sketch';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Id of the clip path that confines the exported geometry to the artboard. */
const ARTBOARD_CLIP = 'svgc-artboard';
const INDENT = '  ';

export interface SvgOptions {
  /** Stroke colour of the exported geometry; defaults to black. */
  readonly stroke?: string;
  /** Stroke width in viewBox units; defaults to 1. */
  readonly strokeWidth?: number;
  /** Extra attributes for the root <svg> element (e.g. a class or an id). */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * The sketch as a standalone SVG document: one element per non-construction
 * curve, in world coordinates. Sketch points are not exported — they are
 * construction aids, not geometry. With an artboard the document is the page
 * the user defined and the geometry is clipped to it, so curves reaching
 * outside it still exist in the model but are cut off in the file.
 */
export function sketchToSvg(sketch: Sketch, options: SvgOptions = {}): string {
  const index = indexEntities(sketch);
  const artboard = sketch.artboard;
  const curves = sketch.entities.flatMap((entity) => {
    const element = curveElement(entity, index);
    return element === undefined ? [] : [element];
  });

  const lines = [`<svg${rootAttributes(exportedPage(sketch), options)}>`];
  if (artboard === undefined) {
    lines.push(...curves.map((element) => indent(1, element)));
  } else {
    // The clip path is the page itself, so it clips rather than scales: the
    // viewBox and the clip rect are the same rectangle, and geometry outside
    // it is dropped from the rendering, never from the model.
    lines.push(
      indent(1, '<defs>'),
      indent(2, `<clipPath id="${ARTBOARD_CLIP}">`),
      indent(3, `<rect x="${artboard.x}" y="${artboard.y}" width="${artboard.width}" height="${artboard.height}"/>`),
      indent(2, '</clipPath>'),
      indent(1, '</defs>'),
      indent(1, `<g clip-path="url(#${ARTBOARD_CLIP})">`),
      ...curves.map((element) => indent(2, element)),
      indent(1, '</g>'),
    );
  }
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

function indent(level: number, text: string): string {
  return INDENT.repeat(level) + text;
}

/**
 * The exported page: the artboard when the sketch has one, otherwise the
 * geometry bounds. An empty sketch has no bounds to fall back on, and a
 * degenerate one (a lone point, a flat sketch) would give the viewBox a zero
 * axis — which SVG treats as an error and renders nothing — so both fall back
 * to one unit at the origin.
 */
function exportedPage(sketch: Sketch): Artboard {
  const artboard = sketch.artboard;
  if (artboard !== undefined) return artboard;
  const extent = sketchExtent(sketch);
  if (extent === undefined) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: extent.minX,
    y: extent.minY,
    width: Math.max(1, extent.maxX - extent.minX),
    height: Math.max(1, extent.maxY - extent.minY),
  };
}

function rootAttributes(page: Artboard, options: SvgOptions): string {
  const attrs = new Map<string, string>([
    ['xmlns', SVG_NS],
    ['viewBox', `${page.x} ${page.y} ${page.width} ${page.height}`],
    ['width', String(page.width)],
    ['height', String(page.height)],
    ['fill', 'none'],
    ['stroke', options.stroke ?? '#000'],
    ['stroke-width', String(options.strokeWidth ?? 1)],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
  ]);
  // The caller's attributes are applied last, so they override the defaults.
  // They are set on the map rather than appended so that each name stays
  // unique: a document with the same attribute twice is not well formed.
  for (const [name, value] of Object.entries(options.attributes ?? {})) attrs.set(name, value);
  return [...attrs].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
}

/** The five XML predefined entities: every character an attribute value needs escaped. */
const ATTR_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escapes a value interpolated into a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ATTR_ESCAPES[char] ?? char);
}

/**
 * One non-construction curve as an SVG element in world coordinates, or
 * undefined for a point or for a curve missing one of its points. The
 * coordinates are numbers, which cannot carry markup, so they are interpolated
 * as they are; only the caller's text options go through `escapeAttr`.
 */
function curveElement(entity: Entity, index: EntityIndex): string | undefined {
  // Construction curves are drafting aids rather than geometry, so they are
  // left out of the export the way they are drawn dashed on the canvas.
  if (entity.kind !== 'point' && entity.construction === true) return undefined;
  switch (entity.kind) {
    case 'point':
      // Sketch points are construction aids, not geometry: the curve endpoints
      // and centers they define are exported with the curve itself.
      return undefined;
    case 'line': {
      const a = pointAt(index, entity.p1);
      const b = pointAt(index, entity.p2);
      if (a === undefined || b === undefined) return undefined;
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    }
    case 'circle': {
      const center = pointAt(index, entity.center);
      if (center === undefined) return undefined;
      return `<circle cx="${center.x}" cy="${center.y}" r="${entity.radius}"/>`;
    }
    case 'arc': {
      const center = pointAt(index, entity.center);
      const start = pointAt(index, entity.start);
      const end = pointAt(index, entity.end);
      if (center === undefined || start === undefined || end === undefined) return undefined;
      return `<path d="${arcData(center, start, end)}"/>`;
    }
  }
}

function pointAt(index: EntityIndex, id: Id): Point | undefined {
  const entity = index.get(id);
  return entity?.kind === 'point' ? entity : undefined;
}

/**
 * SVG path data for an arc running clockwise on screen from start to end, in
 * world coordinates: the model's arc convention. The Y axis points down, so a
 * clockwise sweep on screen is the SVG sweep flag 1, and the large-arc flag
 * follows whether the sweep passes the half turn.
 */
function arcData(center: Vec2, start: Vec2, end: Vec2): string {
  const { radius, startAngle, endAngle } = arcParams(center, start, end);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

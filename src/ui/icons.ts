// Tabler Icons (MIT), outline style: 24×24 grid, 2px round strokes, currentColor.
import artboard from '@tabler/icons/outline/artboard.svg?raw';
import arrowBackUp from '@tabler/icons/outline/arrow-back-up.svg?raw';
import arrowBarToRight from '@tabler/icons/outline/arrow-bar-to-right.svg?raw';
import arrowForwardUp from '@tabler/icons/outline/arrow-forward-up.svg?raw';
import arrowsHorizontal from '@tabler/icons/outline/arrows-horizontal.svg?raw';
import arrowsVertical from '@tabler/icons/outline/arrows-vertical.svg?raw';
import borderCornerRounded from '@tabler/icons/outline/border-corner-rounded.svg?raw';
import boxMargin from '@tabler/icons/outline/box-margin.svg?raw';
import check from '@tabler/icons/outline/check.svg?raw';
import circleDot from '@tabler/icons/outline/circle-dot.svg?raw';
import equal from '@tabler/icons/outline/equal.svg?raw';
import flipHorizontal from '@tabler/icons/outline/flip-horizontal.svg?raw';
import language from '@tabler/icons/outline/language.svg?raw';
import line from '@tabler/icons/outline/line.svg?raw';
import lineDashed from '@tabler/icons/outline/line-dashed.svg?raw';
import lock from '@tabler/icons/outline/lock.svg?raw';
import parentheses from '@tabler/icons/outline/parentheses.svg?raw';
import point from '@tabler/icons/outline/point.svg?raw';
import pointer from '@tabler/icons/outline/pointer.svg?raw';
import rectangle from '@tabler/icons/outline/rectangle.svg?raw';
import repeat from '@tabler/icons/outline/repeat.svg?raw';
import rulerMeasure from '@tabler/icons/outline/ruler-measure.svg?raw';
import scissors from '@tabler/icons/outline/scissors.svg?raw';
import trash from '@tabler/icons/outline/trash.svg?raw';
import vectorBezierArc from '@tabler/icons/outline/vector-bezier-arc.svg?raw';
import x from '@tabler/icons/outline/x.svg?raw';
import zoomScan from '@tabler/icons/outline/zoom-scan.svg?raw';

const sources = {
  arc: vectorBezierArc,
  artboard,
  cancel: x,
  circle: circleDot,
  construction: lineDashed,
  delete: trash,
  dimension: rulerMeasure,
  driven: parentheses,
  equal,
  extend: arrowBarToRight,
  fillet: borderCornerRounded,
  fix: lock,
  horizontal: arrowsHorizontal,
  language,
  line,
  mirror: flipHorizontal,
  offset: boxMargin,
  ok: check,
  point,
  rectangle,
  redo: arrowForwardUp,
  repeat,
  select: pointer,
  trim: scissors,
  undo: arrowBackUp,
  vertical: arrowsVertical,
  zoomAll: zoomScan,
} as const;

export type IconName = keyof typeof sources;

const parser = new DOMParser();

/** A fresh, decorative SVG element for the named icon. */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const doc = parser.parseFromString(sources[name], 'image/svg+xml');
  const svg = doc.documentElement as unknown as SVGSVGElement;
  svg.removeAttribute('class');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return document.importNode(svg, true);
}

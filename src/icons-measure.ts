// Dev-only: measures each icon's real ink bounding box via getBBox() and prints
// the offset needed to center it in the 24×24 grid. Open /measure.html.
import { icon } from './ui/icons';
import type { IconName } from './ui/icons';
import { CONSTRAINT_GLYPHS, constraintIcon } from './ui/constraint-icons';

const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
host.setAttribute('width', '0');
host.setAttribute('height', '0');
host.style.position = 'absolute';
document.body.append(host);

const lines: string[] = [];
const measure = (name: string, make: () => SVGSVGElement) => {
  const svg = make();
  // Tabler ships a transparent full-canvas background path; it dominates getBBox.
  for (const path of [...svg.querySelectorAll('path')]) {
    if (path.getAttribute('stroke') === 'none' && path.getAttribute('fill') === 'none')
      path.remove();
  }
  host.append(svg);
  const b = svg.getBBox();
  svg.remove();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  lines.push(
    `${name.padEnd(22)} ${b.x.toFixed(1)},${b.y.toFixed(1)} → ${(b.x + b.width).toFixed(1)},${(b.y + b.height).toFixed(1)}` +
      `  center ${cx.toFixed(1)},${cy.toFixed(1)}  offset ${(12 - cx).toFixed(2)},${(12 - cy).toFixed(2)}`,
  );
};

const tabler: IconName[] = [
  'line',
  'circle',
  'arc',
  'rectangle',
  'point',
  'trim',
  'extend',
  'offset',
  'mirror',
  'fillet',
  'dimension',
  'fix',
  'equal',
  'horizontal',
  'vertical',
  'construction',
  'driven',
  'artboard',
  'undo',
  'redo',
  'delete',
  'zoomAll',
  'language',
  'repeat',
  'chevronDown',
  'chevronUp',
  'ok',
  'cancel',
];
for (const name of tabler) measure(`tabler:${name}`, () => icon(name, 24));
for (const glyph of CONSTRAINT_GLYPHS) measure(`glyph:${glyph}`, () => constraintIcon(glyph, 24));

document.querySelector('#out')!.textContent = lines.join('\n');

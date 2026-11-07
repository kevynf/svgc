// Dev-only page (icons.html): constraint glyphs next to Tabler icons at UI sizes.
import { CONSTRAINT_GLYPHS, constraintIcon } from './ui/constraint-icons';
import { icon } from './ui/icons';
import type { IconName } from './ui/icons';
import './style.css';

const SIZES = [14, 16, 20, 24];
const TABLER: IconName[] = [
  'line',
  'circle',
  'arc',
  'rectangle',
  'dimension',
  'fix',
  'equal',
  'horizontal',
  'vertical',
  'mirror',
  'trim',
  'fillet',
];

const root = document.querySelector<HTMLElement>('#gallery')!;
root.style.cssText =
  'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));align-content:start;gap:12px;padding:16px;background:var(--bg-canvas);min-height:100%';

function cell(caption: string, make: (size: number) => SVGSVGElement, tone: string): HTMLElement {
  const el = document.createElement('figure');
  el.style.cssText = `margin:0;padding:10px;background:var(--bg-chrome);border-radius:4px;color:${tone}`;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:end;gap:10px';
  for (const size of SIZES) row.append(make(size));
  const label = document.createElement('figcaption');
  label.textContent = caption;
  label.style.cssText = 'margin-top:6px;font-size:11px;color:var(--text-muted)';
  el.append(row, label);
  return el;
}

root.append(
  ...TABLER.map((name) => cell(`tabler: ${name}`, (s) => icon(name, s), 'var(--text)')),
  ...CONSTRAINT_GLYPHS.map((g) => cell(g, (s) => constraintIcon(g, s), 'var(--text)')),
);

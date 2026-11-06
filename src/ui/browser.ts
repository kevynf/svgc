import type { Constraint, Entity, ConstraintKind, EntityKind, Id } from '../core/model';
import type { Editor } from '../editor/editor';
import type { Translator } from '../i18n/i18n';
import { Names } from './names';
import { icon } from './icons';
import type { IconName } from './icons';
import { constraintIcon } from './constraint-icons';
import type { ConstraintGlyph } from './constraint-icons';

const WIDTH_KEY = 'svgc.browserWidth';
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const KEYBOARD_STEP = 8;

const ENTITY_ICON: Record<EntityKind, IconName> = {
  point: 'point',
  line: 'line',
  circle: 'circle',
  arc: 'arc',
};

const CONSTRAINT_ICON: Record<ConstraintKind, ConstraintGlyph> = {
  coincident: 'coincident',
  fix: 'fix',
  horizontal: 'horizontal',
  vertical: 'vertical',
  parallel: 'parallel',
  perpendicular: 'perpendicular',
  equal: 'equal',
  tangent: 'tangent',
  pointOnLine: 'pointOnLine',
  pointOnCurve: 'pointOnCurve',
  midpoint: 'midpoint',
  distance: 'distance',
  radius: 'radius',
  angle: 'angle',
};

/** A down-pointing chevron; CSS rotates it to point right when a group is collapsed. */
function twisty(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs: Record<string, string> = {
    class: 'icon',
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  svg.append(path);
  return svg;
}

interface TreeItem {
  readonly id: Id;
  readonly label: string;
  readonly icon: SVGSVGElement;
  readonly construction?: boolean;
}

/**
 * Left-hand browser: the sketch's geometry and constraints as an Inventor-style
 * tree, with expandable groups, per-item type icons, and selection/hover kept in
 * sync with the canvas. Resizable by a drag handle on its right edge.
 */
export class Browser {
  readonly element = document.createElement('nav');
  private readonly tree = document.createElement('ul');
  private readonly resizer = document.createElement('div');
  /** Rebuilds only when the sketch structure changes, not on every hover. */
  private signature = '';

  constructor(
    private readonly editor: Editor,
    private readonly t: Translator,
  ) {
    this.element.className = 'browser';
    this.element.setAttribute('aria-label', t.t('browser.label'));
    const header = document.createElement('h2');
    header.className = 'browser-title';
    header.textContent = t.t('browser.label');
    this.tree.className = 'browser-tree';
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-multiselectable', 'true');
    this.tree.setAttribute('aria-label', t.t('browser.label'));

    this.resizer.className = 'browser-resizer';
    this.resizer.setAttribute('role', 'separator');
    this.resizer.setAttribute('aria-orientation', 'vertical');
    this.resizer.setAttribute('aria-label', t.t('browser.resize'));
    this.resizer.tabIndex = 0;
    this.bindResizer();

    this.element.append(header, this.tree, this.resizer);

    const stored = Number.parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10);
    this.applyWidth(Number.isFinite(stored) ? stored : DEFAULT_WIDTH);

    this.tree.addEventListener('click', (event) => this.onClick(event));
    this.tree.addEventListener('pointerover', (event) => editor.setHover(this.itemId(event.target)));
    this.tree.addEventListener('pointerleave', () => editor.setHover(undefined));
    this.tree.addEventListener('keydown', (event) => this.onKey(event));
  }

  update(): void {
    const { sketch } = this.editor;
    const signature = [
      ...sketch.entities.map((e) => `${e.id}:${e.kind !== 'point' && e.construction === true ? 'c' : ''}`),
      ...sketch.constraints.map((c) => c.id),
    ].join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild();
    }
    for (const item of this.tree.querySelectorAll<HTMLElement>('[data-id]')) {
      const id = item.dataset['id']!;
      item.setAttribute('aria-selected', String(this.editor.selection.has(id)));
      item.classList.toggle('hover', this.editor.hover === id);
    }
  }

  // ── Tree building ──────────────────────────────────────────────────────

  private rebuild(): void {
    const { sketch } = this.editor;
    const names = new Names(sketch, this.t);

    // Preserve each group's expansion state and the focused element across rebuilds.
    const expanded = new Map<string, boolean>();
    for (const g of this.tree.querySelectorAll<HTMLElement>('.browser-group')) {
      const key = g.dataset['group'];
      if (key !== undefined) expanded.set(key, g.getAttribute('aria-expanded') === 'true');
    }
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusId = active?.dataset['id'];
    const focusGroup = active?.classList.contains('browser-group') ? active.dataset['group'] : undefined;

    this.tree.replaceChildren(
      this.group('geometry', this.t.t('browser.geometry'), sketch.entities.filter((e) => e.kind !== 'point').map((e) => this.geometryItem(e, names))),
      this.group('constraints', this.t.t('browser.constraints'), sketch.constraints.map((c) => this.constraintItem(c, names))),
    );

    for (const g of this.tree.querySelectorAll<HTMLElement>('.browser-group')) {
      const key = g.dataset['group'];
      this.setGroupExpanded(g, (key !== undefined ? expanded.get(key) : undefined) ?? true);
    }

    const visible = this.visibleItems();
    const restore =
      visible.find((el) => focusId !== undefined && el.dataset['id'] === focusId) ??
      visible.find((el) => focusGroup !== undefined && el.dataset['group'] === focusGroup);
    const target = restore ?? visible[0];
    for (const el of visible) el.tabIndex = -1;
    if (target !== undefined) {
      target.tabIndex = 0;
      if (restore !== undefined) target.focus();
    }
  }

  private group(key: string, label: string, items: TreeItem[]): HTMLElement {
    const li = document.createElement('li');
    li.className = 'browser-group';
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-expanded', 'true');
    li.setAttribute('aria-label', `${label} (${items.length})`);
    li.dataset['group'] = key;
    li.tabIndex = -1;

    const labelEl = document.createElement('span');
    labelEl.className = 'browser-group-label';
    labelEl.textContent = label;
    const count = document.createElement('span');
    count.className = 'browser-group-count';
    count.textContent = String(items.length);
    const head = document.createElement('div');
    head.className = 'browser-group-header';
    head.append(twisty(), labelEl, count);

    const ul = document.createElement('ul');
    ul.setAttribute('role', 'group');
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'browser-empty';
      empty.textContent = this.t.t('browser.empty');
      ul.append(empty);
    }
    for (const item of items) ul.append(this.item(item));

    li.append(head, ul);
    return li;
  }

  private item(item: TreeItem): HTMLElement {
    const el = document.createElement('li');
    el.className = 'browser-item';
    if (item.construction === true) el.classList.add('construction');
    el.setAttribute('role', 'treeitem');
    el.dataset['id'] = item.id;
    el.tabIndex = -1;
    const label = document.createElement('span');
    label.className = 'browser-item-label';
    label.textContent = item.label;
    el.append(item.icon, label);
    return el;
  }

  private geometryItem(e: Entity, names: Names): TreeItem {
    return {
      id: e.id,
      label: names.entity(e.id),
      icon: icon(ENTITY_ICON[e.kind], 16),
      construction: e.kind !== 'point' && e.construction === true,
    };
  }

  private constraintItem(c: Constraint, names: Names): TreeItem {
    return { id: c.id, label: names.constraint(c), icon: constraintIcon(CONSTRAINT_ICON[c.kind], 16) };
  }

  // ── Interaction ────────────────────────────────────────────────────────

  private onClick(event: MouseEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const itemEl = target?.closest<HTMLElement>('.browser-item');
    if (itemEl !== undefined && itemEl !== null) {
      this.editor.select([itemEl.dataset['id']!], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
      this.setRoving(itemEl);
      itemEl.focus();
      return;
    }
    const group = target?.closest('.browser-group-header')?.closest<HTMLElement>('.browser-group');
    if (group !== undefined && group !== null) this.toggleGroup(group);
  }

  private onKey(event: KeyboardEvent): void {
    const items = this.visibleItems();
    const current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const index = items.findIndex((el) => el === current);
    if (index < 0) return;
    const el = items[index]!;
    const isGroup = el.classList.contains('browser-group');
    let next: number | undefined;

    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(items.length - 1, index + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, index - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'ArrowRight':
        event.preventDefault();
        event.stopPropagation();
        if (isGroup && el.getAttribute('aria-expanded') === 'false') this.setGroupExpanded(el, true);
        else if (isGroup) next = index + 1;
        break;
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        if (isGroup && el.getAttribute('aria-expanded') === 'true') {
          this.setGroupExpanded(el, false);
        } else {
          const parent = el.parentElement?.closest<HTMLElement>('.browser-group');
          if (parent != null) {
            this.setRoving(parent);
            parent.focus();
            this.editor.setHover(undefined);
          }
        }
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        if (isGroup) this.toggleGroup(el);
        else this.editor.select([el.dataset['id']!], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
        return;
    }

    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const target = items[next]!;
    this.setRoving(target);
    target.focus();
    this.editor.setHover(target.dataset['id']);
  }

  private toggleGroup(li: HTMLElement): void {
    this.setGroupExpanded(li, li.getAttribute('aria-expanded') !== 'true');
  }

  private setGroupExpanded(li: HTMLElement, expanded: boolean): void {
    li.setAttribute('aria-expanded', String(expanded));
    const ul = li.querySelector<HTMLElement>(':scope > ul[role="group"]');
    if (ul !== null) ul.hidden = !expanded;
  }

  private setRoving(el: HTMLElement): void {
    for (const item of this.items()) item.tabIndex = -1;
    el.tabIndex = 0;
  }

  private items(): HTMLElement[] {
    return [...this.tree.querySelectorAll<HTMLElement>('.browser-group, .browser-item')];
  }

  /** Tree items that are not hidden inside a collapsed group. */
  private visibleItems(): HTMLElement[] {
    return this.items().filter((el) => el.parentElement?.closest('.browser-group[aria-expanded="false"]') == null);
  }

  private itemId(target: EventTarget | null): Id | undefined {
    return target instanceof HTMLElement ? target.closest<HTMLElement>('[data-id]')?.dataset['id'] : undefined;
  }

  // ── Resizing ───────────────────────────────────────────────────────────

  private currentWidth(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--browser-width');
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : this.element.getBoundingClientRect().width;
  }

  private applyWidth(width: number): void {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
    document.documentElement.style.setProperty('--browser-width', `${clamped}px`);
    this.resizer.setAttribute('aria-valuenow', String(clamped));
    this.resizer.setAttribute('aria-valuemin', String(MIN_WIDTH));
    this.resizer.setAttribute('aria-valuemax', String(MAX_WIDTH));
  }

  private persistWidth(): void {
    localStorage.setItem(WIDTH_KEY, String(this.currentWidth()));
  }

  private bindResizer(): void {
    this.resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.resizer.setPointerCapture(event.pointerId);
      this.resizer.dataset['dragging'] = 'true';
      const startX = event.clientX;
      const startWidth = this.currentWidth();
      const move = (e: PointerEvent) => this.applyWidth(startWidth + (e.clientX - startX));
      const stop = (e: PointerEvent) => {
        this.resizer.releasePointerCapture(e.pointerId);
        delete this.resizer.dataset['dragging'];
        this.resizer.removeEventListener('pointermove', move);
        this.resizer.removeEventListener('pointerup', stop);
        this.resizer.removeEventListener('pointercancel', stop);
        this.persistWidth();
      };
      this.resizer.addEventListener('pointermove', move);
      this.resizer.addEventListener('pointerup', stop);
      this.resizer.addEventListener('pointercancel', stop);
    });

    this.resizer.addEventListener('keydown', (event) => {
      let next: number | undefined;
      if (event.key === 'ArrowLeft') next = this.currentWidth() - KEYBOARD_STEP;
      else if (event.key === 'ArrowRight') next = this.currentWidth() + KEYBOARD_STEP;
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      this.applyWidth(next);
      this.persistWidth();
    });

    // A double-click restores the default width.
    this.resizer.addEventListener('dblclick', () => {
      this.applyWidth(DEFAULT_WIDTH);
      this.persistWidth();
    });
  }
}

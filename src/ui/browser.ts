import type { Id } from '../core/model';
import type { Editor } from '../editor/editor';
import type { Translator } from '../i18n/i18n';
import { Names } from './names';

/**
 * Left-hand browser: the sketch's geometry and constraints as a tree, with
 * selection and hover synchronized with the canvas.
 */
export class Browser {
  readonly element = document.createElement('nav');
  private readonly tree = document.createElement('ul');
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
    this.element.append(header, this.tree);

    this.tree.addEventListener('click', (event) => {
      const id = this.itemId(event.target);
      if (id === undefined) return;
      editor.select([id], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
    });
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

  private rebuild(): void {
    const { sketch } = this.editor;
    const names = new Names(sketch, this.t);
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['id'] : undefined;

    const group = (label: string, items: { id: Id; label: string }[]) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-expanded', 'true');
      const title = document.createElement('span');
      title.className = 'browser-group';
      title.textContent = `${label} (${items.length})`;
      const ul = document.createElement('ul');
      ul.setAttribute('role', 'group');
      if (items.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'browser-empty';
        empty.textContent = this.t.t('browser.empty');
        ul.append(empty);
      }
      for (const item of items) {
        const el = document.createElement('li');
        el.setAttribute('role', 'treeitem');
        el.className = 'browser-item';
        el.dataset['id'] = item.id;
        el.tabIndex = -1;
        el.textContent = item.label;
        ul.append(el);
      }
      li.append(title, ul);
      return li;
    };

    this.tree.replaceChildren(
      group(
        this.t.t('browser.geometry'),
        sketch.entities.filter((e) => e.kind !== 'point').map((e) => ({ id: e.id, label: names.entity(e.id) })),
      ),
      group(
        this.t.t('browser.constraints'),
        sketch.constraints.map((c) => ({ id: c.id, label: names.constraint(c) })),
      ),
    );

    const items = this.items();
    const restore = items.find((el) => el.dataset['id'] === focused);
    (restore ?? items[0])?.setAttribute('tabindex', '0');
    restore?.focus();
  }

  private items(): HTMLElement[] {
    return [...this.tree.querySelectorAll<HTMLElement>('.browser-item')];
  }

  private onKey(event: KeyboardEvent): void {
    const items = this.items();
    const index = items.findIndex((el) => el === document.activeElement);
    if (index < 0) return;
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = Math.min(items.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      const id = items[index]!.dataset['id']!;
      this.editor.select([id], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    items[index]!.tabIndex = -1;
    items[next]!.tabIndex = 0;
    items[next]!.focus();
    this.editor.setHover(items[next]!.dataset['id']);
  }

  private itemId(target: EventTarget | null): Id | undefined {
    return target instanceof HTMLElement ? target.closest<HTMLElement>('[data-id]')?.dataset['id'] : undefined;
  }
}

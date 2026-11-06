import type { Key, Translator } from '../i18n/i18n';
import { icon } from './icons';
import type { IconName } from './icons';

const COLLAPSE_KEY = 'svgc.ribbonCollapsed';

export interface RibbonButton {
  readonly id: string;
  readonly icon: IconName;
  readonly label: Key;
  readonly shortcut?: string;
  readonly size?: 'large' | 'small';
  /** Unimplemented buttons are shown disabled so the layout matches the final ribbon. */
  readonly available: boolean;
  readonly run: () => void;
  readonly enabled?: () => boolean;
  readonly active?: () => boolean;
}

export interface RibbonPanel {
  readonly label: Key;
  readonly buttons: readonly RibbonButton[];
}

/** Inventor-style ribbon: one tab's panels of large and small buttons. */
export class Ribbon {
  readonly element = document.createElement('div');
  private readonly buttons = new Map<string, { def: RibbonButton; el: HTMLButtonElement }>();
  /** The collapse toggle lives in the header strip, so it is exposed as a button. */
  readonly collapseToggle: HTMLButtonElement;

  constructor(
    private readonly t: Translator,
    panels: readonly RibbonPanel[],
  ) {
    this.element.className = 'ribbon';
    this.element.id = 'ribbon-body';
    this.element.setAttribute('role', 'tabpanel');
    this.element.setAttribute('aria-labelledby', 'ribbon-tab-sketch');
    this.element.append(...panels.map((p) => this.panel(p)));

    this.collapseToggle = document.createElement('button');
    this.collapseToggle.type = 'button';
    this.collapseToggle.className = 'ribbon-collapse';
    this.collapseToggle.title = t.t('ribbon.collapse');
    this.collapseToggle.setAttribute('aria-label', t.t('ribbon.collapse'));
    this.collapseToggle.setAttribute('aria-controls', this.element.id);
    this.collapseToggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    this.setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
  }

  get collapsed(): boolean {
    return this.element.dataset['collapsed'] === 'true';
  }

  private setCollapsed(collapsed: boolean): void {
    this.element.dataset['collapsed'] = String(collapsed);
    this.collapseToggle.setAttribute('aria-expanded', String(!collapsed));
    this.collapseToggle.replaceChildren(icon(collapsed ? 'chevronDown' : 'chevronUp', 14));
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }

  /** Refreshes enabled/pressed states. */
  update(): void {
    for (const { def, el } of this.buttons.values()) {
      el.disabled = !def.available || (def.enabled?.() ?? true) === false;
      if (def.active !== undefined) el.setAttribute('aria-pressed', String(def.active()));
    }
  }

  private panel(panel: RibbonPanel): HTMLElement {
    const section = document.createElement('section');
    section.className = 'ribbon-panel';
    const group = document.createElement('div');
    group.className = 'ribbon-buttons';
    group.setAttribute('role', 'toolbar');
    const title = document.createElement('h2');
    title.className = 'ribbon-panel-title';
    title.textContent = this.t.t(panel.label);
    group.setAttribute('aria-label', title.textContent);

    // Small buttons flow into 3-row columns; each column fills its rows so
    // panels of different button counts still line up in height.
    const stacks: HTMLElement[] = [];
    for (const def of panel.buttons) {
      const el = this.button(def);
      if (def.size === 'small') {
        let stack = stacks.at(-1);
        if (stack === undefined || stack.childElementCount === 3) {
          stack = document.createElement('div');
          stack.className = 'ribbon-stack';
          stacks.push(stack);
          group.append(stack);
        }
        stack.append(el);
      } else {
        stacks.length = 0;
        group.append(el);
      }
    }
    section.append(group, title);
    return section;
  }

  private button(def: RibbonButton): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `ribbon-button ${def.size ?? 'large'}`;
    el.dataset['command'] = def.id;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = this.t.t(def.label);
    el.append(icon(def.icon, def.size === 'small' ? 16 : 24), label);

    const tips = [this.t.t(def.label)];
    if (def.shortcut !== undefined) tips.push(this.t.t('ribbon.shortcut', { keys: def.shortcut }));
    if (!def.available) tips.push(this.t.t('ribbon.comingSoon'));
    el.title = tips.join('\n');
    if (def.shortcut !== undefined) el.setAttribute('aria-keyshortcuts', def.shortcut.replace(/\s/g, ''));

    el.addEventListener('click', () => def.run());
    this.buttons.set(def.id, { def, el });
    return el;
  }
}

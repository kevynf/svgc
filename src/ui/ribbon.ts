import type { Key, Translator } from '../i18n/i18n';
import { icon } from './icons';
import type { IconName } from './icons';

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

/** Inventor-style ribbon: one tab, labeled panels of large and small buttons. */
export class Ribbon {
  readonly element = document.createElement('div');
  private readonly buttons = new Map<string, { def: RibbonButton; el: HTMLButtonElement }>();

  constructor(
    private readonly t: Translator,
    tab: Key,
    panels: readonly RibbonPanel[],
  ) {
    this.element.className = 'ribbon';

    const tabs = document.createElement('div');
    tabs.className = 'ribbon-tabs';
    tabs.setAttribute('role', 'tablist');
    const tabButton = document.createElement('button');
    tabButton.className = 'ribbon-tab';
    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-selected', 'true');
    tabButton.id = 'ribbon-tab-sketch';
    tabButton.textContent = t.t(tab);
    tabs.append(tabButton);

    const body = document.createElement('div');
    body.className = 'ribbon-body';
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', tabButton.id);
    body.append(...panels.map((p) => this.panel(p)));

    this.element.append(tabs, body);
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

    let stack: HTMLElement | undefined;
    for (const def of panel.buttons) {
      const el = this.button(def);
      if (def.size === 'small') {
        if (stack === undefined || stack.childElementCount === 3) {
          stack = document.createElement('div');
          stack.className = 'ribbon-stack';
          group.append(stack);
        }
        stack.append(el);
      } else {
        stack = undefined;
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

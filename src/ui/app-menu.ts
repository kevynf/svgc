import type { Key, Translator } from '../i18n/i18n';
import { icon } from './icons';
import './app-menu.css';

/** What choosing each of the menu's items runs. */
export interface AppMenuActions {
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  readonly onExportSvg: () => void;
}

/** One menu item: the command it runs and its label's message key. */
export interface AppMenuItem {
  readonly id: 'new' | 'open' | 'save' | 'exportSvg';
  readonly labelKey: Key;
}

/** The label of each item, by command. */
const ITEM_LABELS: Record<AppMenuItem['id'], Key> = {
  new: 'file.new',
  open: 'file.open',
  save: 'file.save',
  exportSvg: 'file.exportSvg',
};

/** The menu's items, in order: pure, for tests. */
export function appMenuItems(): readonly AppMenuItem[] {
  return [
    { id: 'new', labelKey: ITEM_LABELS.new },
    { id: 'open', labelKey: ITEM_LABELS.open },
    { id: 'save', labelKey: ITEM_LABELS.save },
    { id: 'exportSvg', labelKey: ITEM_LABELS.exportSvg },
  ];
}

/**
 * Inventor's application menu: the button at the far left of the title strip, opening a dropdown of
 * the file commands. The button is `element`; the card is `panel`, appended to `document.body`
 * while open and sharing the ribbon's raised chrome so it reads as part of the title bar. Closed by
 * Esc, by choosing an item, or by a click outside; focus moves into the panel on open and back to
 * the button on close. All DOM is built in the constructor, so the module imports cleanly under
 * Node (where `document` is absent) — the pure helper above stays testable there.
 */
export class AppMenu {
  readonly element: HTMLElement;
  readonly panel: HTMLElement;
  private readonly items = new Map<AppMenuItem['id'], HTMLButtonElement>();
  private opened = false;
  private invoker: HTMLElement | undefined;
  /** The outside-click listener, registered only while the menu is open. */
  private outside: ((event: PointerEvent) => void) | undefined;

  constructor(
    private readonly actions: AppMenuActions,
    private readonly t: Translator,
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-menu-button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = t.t('app.title');
    button.append(icon('chevronDown', 12));
    button.addEventListener('click', () => this.toggle());
    this.element = button;

    this.panel = document.createElement('div');
    this.panel.className = 'app-menu-panel';
    this.panel.setAttribute('role', 'menu');
    this.panel.setAttribute('aria-label', t.t('app.title'));
    for (const item of appMenuItems()) this.panel.append(this.item(item));
    this.panel.addEventListener('keydown', (event) => this.onKeydown(event));
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(invoker: HTMLElement = this.element): void {
    if (this.opened) return;
    this.opened = true;
    this.invoker = invoker;
    const rect = this.element.getBoundingClientRect();
    this.panel.style.left = `${rect.left}px`;
    this.panel.style.top = `${rect.bottom}px`;
    document.body.append(this.panel);
    this.element.setAttribute('aria-expanded', 'true');
    this.outside = (event) => {
      const target = event.target as Node;
      if (this.panel.contains(target) || this.element.contains(target)) return;
      this.close();
    };
    document.addEventListener('pointerdown', this.outside, true);
    this.items.values().next().value?.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    if (this.outside !== undefined) {
      document.removeEventListener('pointerdown', this.outside, true);
      this.outside = undefined;
    }
    this.panel.remove();
    this.element.setAttribute('aria-expanded', 'false');
    this.invoker?.focus();
    this.invoker = undefined;
  }

  // ── Items ──────────────────────────────────────────────────────────────

  private item(item: AppMenuItem): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'app-menu-item';
    el.dataset['item'] = item.id;
    el.setAttribute('role', 'menuitem');
    el.textContent = this.t.t(item.labelKey);
    el.addEventListener('click', () => this.choose(item.id));
    this.items.set(item.id, el);
    return el;
  }

  /** Closes first, so a slow file operation cannot leave the menu hanging. */
  private choose(id: AppMenuItem['id']): void {
    this.close();
    switch (id) {
      case 'new':
        this.actions.onNew();
        break;
      case 'open':
        this.actions.onOpen();
        break;
      case 'save':
        this.actions.onSave();
        break;
      case 'exportSvg':
        this.actions.onExportSvg();
        break;
    }
  }

  private toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  /**
   * Arrows walk the items and Esc closes. Enter and Space need no case: the
   * items are buttons, so they activate the focused one themselves.
   */
  private onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      // The shell listens for Esc on the document too; it must not back out of
      // the active command on its way past.
      event.stopPropagation();
      this.close();
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...this.items.values()];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + step + items.length) % items.length]!.focus();
  }
}

import type { Vec2 } from '../core/geometry';
import type { MenuItem } from '../editor/command';
import type { Translator } from '../i18n/i18n';
import { icon } from './icons';

/** Compass slots in Inventor's order of preference: E, W, N, S, then diagonals. */
const SLOTS = [0, 180, 270, 90, 315, 225, 45, 135] as const;
const RADIUS_PX = 96;
/** Releasing a right-drag farther than this from the center picks the item in that direction. */
const GESTURE_PX = 24;

/**
 * Radial marking menu. Right-click opens it at the cursor; click an item, or right-drag toward one
 * and release (gesture). Esc or clicking outside closes.
 */
export class MarkingMenu {
  readonly element = document.createElement('div');
  private items: readonly MenuItem[] = [];
  private center: Vec2 = { x: 0, y: 0 };
  private restoreFocus: HTMLElement | null = null;

  constructor(private readonly t: Translator) {
    this.element.className = 'marking-menu';
    this.element.setAttribute('role', 'menu');
    this.element.setAttribute('aria-label', t.t('menu.label'));
    this.element.hidden = true;
    this.element.addEventListener('keydown', (event) => this.onKey(event));
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.element.hidden && !this.element.contains(event.target as Node)) this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Opens at `at`, in coordinates relative to the menu's offset parent. */
  open(at: Vec2, items: readonly MenuItem[]): void {
    this.items = items.slice(0, SLOTS.length);
    this.center = at;
    this.restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.element.style.left = `${at.x}px`;
    this.element.style.top = `${at.y}px`;
    this.element.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'marking-menu-hub' }),
      ...this.items.map((_, i) => this.spoke(SLOTS[i]!)),
      ...this.items.map((item, i) => this.itemElement(item, SLOTS[i]!)),
    );
    this.element.hidden = false;
    this.buttons()
      .find((b) => !b.disabled)
      ?.focus();
  }

  /** Completes a right-drag gesture released at `at`. Returns true when an item ran. */
  gesture(at: Vec2): boolean {
    if (!this.isOpen) return false;
    const dx = at.x - this.center.x;
    const dy = at.y - this.center.y;
    if (Math.hypot(dx, dy) < GESTURE_PX) return false;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    let best = -1;
    let bestDiff = Infinity;
    this.items.forEach((item, i) => {
      if (!item.enabled) return;
      const diff = Math.abs(((angle - SLOTS[i]! + 540) % 360) - 180);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    if (best < 0 || bestDiff > 360 / SLOTS.length / 2 + 1) return false;
    this.choose(this.items[best]!);
    return true;
  }

  close(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.element.replaceChildren();
    this.restoreFocus?.focus();
  }

  /** A thin connector line from just outside the hub toward the item chip. */
  private spoke(degrees: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'marking-menu-spoke';
    el.style.width = `${RADIUS_PX - 40 - 15}px`;
    el.style.transform = `rotate(${degrees}deg) translateX(15px)`;
    return el;
  }

  private itemElement(item: MenuItem, degrees: number): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'marking-menu-item';
    el.setAttribute('role', 'menuitem');
    el.disabled = !item.enabled;
    const rad = (degrees * Math.PI) / 180;
    el.style.setProperty('--dx', `${Math.cos(rad) * RADIUS_PX}px`);
    el.style.setProperty('--dy', `${Math.sin(rad) * RADIUS_PX}px`);
    el.dataset['side'] =
      Math.abs(Math.cos(rad)) < 0.01 ? 'center' : Math.cos(rad) > 0 ? 'right' : 'left';
    const label = document.createElement('span');
    label.textContent = this.t.t(item.label.key, item.label.params);
    if (item.icon !== undefined) el.append(icon(item.icon, 16));
    el.append(label);
    el.addEventListener('click', () => this.choose(item));
    return el;
  }

  private choose(item: MenuItem): void {
    if (!item.enabled) return;
    this.close();
    item.run();
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.element.querySelectorAll<HTMLButtonElement>('.marking-menu-item')];
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    const enabled = this.buttons().filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const step = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
      Tab: event.shiftKey ? -1 : 1,
    }[event.key];
    if (step === undefined || enabled.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    enabled[(index + step + enabled.length) % enabled.length]!.focus();
  }
}

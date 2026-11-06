import type { Editor } from '../editor/editor';
import type { Translator } from '../i18n/i18n';

/**
 * Right-hand collapsible properties panel (Illustrator "Properties" /
 * Inventor property panel). Placeholder; see properties.css for styles.
 */
export class PropertiesPanel {
  readonly element = document.createElement('aside');

  constructor(
    readonly editor: Editor,
    readonly t: Translator,
  ) {
    this.element.className = 'properties';
    this.element.setAttribute('aria-label', t.t('properties.label'));
  }

  update(): void {}
}

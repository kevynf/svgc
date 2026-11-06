import type { Editor } from '../editor/editor';
import type { Translator } from '../i18n/i18n';

/** Bottom status bar: command prompt, cursor coordinates, constraint state. */
export class StatusBar {
  readonly element = document.createElement('footer');
  private readonly prompt = document.createElement('output');
  private readonly coords = document.createElement('span');
  private readonly selection = document.createElement('span');
  private readonly state = document.createElement('output');

  constructor(
    private readonly editor: Editor,
    private readonly t: Translator,
  ) {
    this.element.className = 'statusbar';
    this.prompt.className = 'status-prompt';
    this.prompt.setAttribute('aria-live', 'polite');
    this.coords.className = 'status-coords';
    this.selection.className = 'status-selection';
    this.state.className = 'status-state';
    this.state.setAttribute('aria-live', 'polite');
    this.element.append(this.prompt, this.selection, this.coords, this.state);
  }

  update(): void {
    const { editor, t } = this;
    const message = editor.message ?? editor.activeCommand.prompt();
    setText(this.prompt, t.t(message.key, message.params));
    this.prompt.classList.toggle('error', editor.message !== undefined);

    const cursor = editor.cursorWorld;
    setText(this.coords, cursor === undefined ? '' : t.t('status.coordinates', { x: t.number(cursor.x), y: t.number(cursor.y) }));

    const count = editor.selection.size;
    setText(this.selection, count === 0 ? '' : t.t('status.selected', { count }));

    const { dof, conflicting, outcome } = editor.solve;
    let text: string;
    let tone: 'ok' | 'pending' | 'error';
    if (conflicting.length > 0) {
      text = t.t('status.conflicting', { count: conflicting.length });
      tone = 'error';
    } else if (outcome === 'failed') {
      text = t.t('status.solveFailed');
      tone = 'error';
    } else if (dof === 0) {
      text = t.t('status.fullyConstrained');
      tone = 'ok';
    } else {
      text = t.t('status.dimensionsNeeded', { count: dof });
      tone = 'pending';
    }
    setText(this.state, text);
    this.state.dataset['tone'] = tone;
  }
}

/** Avoids re-announcing unchanged text to screen readers. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

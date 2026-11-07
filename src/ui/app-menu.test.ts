import { describe, expect, it, vi } from 'vitest';

// The menu module imports `icon()` from icons.ts, which builds a DOMParser when
// it is first imported. Under the Node test runner that global is absent, so
// provide a minimal one before the module under test is imported — the menu's
// DOM is never built here, only its pure item list is exercised.
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: class {
      parseFromString(): unknown {
        return {};
      }
    },
  });
});

import { Translator } from '../i18n/i18n';
import { appMenuItems } from './app-menu';

const zh = new Translator('zh-CN');
const en = new Translator('en');

// DOM behavior (anchoring, focus movement, Esc, click outside) needs a real
// document and is exercised in the browser preview; only the pure helpers are
// unit-tested here.
describe('appMenuItems', () => {
  it('lists the file commands in order', () => {
    expect(appMenuItems()).toEqual([
      { id: 'new', labelKey: 'file.new' },
      { id: 'open', labelKey: 'file.open' },
      { id: 'save', labelKey: 'file.save' },
      { id: 'exportSvg', labelKey: 'file.exportSvg' },
    ]);
  });

  it('labels every item in both locales', () => {
    expect(appMenuItems().map((item) => zh.t(item.labelKey))).toEqual([
      '新建',
      '打开…',
      '保存',
      '导出 SVG…',
    ]);
    expect(appMenuItems().map((item) => en.t(item.labelKey))).toEqual([
      'New',
      'Open…',
      'Save',
      'Export SVG…',
    ]);
  });
});

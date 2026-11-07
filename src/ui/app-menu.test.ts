import { describe, expect, it, vi } from 'vitest';

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

import { describe, expect, it } from 'vitest';
import { catalogKeys, catalogsForTest, Translator } from './i18n';

describe('i18n', () => {
  it('every locale has exactly the keys of the source catalog', () => {
    const source = catalogKeys(catalogsForTest['zh-CN']).sort();
    for (const catalog of Object.values(catalogsForTest)) {
      expect(catalogKeys(catalog).sort()).toEqual(source);
    }
  });

  it('interpolates parameters', () => {
    expect(new Translator('zh-CN').t('entities.line', { n: 3 })).toBe('直线3');
    expect(new Translator('en').t('commands.repeat', { command: 'Line' })).toBe('Repeat Line');
  });

  it('selects plural forms per locale', () => {
    const en = new Translator('en');
    expect(en.t('status.dimensionsNeeded', { count: 1 })).toBe('1 dimension needed');
    expect(en.t('status.dimensionsNeeded', { count: 4 })).toBe('4 dimensions needed');
    expect(new Translator('zh-CN').t('status.dimensionsNeeded', { count: 1 })).toBe('需要 1 个尺寸');
  });

  it('leaves unknown placeholders intact', () => {
    expect(new Translator('en').t('entities.line')).toBe('Line{n}');
  });
});

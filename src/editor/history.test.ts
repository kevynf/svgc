import { describe, expect, it } from 'vitest';
import { History } from './history';

describe('History', () => {
  it('undoes and redoes pushed states', () => {
    const h = new History('a');
    h.push('b');
    h.push('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBe('b');
    expect(h.current).toBe('b');
  });

  it('drops the redo branch on a new push', () => {
    const h = new History('a');
    h.push('b');
    h.undo();
    h.push('c');
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('a');
  });

  it('collapses a transaction into one step', () => {
    const h = new History('a');
    h.begin();
    h.replace('b');
    h.replace('c');
    h.end();
    expect(h.current).toBe('c');
    expect(h.undo()).toBe('a');
  });

  it('aborts a transaction back to its starting state', () => {
    const h = new History('a');
    h.push('b');
    h.begin();
    h.replace('c');
    h.abort();
    expect(h.current).toBe('b');
    expect(h.undo()).toBe('a');
  });

  it('records nothing for an unchanged transaction or push', () => {
    const h = new History('a');
    h.begin();
    h.end();
    h.push('a');
    expect(h.canUndo).toBe(false);
  });

  it('caps the number of undo steps', () => {
    const h = new History(0, 2);
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBeUndefined();
  });
});

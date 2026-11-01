import { describe, it, expect } from 'vitest';
import { rememberSelection, storedModel, storedProvider } from '../src/lib/model-selection';
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
describe('explicit model choices', () => {
  it('starts without a model and preserves independent choices when switching providers and reopening', () => {
    const s = storage();
    expect(storedModel('chatgpt', s)).toBe('');
    rememberSelection('chatgpt', 'chosen-mini', s);
    rememberSelection('claude', 'chosen-haiku', s);
    expect(storedModel('cursor', s)).toBe('');
    expect(storedProvider(s)).toBe('claude');
    expect(storedModel('chatgpt', s)).toBe('chosen-mini');
    expect(storedModel('claude', s)).toBe('chosen-haiku');
  });
  it('does not invent a default when storage is corrupted or unavailable', () => {
    const s = storage();
    s.setItem('lupino-model-choices', 'bad json');
    expect(storedModel('claude', s)).toBe('');
    rememberSelection('claude', 'explicit-model', s);
    expect(storedModel('claude', s)).toBe('explicit-model');
    const unavailable = {
      getItem: () => {
        throw Error('unavailable');
      },
      setItem: () => {
        throw Error('unavailable');
      },
    };
    expect(storedModel('cursor', unavailable)).toBe('');
    expect(() => rememberSelection('cursor', 'explicit-model', unavailable)).not.toThrow();
  });
});

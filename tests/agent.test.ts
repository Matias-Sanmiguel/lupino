import { describe, it, expect } from 'vitest';
import { parseRequest, safeFinal } from '../agent/protocol';
describe('agent request boundary', () => {
  it('accepts the selected provider and rejects arbitrary operations or oversized prompts', () => {
    expect(
      parseRequest({
        action: 'chat',
        provider: 'claude',
        prompt: '¿Cuándo es el parcial?',
        model: 'chosen-model',
      }).provider,
    ).toBe('claude');
    expect(() => parseRequest({ action: 'exec', provider: 'claude' })).toThrow();
    expect(() => parseRequest({ action: 'chat', provider: 'unknown', prompt: 'hola' })).toThrow();
    expect(() =>
      parseRequest({ action: 'chat', provider: 'claude', prompt: 'x'.repeat(50001) }),
    ).toThrow();
  });
  it('keeps grounded citations and makes invalid references explicit', () => {
    expect(safeFinal('El parcial es el viernes [1]. Otro dato [9].', 2)).toBe(
      'El parcial es el viernes [1]. Otro dato [fuente no disponible].',
    );
  });
  it('blocks missing, null and empty chat models for every provider before an SDK can select a default', () => {
    for (const provider of ['chatgpt', 'claude', 'cursor']) {
      for (const model of [undefined, null, '', '   ']) {
        expect(() => parseRequest({ action: 'chat', provider, prompt: 'Hola', model })).toThrow(
          /modelo/i,
        );
      }
      expect(
        parseRequest({ action: 'chat', provider, prompt: 'Hola', model: 'chosen-model' }).model,
      ).toBe('chosen-model');
      expect(parseRequest({ action: 'status', provider }).model).toBeUndefined();
    }
  });
});

import { describe, it, expect } from 'vitest';
import { parseRequest, safeFinal } from '../agent/protocol';
describe('agent request boundary', () => {
  it('accepts the selected provider and rejects arbitrary operations or oversized prompts', () => {
    expect(
      parseRequest({ action: 'chat', provider: 'claude', prompt: '¿Cuándo es el parcial?' })
        .provider,
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
  it('accepts the desktop null model as the provider default', () => {
    expect(
      parseRequest({ action: 'chat', provider: 'chatgpt', prompt: 'Hola', model: null }).model,
    ).toBeUndefined();
  });
});

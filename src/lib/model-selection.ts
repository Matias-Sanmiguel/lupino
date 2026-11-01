type Store = Pick<Storage, 'getItem' | 'setItem'>;
const key = 'lupino-model-choices';
const providers = ['chatgpt', 'claude', 'cursor'];
export function storedProvider(store?: Store): string {
  try {
    const value = (store ?? localStorage).getItem('lupino-provider') || '';
    return providers.includes(value) ? value : 'chatgpt';
  } catch {
    return 'chatgpt';
  }
}
export function storedModel(provider: string, store?: Store): string {
  try {
    const choices = JSON.parse((store ?? localStorage).getItem(key) || '{}');
    const value = choices?.[provider];
    return providers.includes(provider) && typeof value === 'string' && value.length <= 200
      ? value.trim()
      : '';
  } catch {
    return '';
  }
}
export function rememberSelection(provider: string, model: string, store?: Store) {
  if (!providers.includes(provider)) return;
  try {
    const storage = store ?? localStorage;
    const choices = Object.fromEntries(providers.map((p) => [p, storedModel(p, storage)]));
    choices[provider] = model.trim();
    storage.setItem(key, JSON.stringify(choices));
    storage.setItem('lupino-provider', provider);
  } catch {
    /* Selecting a model still works when persistence is unavailable. */
  }
}

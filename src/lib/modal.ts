/** Keep keyboard focus inside a modal and restore it to its opener. */
export function modalFocus(node: HTMLElement, close: () => void) {
  const previous = document.activeElement as HTMLElement | null;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (shell) shell.inert = true;
  const focusable = () => [
    ...node.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
    ),
  ];
  queueMicrotask(() => (focusable()[0] ?? node).focus());
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') {
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first) {
        event.preventDefault();
        node.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  node.addEventListener('keydown', keydown);
  return {
    destroy() {
      node.removeEventListener('keydown', keydown);
      if (shell) shell.inert = false;
      previous?.focus();
    },
  };
}

/** Keep compact settings menus dismissible with pointer and keyboard input. */
export function disclosure(node: HTMLDetailsElement) {
  const outside = (event: PointerEvent) => {
    if (node.open && !node.contains(event.target as Node)) node.open = false;
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !node.open) return;
    const restoreFocus = node.contains(document.activeElement);
    node.open = false;
    if (restoreFocus) node.querySelector('summary')?.focus();
  };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  return {
    destroy() {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    },
  };
}

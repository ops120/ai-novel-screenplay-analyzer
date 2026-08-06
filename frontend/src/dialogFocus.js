const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getDialogFocusableElements(dialog) {
  if (!dialog?.querySelectorAll) return [];
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
}

export function focusDialog(dialog) {
  getDialogFocusableElements(dialog)[0]?.focus();
}

export function handleDialogKeyDown(dialog, event, onClose) {
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose?.();
    return;
  }

  if (event.key !== 'Tab') return;

  const focusableElements = getDialogFocusableElements(dialog);
  if (focusableElements.length === 0) {
    event.preventDefault();
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements.at(-1);
  const activeElement = dialog.ownerDocument?.activeElement;
  const focusIsOutside = !dialog.contains?.(activeElement);

  if (event.shiftKey && (activeElement === firstElement || focusIsOutside)) {
    event.preventDefault();
    lastElement.focus();
  } else if (!event.shiftKey && (activeElement === lastElement || focusIsOutside)) {
    event.preventDefault();
    firstElement.focus();
  }
}

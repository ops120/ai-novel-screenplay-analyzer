import test from 'node:test';
import assert from 'node:assert/strict';
import { focusDialog, handleDialogKeyDown } from './dialogFocus.js';

function createDialog(elementNames = ['close', 'field', 'save']) {
  const ownerDocument = { activeElement: null };
  const elements = elementNames.map(name => ({
    name,
    focus() {
      ownerDocument.activeElement = this;
    },
  }));
  const dialog = {
    ownerDocument,
    querySelectorAll() {
      return elements;
    },
    contains(element) {
      return elements.includes(element);
    },
  };
  return { dialog, elements, ownerDocument };
}

function createKeyEvent(key, { shiftKey = false } = {}) {
  return {
    key,
    shiftKey,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

test('focusDialog focuses the first focusable control', () => {
  const { dialog, elements, ownerDocument } = createDialog();

  focusDialog(dialog);

  assert.equal(ownerDocument.activeElement, elements[0]);
});

test('Escape prevents default and closes the dialog', () => {
  const { dialog } = createDialog();
  const event = createKeyEvent('Escape');
  let closeCount = 0;

  handleDialogKeyDown(dialog, event, () => { closeCount += 1; });

  assert.equal(event.prevented, true);
  assert.equal(closeCount, 1);
});

test('Tab on the last control loops focus to the first control', () => {
  const { dialog, elements, ownerDocument } = createDialog();
  ownerDocument.activeElement = elements.at(-1);
  const event = createKeyEvent('Tab');

  handleDialogKeyDown(dialog, event, () => {});

  assert.equal(event.prevented, true);
  assert.equal(ownerDocument.activeElement, elements[0]);
});

test('Shift+Tab on the first control loops focus to the last control', () => {
  const { dialog, elements, ownerDocument } = createDialog();
  ownerDocument.activeElement = elements[0];
  const event = createKeyEvent('Tab', { shiftKey: true });

  handleDialogKeyDown(dialog, event, () => {});

  assert.equal(event.prevented, true);
  assert.equal(ownerDocument.activeElement, elements.at(-1));
});

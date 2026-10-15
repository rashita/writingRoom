import assert from 'node:assert/strict';
import { createFocusMode } from '../src/focus-mode.js';

const classes = new Set();
const bars = { nav: { offsetHeight: 52, inert: false }, footer: { offsetHeight: 30, inert: false } };
const properties = new Map();
const body = {
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    querySelector: selector => bars[selector],
    style: { setProperty: (name, value) => properties.set(name, value) }
};
const editor = {
    value: '執筆中の本文', selectionStart: 3, selectionEnd: 5, scrollTop: 200,
    focus(options) { assert.equal(options.preventScroll, true); }
};
let currentEditor = editor;
const mode = createFocusMode(body, () => currentEditor);
assert(!classes.has('focus-mode'));
mode.toggle();
assert(classes.has('focus-mode'));
assert.equal(properties.get('--focus-tabs-height'), '52px');
assert.equal(properties.get('--focus-status-height'), '30px');
assert(bars.nav.inert && bars.footer.inert);
assert.equal(editor.value, '執筆中の本文');
assert.equal(editor.selectionStart, 3);
assert.equal(editor.selectionEnd, 5);
assert.equal(editor.scrollTop, 200);
let prevented = false;
const escape = { key: 'Escape', isComposing: false, preventDefault() { prevented = true; } };
mode.handleKeydown({ ...escape, isComposing: true });
assert(classes.has('focus-mode'));
assert(!prevented);
mode.handleKeydown(escape);
assert(!classes.has('focus-mode'));
assert(prevented);
assert(!bars.nav.inert && !bars.footer.inert);
mode.toggle();
mode.toggle();
assert(!classes.has('focus-mode'));
mode.toggle();
currentEditor = null;
mode.sync();
assert(!classes.has('focus-mode'));
mode.toggle();
assert(!classes.has('focus-mode'));
console.log('Focus mode checks passed');

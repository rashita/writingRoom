import assert from 'node:assert/strict';
import { createChordShortcuts } from '../src/history-shortcuts.js';
let target = {}, closed = 0, opened = 0, waiting = false;
const keys = createChordShortcuts({ prefix: 'h', getContext: () => target, waiting: value => { waiting = value; }, actions: { p: () => closed++, o: () => opened++ } });
function press(key, extra = {}) {
    const event = { key, code: `Key${key.toUpperCase()}`, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}, ...extra };
    keys.handleKeydown(event);
    return event;
}
press('h', { metaKey: true });
assert.equal(waiting, true);
assert.equal(press('Process', { code: 'KeyP', isComposing: true, keyCode: 229 }).defaultPrevented, true);
assert.equal(closed, 1);
assert.equal(waiting, false);
press('p', { repeat: true });
assert.equal(closed, 1);
keys.handleKeyup({ code: 'KeyP' });
press('h', { metaKey: true });
press('Escape', { code: 'Escape' });
assert.equal(waiting, false);
press('h', { metaKey: true });
assert.equal(press('x').defaultPrevented, true);
assert.equal(closed, 1);
press('h', { metaKey: true });
target = {};
press('p');
assert.equal(closed, 1, 'switching editors cancels the chord');
console.log('Heading chord, Japanese IME, repeats, cancellation and editor changes checks passed');

press('h', { metaKey: true });
assert.equal(press('Process', { code: 'KeyO', isComposing: true, keyCode: 229 }).defaultPrevented, true);
assert.equal(opened, 1);
assert.equal(waiting, false);
press('o', { repeat: true });
assert.equal(opened, 1);

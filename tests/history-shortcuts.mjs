import assert from 'node:assert/strict';
import { createHistoryShortcuts } from '../src/history-shortcuts.js';
let context = { path: '原稿.md' };
const calls = [];
const shortcuts = createHistoryShortcuts({
    getContext: () => context,
    waiting: value => calls.push(['waiting', value]),
    record: tab => calls.push(['record', tab]),
    history: tab => calls.push(['history', tab])
});
function key(key, options = {}) {
    const event = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
        isComposing: false, repeat: false, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; }, ...options };
    shortcuts.handleKeydown(event);
    return event;
}
const prefix = (options = {}) => key('k', { metaKey: true, ...options });
const target = context;
assert.equal(prefix().defaultPrevented, true);
assert.deepEqual(calls, [['waiting', true]], 'prefix alone must not record');
assert.equal(key('Meta').defaultPrevented, false);
assert.equal(key('k').stopped, true);
assert.deepEqual(calls.slice(-2), [['waiting', false], ['record', target]]);
assert.equal(key('k', { repeat: true }).defaultPrevented, true, 'holding the second stroke must not insert text');
shortcuts.handleKeyup({ key: 'k' });
assert.equal(key('k').defaultPrevented, false, 'ordinary typing resumes after release');
prefix(); key('l');
assert.deepEqual(calls.at(-1), ['history', target]);
prefix(); key('l', { metaKey: true });
assert.deepEqual(calls.at(-1), ['history', target], 'Command may remain held');
prefix(); key('k', { metaKey: true });
assert.deepEqual(calls.at(-1), ['record', target]);
prefix({ metaKey: false, ctrlKey: true }); key('l', { ctrlKey: true });
assert.deepEqual(calls.at(-1), ['history', target]);
let actions = () => calls.filter(([name]) => name === 'record' || name === 'history').length;
let count = actions();
prefix(); assert.equal(key('Escape').stopped, true);
assert.equal(key('l').defaultPrevented, false);
assert.equal(actions(), count);
prefix(); assert.equal(key('x').defaultPrevented, true);
assert.equal(key('l').defaultPrevented, false);
prefix(); assert.equal(key('s', { metaKey: true }).defaultPrevented, false, 'other shortcuts remain available');
assert.equal(actions(), count);
prefix(); shortcuts.cancel();
assert.equal(key('l').defaultPrevented, false);
prefix(); context = { path: 'other.md' }; key('l');
assert.equal(actions(), count, 'a chord cannot act on a different tab');
context = null;
assert.equal(prefix().defaultPrevented, false, 'no chord outside an editor');
context = target;
assert.equal(prefix({ isComposing: true }).defaultPrevented, false);
assert.equal(prefix({ keyCode: 229 }).defaultPrevented, false);
prefix(); assert.equal(key('Process', { isComposing: true }).defaultPrevented, false);
assert.equal(key('l').defaultPrevented, false, 'composition cancels pending input');
assert.equal(prefix({ repeat: true }).defaultPrevented, true);
assert.equal(key('l').defaultPrevented, false, 'repeat cannot begin a chord');
prefix(); prefix({ repeat: true });
assert.equal(actions(), count, 'holding the prefix must not record');
key('l');
assert.equal(actions(), count + 1);
console.log('History chord shortcuts, cancellation, IME, and repeat checks passed');

import assert from 'node:assert/strict';
import { createTypewriter } from '../src/typewriter.js';
let next = 0;
const frames = new Map();
globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
class Surface extends EventTarget {
    style = { setProperty: (key, value) => { this[key] = value; } };
    classes = new Set();
    classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
}
globalThis.window = new Surface();
let observer;
globalThis.ResizeObserver = class {
    constructor(callback) { observer = this; this.callback = callback; }
    observe() {}
    disconnect() { this.disconnected = true; }
};
const dispatched = [];
const view = {
    dom: new Surface(), scrollDOM: new Surface(), defaultLineHeight: 30,
    state: { selection: { main: { head: 12 } } },
    dispatch: spec => dispatched.push(spec), composing: false
};
view.scrollDOM.clientHeight = 600;
const mode = createTypewriter(view, true);
flush();
assert.equal(view.dom['--typewriter-padding'], '285px');
assert.equal(dispatched.at(-1).effects.value.y, 'center');
assert.equal(dispatched.at(-1).effects.value.range.head, 12);
const update = event => mode.update({ transactions: [{ isUserEvent: name => event === name || event.startsWith(name + '.') }] });
let count = dispatched.length;
update('select.pointer'); flush();
assert.equal(dispatched.length, count);
update('input.type'); flush();
assert.equal(dispatched.length, ++count);
view.composing = true;
update('input.type.compose'); flush();
assert.equal(dispatched.length, count);
view.composing = false;
view.dom.dispatchEvent(new Event('compositionend'));
await new Promise(resolve => setTimeout(resolve, 60)); flush();
assert.equal(dispatched.length, ++count);
update('select');
view.scrollDOM.dispatchEvent(new Event('wheel')); flush();
assert.equal(dispatched.length, count, 'wheel cancels pending centering');
for (let i = 0; i < 5; i++) {
    mode.update({ transactions: [], geometryChanged: true });
    observer.callback();
    flush();
}
assert.equal(dispatched.length, count, 'viewport measurement while reading must not recenter');
view.scrollDOM.clientHeight = 500;
observer.callback();
flush();
assert.equal(view.dom['--typewriter-padding'], '235px');
assert.equal(dispatched.length, count, 'resize adjusts padding without recentering');
update('input.type'); flush();
assert.equal(dispatched.length, ++count, 'typing resumes centering after manual scrolling');

const imeEvent = (type, inputType, isComposing = true) => {
    const event = new Event(type);
    Object.assign(event, { inputType, isComposing });
    view.dom.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'IME edits are never intercepted');
};
view.scrollDOM.scrollTop = 5031;
view.scrollDOM.scrollLeft = 0;
imeEvent('beforeinput', 'deleteCompositionText');
view.scrollDOM.scrollTop = 4998; // Native WebKit movement seen in the real trace.
imeEvent('input', 'deleteCompositionText');
assert.equal(view.scrollDOM.scrollTop, 5031, 'restore synchronously after marked-text removal');
imeEvent('beforeinput', 'insertFromComposition');
view.scrollDOM.scrollTop = 4998;
imeEvent('input', 'insertFromComposition');
assert.equal(view.scrollDOM.scrollTop, 5031, 'keep position through committed-text insertion');
view.dom.dispatchEvent(new Event('compositionend'));
view.scrollDOM.scrollTop = 4900;
imeEvent('input', 'insertFromComposition');
assert.equal(view.scrollDOM.scrollTop, 4900, 'commit position is released at compositionend');
imeEvent('beforeinput', 'deleteCompositionText');
view.scrollDOM.dispatchEvent(new Event('wheel'));
view.scrollDOM.scrollTop = 4800;
imeEvent('input', 'deleteCompositionText');
assert.equal(view.scrollDOM.scrollTop, 4800, 'manual scrolling cancels commit restoration');
mode.setEnabled(false);
imeEvent('beforeinput', 'deleteCompositionText');
view.scrollDOM.scrollTop = 4700;
imeEvent('input', 'deleteCompositionText');
assert.equal(view.scrollDOM.scrollTop, 4700, 'disabled mode does not restore scrolling');
mode.setEnabled(true); flush();
count = dispatched.length;

view.dom.dispatchEvent(new Event('pointerdown'));
update('select'); flush();
assert.equal(dispatched.length, count);
window.dispatchEvent(new Event('pointerup'));
update('select'); flush();
assert.equal(dispatched.length, ++count);
mode.setEnabled(false); update('input.type'); flush();
assert.equal(dispatched.length, count);
assert(!view.scrollDOM.classes.has('typewriter-mode'));
mode.setEnabled(true);
mode.destroy(); flush();
assert.equal(dispatched.length, count);
assert(observer.disconnected);
console.log('Typewriter centering, IME, pointer, wheel, toggle and teardown checks passed');

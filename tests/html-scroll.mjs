import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { trackHtmlScroll } from '../src/html-scroll.js';

// Run both ends of the real bridge, including reload and stale-frame messages.
const bridge = fs.readFileSync(new URL('../src/dashboard-links.js.html', import.meta.url), 'utf8').replace(/^<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
const listeners = new Set();
const host = {
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener)
};
function mount(tab) {
    const events = {};
    const scroller = { scrollTop: 0, scrollLeft: 0 };
    const parent = { postMessage(data) { for (const listener of listeners) listener({ source: frame, data }); } };
    const frame = {
        addEventListener(type, listener) { events[type] = listener; },
        postMessage(data) { events.message({ source: parent, data }); },
        get scrollY() { return scroller.scrollTop; },
        get scrollX() { return scroller.scrollLeft; }
    };
    const stop = trackHtmlScroll(host, { contentWindow: frame }, tab);
    vm.runInNewContext(bridge, { window: frame, parent, document: { scrollingElement: scroller, addEventListener() {} } });
    return { frame, scroller, events, stop, scroll(top, left) {
        scroller.scrollTop = top;
        scroller.scrollLeft = left;
        events.scroll();
    } };
}
const first = {};
let view = mount(first);
view.scroll(0, 0); // Initial events cannot overwrite the stored position.
assert.equal(first.htmlScroll, undefined);
view.events.load();
view.scroll(720, 35);
assert.deepEqual(first.htmlScroll, { top: 720, left: 35 });
assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
const oldFrame = view.frame;
view.stop();
assert.equal(listeners.size, 0);
const second = {};
view = mount(second);
view.events.load();
assert.equal(view.scroller.scrollTop, 0);
view.scroll(100, 0);
view.stop();
view = mount(first);
view.events.scroll();
assert.equal(first.htmlScroll.top, 720);
view.events.load();
assert.equal(view.scroller.scrollTop, 720);
assert.equal(view.scroller.scrollLeft, 35);
for (const listener of listeners) {
    listener({ source: oldFrame, data: { type: 'project-scroll', position: { top: 0, left: 0 } } });
    for (const position of [null, { top: NaN, left: 0 }, { top: 1, left: '2' }]) {
        listener({ source: view.frame, data: { type: 'project-scroll', position } });
    }
}
assert.deepEqual(first.htmlScroll, { top: 720, left: 35 });
view.scroll(900, 10);
view.stop();
view = mount(first); // Explicit reload uses the same tab state.
view.events.load();
assert.equal(view.scroller.scrollTop, 900);
assert.equal(second.htmlScroll.top, 100);
view.stop();
console.log('HTML scroll checks passed');

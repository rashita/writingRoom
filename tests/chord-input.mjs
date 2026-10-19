import assert from 'node:assert/strict';
import { createChordInput } from '../src/chord-input.js';
let added = 0;
const document = {
    body: { append(element) { added++; element.isConnected = true; } },
    createElement(tag) {
        assert.equal(tag, 'div');
        return {
            setAttribute() {},
            focus(options) { assert.equal(options.preventScroll, true); document.activeElement = this; },
            remove() { this.isConnected = false; if (document.activeElement === this) document.activeElement = null; }
        };
    }
};
const editor = {
    isConnected: true, value: '原稿の本文', selectionStart: 2, selectionEnd: 4, scrollTop: 180,
    focus(options) { assert.equal(options.preventScroll, true); document.activeElement = this; }
};
document.activeElement = editor;
const input = createChordInput(document);
input.begin();
const sink = document.activeElement;
assert.notEqual(sink, editor);
assert.equal(sink.contentEditable, 'false');
assert.equal(sink.tabIndex, -1);
input.begin(); assert.equal(added, 1, 'only one capture target');
input.end();
assert.equal(document.activeElement, editor);
assert.equal(editor.value, '原稿の本文');
assert.equal(editor.selectionStart, 2);
assert.equal(editor.selectionEnd, 4);
assert.equal(editor.scrollTop, 180);
assert.equal(sink.isConnected, false);
input.end();
input.begin();
const other = {};
document.activeElement = other;
input.end();
assert.equal(document.activeElement, other, 'do not steal focus after clicking another control');
document.activeElement = editor;
input.begin(); editor.isConnected = false;
input.end();
assert.notEqual(document.activeElement, editor, 'do not restore a removed editor');
console.log('Chord input focus isolation and restoration checks passed');

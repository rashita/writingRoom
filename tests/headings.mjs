import assert from 'node:assert/strict';
import { getHeadings, currentHeadingIndex, showHeadingList } from '../src/headings.js';
const text = '# 第一章\n本文\n\n### 節 ###\n続き\n\n```md\n# 対象外\n```\n\n    # コード\n\n\\# エスケープ\n\n下線の見出し\n---\n\n#\n';
const headings = getHeadings(text);
assert.deepEqual(headings.map(({title, level}) => [title, level]), [['第一章',1], ['節',3], ['下線の見出し',2], ['（空の見出し）',1]]);
for (const heading of headings) assert.ok(text.slice(heading.from).startsWith(heading.level === 2 ? '下線の見出し' : '#'));
assert.equal(currentHeadingIndex(headings, text.indexOf('続き')), 1);
assert.equal(currentHeadingIndex(headings, 0), 0);
assert.equal(currentHeadingIndex(headings, text.length), 3);
assert.deepEqual(getHeadings('本文のみ'), []);
assert.equal(getHeadings('# 同名\n\n# 同名').length, 2);

// Exercise keyboard/click/cancel behavior without requiring a browser dependency.
class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    focus() { document.activeElement = this; this.emit('focus'); }
    scrollIntoView() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    remove() { this.removed = true; }
}
globalThis.document = { createElement: tag => new Element(tag), body: new Element('body') };
let chosen = null, closed = 0;
const open = (items = headings) => showHeadingList({ headings: items, position: text.indexOf('続き'), onChoose: h => { chosen = h; }, onClose: () => closed++ });
const cancel = open();
let dialog = document.body.children.at(-1);
let buttons = dialog.children[1].children;
assert.equal(document.activeElement, buttons[1]);
let prevented = false;
dialog.emit('keydown', { key: 'ArrowDown', preventDefault() { prevented = true; } });
assert.equal(document.activeElement, buttons[2]);
assert.equal(prevented, true);
dialog.emit('keydown', { key: 'ArrowUp', isComposing: true });
assert.equal(document.activeElement, buttons[2]);
let escapeStopped = false;
dialog.emit('keydown', { key: 'Escape', stopPropagation() { escapeStopped = true; } });
assert.equal(escapeStopped, true, 'Escape does not also exit focus mode');
cancel();
assert.equal(chosen, null, 'cancel does not navigate');
assert.equal(closed, 1);
assert.equal(dialog.removed, true);
open();
dialog = document.body.children.at(-1);
buttons = dialog.children[1].children;
buttons[3].emit('click');
assert.equal(chosen, headings[3]);
assert.equal(closed, 2);
open([]);
dialog = document.body.children.at(-1);
assert.equal(document.activeElement, dialog.children[0].children[1], 'empty outline focuses Close');
assert.match(dialog.children[1].textContent, /ありません/);
dialog.close();
delete globalThis.document;
console.log('Markdown heading parsing, initial selection, keyboard navigation and cancellation checks passed');

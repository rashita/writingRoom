import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { headingFolds, closeHeading, openHeading } from '../src/heading-fold.js';
import { currentHeadingRange } from '../src/headings.js';
import * as cm from '../src/cm-bundle.js';
import { createEditorStateStore, editorKey } from '../src/editor-state.js';

// Exercise the adapter with real CodeMirror state/history and a minimal view host.
// Actual layout and IME still require a WebView.
let view;
class TestView {
    static decorations = cm.EditorView.decorations;
    static scrollIntoView = cm.EditorView.scrollIntoView;
    static lineWrapping = cm.EditorView.lineWrapping;
    static editable = cm.EditorView.editable;
    static editorAttributes = cm.EditorView.editorAttributes;
    static contentAttributes = cm.EditorView.contentAttributes;
    static updateListener = cm.EditorView.updateListener;
    constructor({ state }) {
        view = this;
        this.dispatch = this.dispatch.bind(this);
        this.state = state;
        this.scrollDOM = { scrollTop: 0, scrollLeft: 0 };
    }
    dispatch(spec) {
        const transaction = spec?.state ? spec : this.state.update(spec);
        this.state = transaction.state;
        for (const listener of this.state.facet(cm.EditorView.updateListener)) {
            listener({ state: this.state, docChanged: transaction.docChanged });
        }
    }
    requestMeasure({ read, write }) { write(read()); }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; }
}
const context = vm.createContext({ ...cm, headingFolds, closeHeading, openHeading, currentHeadingRange, EditorView: TestView });
const source = fs.readFileSync(new URL('../src/editor.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export function', 'function');
vm.runInContext(source, context);
const changes = [];
const options = { parent: {}, text: '見出し\n本文', title: '原稿.md', onChange: text => changes.push(text) };
let editor = context.createEditor(options);
assert.equal(view.state.facet(cm.EditorView.editorAttributes)[0].class, 'manuscript-editor');
view.dispatch({ changes: { from: 6, insert: '追記' }, selection: { anchor: 8 } });
assert.equal(changes.at(-1), '見出し\n本文追記');
view.scrollDOM.scrollTop = 150;
const saved = editor.snapshot();
editor.destroy();
assert.equal(view.destroyed, true);
editor = context.createEditor({ ...options, text: changes.at(-1), saved });
assert.equal(view.state.selection.main.head, 8);
assert.equal(view.scrollDOM.scrollTop, 150);
assert.equal(cm.historyKeymap[0].run(view), true);
assert.equal(view.state.doc.toString(), options.text, 'undo survives remount');
assert.equal(cm.historyKeymap[1].run(view), true);
assert.equal(view.state.doc.toString(), '見出し\n本文追記');
view.dispatch({ selection: { anchor: 8 } });
const count = changes.length;
editor.setText('外部見出し\n本文追記');
assert.equal(view.state.doc.toString(), '外部見出し\n本文追記');
assert.equal(changes.length, count, 'remote updates do not echo to the backend');
assert.equal(view.state.selection.main.head, 10, 'selection follows the changed prefix');
editor.focus();
assert.equal(view.scrollDOM.scrollTop, 150);
assert.equal(view.focused, true);
assert.equal(view.state.facet(cm.EditorView.editorAttributes)[0].class, 'manuscript-editor', 'styling class is owned by CodeMirror and survives updates');
const remoteSaved = editor.snapshot();
editor.destroy();
editor = context.createEditor({ ...options, text: '新しい外部見出し\n本文追記', saved: remoteSaved });
assert.equal(view.state.selection.main.head, 13, 'inactive tabs retain their mapped selection after remote changes');
assert.equal(changes.length, count);
editor = context.createEditor({ ...options, disabled: true, saved });
assert.equal(view.state.readOnly, true);
assert.equal(view.state.facet(cm.EditorView.editable), false);
console.log('CodeMirror editing, undo restoration, remote synchronization and read-only checks passed');

// Reusing a numbered-navigation tab must not transfer another file's history.
const store = createEditorStateStore();
const tab = { path: 'chapter001.md' };
const firstKey = editorKey('/project', tab);
editor = context.createEditor(options);
view.dispatch({ changes: { from: 6, insert: '追記' }, selection: { anchor: 8 } });
view.scrollDOM.scrollTop = 80;
const first = editor.snapshot();
store.save(firstKey, first);
assert.equal(store.get(firstKey).state, first.state, 'open manuscripts retain undo state');
tab.path = 'chapter002.md';
const secondKey = editorKey('/project', tab);
store.retain([secondKey]);
assert.equal(store.get(secondKey), undefined);
assert.equal(store.get(firstKey).state, undefined, 'closed manuscripts release text and undo history');
editor.destroy();
editor = context.createEditor({ ...options, text: '別の原稿', saved: store.get(secondKey) });
assert.equal(cm.historyKeymap[0].run(view), false, 'numbered navigation starts with its own undo history');
editor.destroy();
editor = context.createEditor({ ...options, text: first.state.doc.toString(), saved: store.get(firstKey) });
assert.equal(view.state.selection.main.head, 8, 'reopening retains the caret');
assert.equal(view.scrollDOM.scrollTop, 80);
assert.equal(cm.historyKeymap[0].run(view), false, 'reopening does not retain a closed manuscript undo history');
store.save(firstKey, editor.snapshot());
store.rename(firstKey, secondKey);
assert.equal(store.get(firstKey), undefined);
assert.ok(store.get(secondKey).state, 'Save As transfers state to the saved manuscript');
assert.notEqual(editorKey('/other', tab), secondKey, 'project roots distinguish manuscripts');
assert.notEqual(editorKey('/project', { ...tab, untitled: true }), secondKey);
console.log('Per-manuscript state isolation, release, reopening and renaming checks passed');

const beforeJump = view.state.doc.toString();
const changesBeforeJump = changes.length;
editor.jumpTo(2);
assert.equal(view.state.selection.main.head, 2);
assert.equal(view.state.doc.toString(), beforeJump);
assert.equal(changes.length, changesBeforeJump, 'heading navigation does not edit the manuscript');

editor.destroy();
const foldText = '# 親\n親本文\n\n## 子\n子本文\n\n# 次\n次の本文';
editor = context.createEditor({ ...options, text: foldText });
view.dispatch({ selection: { anchor: foldText.indexOf('子本文') } });
const foldChanges = changes.length;
assert.equal(editor.closeCurrentHeading(), true);
assert.equal(view.state.selection.main.head, foldText.indexOf('## 子'));
assert.equal(view.state.field(headingFolds).size, 1);
assert.equal(view.state.doc.toString(), foldText);
assert.equal(changes.length, foldChanges);
const folded = editor.snapshot();
editor.destroy();
editor = context.createEditor({ ...options, text: foldText, saved: folded });
assert.equal(view.state.field(headingFolds).size, 1, 'fold survives switching tabs');
editor.jumpTo(foldText.indexOf('子本文'));
assert.equal(view.state.field(headingFolds).size, 0, 'navigation reveals a hidden destination');
editor.jumpTo(0);
editor.closeCurrentHeading();
let foldedTo;
view.state.field(headingFolds).between(0, foldText.length, (from, to) => { foldedTo = to; });
assert.equal(foldedTo, foldText.indexOf('# 次') - 1);
assert.equal(editor.closeCurrentHeading(), true);
assert.equal(view.state.field(headingFolds).size, 1, 'repeated close is idempotent');
assert.equal(currentHeadingRange('導入\n\n# 章\n本文', 0), null);
assert.equal(currentHeadingRange('# 本文なし', 0), null);
console.log('Heading folding ranges, caret relocation, persistence and hidden navigation checks passed');

const beforeOpenChanges = changes.length;
assert.equal(editor.openCurrentHeading(), true);
assert.equal(view.state.field(headingFolds).size, 0);
assert.equal(view.state.selection.main.head, 0);
assert.equal(view.state.doc.toString(), foldText);
assert.equal(changes.length, beforeOpenChanges, 'opening does not modify text');
assert.equal(editor.openCurrentHeading(), false, 'already open is a no-op');
editor.jumpTo(foldText.indexOf('子本文'));
editor.closeCurrentHeading();
editor.jumpTo(0);
editor.closeCurrentHeading();
assert.equal(view.state.field(headingFolds).size, 2);
editor.openCurrentHeading();
assert.equal(view.state.field(headingFolds).size, 1, 'opening a parent preserves folded children');
editor.jumpTo(foldText.indexOf('## 子'));
assert.equal(editor.openCurrentHeading(), true);
assert.equal(view.state.field(headingFolds).size, 0);
console.log('Heading opening, repeated open and nested fold preservation checks passed');

// Enter at a paragraph boundary adds exactly one break, preserving the next paragraph.
editor.destroy();
const paragraph = 'コンビニの仕事は常に忙しく、不十分な記録になっていたのです。';
const nextParagraph = 'では、逆はどうでしょうか。';
const paragraphs = paragraph + '\n\n' + nextParagraph;
editor = context.createEditor({ ...options, text: paragraphs });
const enter = view.state.facet(cm.keymap).flat().find(binding => binding.key === 'Enter');
assert.ok(enter, 'Enter must be handled explicitly rather than by WebView paragraph editing');
view.dispatch({ selection: { anchor: paragraph.length } });
assert.equal(enter.run(view), true);
assert.equal(view.state.doc.toString(), paragraph + '\n\n\n' + nextParagraph);
assert.equal(view.state.selection.main.head, paragraph.length + 1);
assert.equal(cm.historyKeymap[0].run(view), true);
assert.equal(view.state.doc.toString(), paragraphs, 'one undo restores the paragraph spacing');
view.dispatch({ selection: { anchor: 0, head: paragraph.length } });
assert.equal(enter.shift(view), true);
assert.equal(view.state.doc.toString(), '\n\n\n' + nextParagraph, 'Shift-Enter replaces the selection with one newline');
editor.destroy();
editor = context.createEditor({ ...options, text: '　本文', disabled: true });
assert.equal(enter.run(view), false);
assert.equal(view.state.doc.toString(), '　本文');
editor.destroy();
editor = context.createEditor({ ...options, text: '　本文' });
view.dispatch({ selection: { anchor: 3 } });
enter.run(view);
assert.equal(view.state.doc.toString(), '　本文\n', 'Enter does not copy indentation');
console.log('Plain Enter, paragraph spacing, selection replacement, undo and read-only checks passed');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as cm from '../src/cm-bundle.js';
import { createEditorStateStore, editorKey } from '../src/editor-state.js';

// Exercise the adapter with real CodeMirror state/history and a minimal view host.
// Actual layout and IME still require a WebView.
let view;
class TestView {
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
const context = vm.createContext({ ...cm, EditorView: TestView });
const source = fs.readFileSync(new URL('../src/editor.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/, '').replace('export function', 'function');
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createEditorStateStore, editorKey } from '../src/editor-state.js';
const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const text = { kind: 'text', path: 'draft/old.md', title: 'old.md', doc: { path: '/project/draft/old.md', text: 'unsaved', original: 'saved' } };
const html = { kind: 'html', path: text.path, title: text.title };
const states = createEditorStateStore();
const position = { selection: 12 };
let renders = 0;
const context = {
    session: { root: '/project', file: text.path }, tabs: [text, html],
    editorStates: states, editorKey,
    rememberEditorPosition() { states.save(editorKey('/project', text), position); },
    render() { renders++; }
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function applyFileRename('), source.indexOf("await listen('file-renamed'")), context);
context.applyFileRename({ root: '/other', path: text.path, newPath: 'ignored.md' });
assert.equal(renders, 0);
context.applyFileRename({ root: '/project', path: text.path, newPath: 'draft/新しい名前.md' });
assert.equal(text.path, 'draft/新しい名前.md');
assert.equal(text.title, '新しい名前.md');
assert.equal(text.doc.path, '/project/draft/新しい名前.md');
assert.equal(text.doc.text, 'unsaved');
assert.equal(text.doc.original, 'saved');
assert.equal(html.path, text.path);
assert.equal(html.folder, 'draft');
assert.equal(context.session.file, text.path);
assert.deepEqual(states.get(editorKey('/project', text)), position);
assert.equal(renders, 1);
console.log('File rename updates shared tabs and preserves unsaved text and editor position');

const folder = { kind: 'files', path: 'draft', title: 'draft' };
const sibling = { kind: 'text', path: 'draft-other/keep.md', title: 'keep.md' };
context.tabs.push(folder, sibling);
context.applyFileRename({ root: '/project', path: 'draft', newPath: '章', directory: true });
assert.equal(folder.path, '章');
assert.equal(text.path, '章/新しい名前.md');
assert.equal(html.folder, '章');
assert.equal(text.doc.path, '/project/章/新しい名前.md');
assert.equal(context.session.file, text.path);
assert.equal(sibling.path, 'draft-other/keep.md');
assert.deepEqual(states.get(editorKey('/project', text)), position);
console.log('Folder rename updates descendant tabs without changing similarly named siblings');

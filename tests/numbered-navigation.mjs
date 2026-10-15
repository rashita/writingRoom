import assert from 'node:assert/strict';
import { numberedPath, createNumberedNavigation } from '../src/numbered-navigation.js';
for (const [path, delta, expected] of [
    ['chapter001.md', 1, 'chapter002.md'], ['draft/chapter001.md', -1, 'draft/chapter000.md'],
    ['chapter000.md', -1, null], ['chapter999.md', 1, 'chapter1000.md'],
    ['hoge000', 1, 'hoge001'], ['第2章009.md', 1, '第2章010.md'],
    ['chapter.md', 1, null], ['folder001/chapter.md', 1, null],
    ['12345678901234567890.md', 1, '12345678901234567891.md']
]) assert.equal(numberedPath(path, delta), expected);
let active = { kind: 'text', path: 'draft/chapter001.md', title: 'chapter001.md' };
let exists = false, approved = false, calls = [], prompts = 0;
const navigate = createNumberedNavigation({
    getActive: () => active,
    invoke: async (command, args) => {
        calls.push([command, args]);
        if (command === 'list_files') return exists ? [{ path: 'draft/chapter002.md' }] : [];
    },
    confirm: async () => { prompts++; return approved; },
    openText: async path => calls.push(['open', path]), status: () => {}
});
await navigate(1);
assert.equal(prompts, 1);
assert.deepEqual(calls, [['list_files', { folder: 'draft' }]]);
approved = true; calls = [];
await navigate(1);
assert.deepEqual(calls, [['list_files', { folder: 'draft' }], ['create_numbered_document', { path: 'draft/chapter002.md' }], ['open', 'draft/chapter002.md']]);
exists = true; calls = []; prompts = 0;
await Promise.all([navigate(1), navigate(1)]);
assert.equal(prompts, 0);
assert.deepEqual(calls, [['list_files', { folder: 'draft' }], ['open', 'draft/chapter002.md']]);
active = { kind: 'files' }; calls = [];
await navigate(1);
assert.deepEqual(calls, []);
console.log('Numbered navigation checks passed');

// A declined save prevents both file creation and navigation; a failed save also stops.
active = { kind: 'text', path: 'chapter001.md', title: 'chapter001.md' };
let allowSave = false, saveError = false;
calls = [];
const guarded = createNumberedNavigation({
    getActive: () => active,
    prepare: async tab => {
        assert.equal(tab, active);
        calls.push('save-confirmation');
        if (saveError) throw new Error('save failed');
        return allowSave;
    },
    invoke: async command => { calls.push(command); return [{ path: 'chapter002.md' }]; },
    confirm: async () => { throw new Error('unexpected creation confirmation'); },
    openText: async (path, source) => { assert.equal(source, active); calls.push(path); },
    status: () => {}
});
await guarded(1);
assert.deepEqual(calls, ['save-confirmation']);
calls = []; saveError = true;
await assert.rejects(guarded(1), /save failed/);
assert.deepEqual(calls, ['save-confirmation']);
calls = []; saveError = false; allowSave = true;
await guarded(1);
assert.deepEqual(calls, ['save-confirmation', 'list_files', 'chapter002.md']);

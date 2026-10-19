import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const saveSource = source.slice(source.indexOf('async function save(t = active)'), source.indexOf('async function openDashboard'));
const closeSource = source.slice(source.indexOf('async function closeTab(tab)'), source.indexOf("await listen('close-tab-requested'"));
const rememberSource = source.slice(source.indexOf('function rememberTabs()'), source.indexOf('async function flushTabState()'));
const listenerSource = source.slice(source.indexOf("await listen('new-document-requested'"), source.indexOf('const navigateNumbered'));
let selected = null, allowClose = false, failSave = false, listener;
const calls = [];
const context = {
    session: { root: '/project' }, tabs: [], active: null,
    editQueue: Promise.resolve(), restoringTabs: false, tabPersistenceEnabled: true,
    tabStateQueue: Promise.resolve(), lastTabSnapshot: null, tabStateError: null,
    document: { querySelector: () => null },
    render() {}, renderTabs() {}, focusEditor() {}, status() {}, fail(e) { throw e; },
    confirm: async () => allowClose,
    listen: async (event, handler) => { listener = handler; },
    addTab(tab) { context.tabs.push(tab); context.active = tab; },
    invoke: async (command, args) => {
        calls.push([command, args]);
        if (command === 'create_draft') return { path: `untitled-${calls.length}`, text: '', original: '', revision: 0 };
        if (command === 'plugin:dialog|save') return selected;
        if (command === 'save_draft') {
            if (failSave) throw Error('disk failure');
            return { path: '/project/原稿.md', text: '原稿', original: '原稿', revision: 0 };
        }
        if (command === 'save_document') return { ...context.active.doc, original: context.active.doc.text };
    }
};
vm.createContext(context);
vm.runInContext(saveSource + closeSource + rememberSource, context);
await vm.runInContext(`(async () => { ${listenerSource} })()`, context);
context.session = null;
await listener();
assert.equal(calls.length, 0, 'welcome does not create a draft');
context.session = { root: '/project' };
await listener(); await listener();
assert.equal(context.tabs.length, 2);
assert.notEqual(context.tabs[0].path, context.tabs[1].path);
const draft = context.active;
assert.equal(await context.save(draft), false, 'canceling Save As preserves the draft');
assert.equal(draft.untitled, true);
assert.equal(calls.some(([name]) => name === 'save_draft'), false);
context.rememberTabs(); await context.tabStateQueue;
assert.equal(calls.find(([name]) => name === 'save_tab_state')[1].tabs.tabs.length, 0, 'drafts are excluded from restored tabs');
selected = '/project/原稿.md'; failSave = true;
await assert.rejects(context.save(draft), /disk failure/);
assert.equal(draft.untitled, true);
assert.equal(draft.savingDraft, false);
failSave = false;
assert.equal(await context.save(draft), true);
assert.equal(draft.path, '原稿.md');
assert.equal(draft.title, '原稿.md');
assert.equal(draft.untitled, false);
await context.save(draft);
assert.equal(calls.at(-1)[0], 'save_document', 'subsequent save uses the saved file');
const other = context.tabs[0];
await context.closeTab(other);
assert.ok(context.tabs.includes(other), 'canceling discard keeps the tab');
allowClose = true;
await context.closeTab(other);
assert.ok(!context.tabs.includes(other));
assert.equal(calls.at(-1)[0], 'discard_draft');
console.log('New document creation, saving, cancellation, and persistence checks passed');

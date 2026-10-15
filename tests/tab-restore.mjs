import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual startup routine with filesystem/window APIs substituted.
const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const setup = source.slice(source.indexOf('async function setup()'), source.indexOf('async function chooseProject()'));
async function restore(saved, missing = [], welcome = false) {
    const calls = [];
    const context = {
        tabs: [], active: null, session: null, restoringTabs: false, canResumeWorkspace: false,
        win: { setTitle: async () => {} },
        invoke: async (command, args) => {
            calls.push(command);
            if (command === 'get_session') return welcome ? null : { root: '/project', parent: null };
            if (command === 'can_resume_workspace') return true;
            if (command === 'get_tab_state') return saved;
            if (command === 'validate_saved_tab' && missing.includes(args.tab.path)) throw Error('missing');
        },
        render: () => {}, refreshHistory: async () => {},
        status: () => {}, rememberTabs: () => { calls.push('remember'); },
        message: async text => { calls.push(text); }, fail: async error => { throw error; },
    };
    for (const [method, kind] of [['openText', 'text'], ['openFile', 'html'], ['openFolder', 'files']]) {
        context[method] = async path => {
            const tab = { kind: method === 'openFile'
                ? (/\.pdf$/i.test(path) ? 'pdf' : /\.(svg|png|jpe?g|gif|webp)$/i.test(path) ? 'image' : kind)
                : kind, path };
            context.tabs.push(tab);
            context.active = tab;
        };
    }
    context.openDashboard = async () => { calls.push('default-dashboard'); };
    vm.createContext(context);
    await vm.runInContext(`${setup}\nsetup()`, context);
    return { context, calls };
}
const saved = { tabs: [
    { kind: 'html', path: 'index.html', title: '概要' },
    { kind: 'text', path: 'index.html', title: 'ソース' },
    { kind: 'text', path: '原稿.md', title: '原稿' },
], active: 1 };
let result = await restore(saved);
assert.equal(result.context.tabs.map(tab => tab.kind).join(','), 'html,text,text');
assert.equal(result.context.active.title, 'ソース');
assert.equal(result.context.restoringTabs, false);
assert(!result.calls.includes('default-dashboard'));
result = await restore(saved, ['原稿.md']);
assert.equal(result.context.tabs.length, 2);
assert.equal(result.context.active.title, 'ソース');
assert(result.calls.some(call => call.includes('復元できなかったタブ')));
result = await restore({ ...saved, active: 2 }, ['原稿.md']);
assert.equal(result.context.active.title, 'ソース');
result = await restore({ tabs: [], active: null });
assert.equal(result.context.tabs.length, 0);
assert(!result.calls.includes('default-dashboard'));
for (const extension of ['SVG', 'png', 'JPG', 'jpeg', 'gif', 'webp']) {
    const path = `図.${extension}`;
    result = await restore({ tabs: [{ kind: 'image', path, title: '図' }], active: 0 });
    assert.equal(result.context.active.kind, 'image');
    assert.equal(result.context.active.path, path);
}
for (const path of ['資料.pdf', '資料.PDF']) {
    result = await restore({ tabs: [{ kind: 'pdf', path, title: '資料' }], active: 0 });
    assert.equal(result.context.active.kind, 'pdf');
    assert.equal(result.context.active.path, path);
}
result = await restore({ tabs: [{ kind: 'pdf', path: 'missing.pdf', title: '資料' }], active: 0 }, ['missing.pdf']);
assert.equal(result.context.tabs.length, 0);
assert(result.calls.some(call => call.includes('復元できなかったタブ')));
result = await restore(null);
assert(result.calls.includes('default-dashboard'));
result = await restore(saved, [], true);
assert.equal(result.context.session, null);
assert.equal(result.context.tabs.length, 0);
assert.equal(result.context.canResumeWorkspace, true);
assert(!result.calls.includes('restore_workspace'));
assert(!result.calls.includes('get_tab_state'));
console.log('Tab restoration checks passed');

import { showHistory } from './history.js';
import { showTaskLog, runNamedTask, manageNamedTasks } from './named-tasks.js';
import { recordProgress } from './progress.js';
import { createFocusMode } from './focus-mode.js';
import { updateCharacterCount } from './character-count.js';
import { createNumberedNavigation } from './numbered-navigation.js';
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { Menu } = window.__TAURI__.menu;
const { LogicalPosition } = window.__TAURI__.dpi;
const open = options => invoke('plugin:dialog|open', { options });
const confirm = async (text, options = {}) => { const ok = options.okLabel || '続ける'; const result = await invoke('plugin:dialog|message', { message: text, title: options.title, kind: options.kind, buttons: { OkCancelCustom: [ok, options.cancelLabel || 'キャンセル'] } }); return result === ok || result === 'Ok'; };
const message = (text, options = {}) => invoke('plugin:dialog|message', { message: text, title: options.title, kind: options.kind, buttons: 'Ok' });
const win = getCurrentWindow();
const content = document.querySelector('#content');
const tabsEl = document.querySelector('#tabs');
let session, tabs = [], active, sequence = 0;
// Kept only for this window's lifetime, including after a tab is closed.
const editorPositions = new Map();
let rememberEditorPosition = () => {};
const focusMode = createFocusMode(document.body, () => active?.kind === 'text' ? content.querySelector('textarea') : null);
window.addEventListener('keydown', focusMode.handleKeydown);
let editQueue = Promise.resolve();
let recentProjects = [];
let historyMenus = new Map();
let openingProject = false;
let restoringTabs = true;
let tabStateQueue = Promise.resolve();
let tabStateError;
let tabPersistenceEnabled = true;
let lastTabSnapshot;
let canResumeWorkspace = false;
let resumingWorkspace = false;
function rememberTabs() {
    if (restoringTabs || !session || session.parent || !tabPersistenceEnabled) return;
    const snapshot = { tabs: tabs.map(({ kind, path, title }) => ({ kind, path, title })), active: active ? tabs.indexOf(active) : null };
    const key = JSON.stringify([session.root, snapshot]);
    if (key === lastTabSnapshot && !tabStateError) return;
    lastTabSnapshot = key;
    tabStateQueue = tabStateQueue.then(() => invoke('save_tab_state', { tabs: snapshot }))
        .then(() => { tabStateError = null; }, error => { tabStateError = error; status(`タブの状態を保存できません: ${error}`, true); });
}
async function flushTabState() {
    rememberTabs();
    await tabStateQueue;
    if (tabStateError) throw tabStateError;
}
const status = (text, error = false) => { const el = document.querySelector('#status'); el.textContent = text; el.classList.toggle('error', error); };
const fail = error => { status(String(error), true); return message(String(error), { title: 'Writing Room', kind: 'error' }); };
const button = (label, action) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => Promise.resolve().then(action).catch(fail); return b; };
function addTab(tab) { const existing = tabs.find(t => t.kind === tab.kind && t.path === tab.path); if (existing) {
    active = existing;
    render();
    return;
} tab.id = ++sequence; tabs.push(tab); active = tab; render(); }
function renderTabs() {
    rememberTabs();
    tabsEl.replaceChildren();
    tabsEl.setAttribute('aria-label', session ? '作業タブ' : '最近使ったプロジェクト');
    if (!session) {
        for (const project of recentProjects) {
            const tab = button(`📁 ${project.name}${project.available ? '' : '（見つかりません）'}`, () => openProjectRoot(project.root));
            tab.className = 'recent-project';
            tab.classList.toggle('unavailable', !project.available);
            tab.title = project.root;
            tab.setAttribute('aria-label', `最近使ったプロジェクト: ${project.name}`);
            const showMenu = () => showHistoryMenu(project, tab).catch(fail);
            tab.addEventListener('contextmenu', event => { event.preventDefault(); showMenu(); });
            tab.addEventListener('keydown', event => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showMenu(); }
            });
            tabsEl.append(tab);
        }
        return;
    }
    for (const t of tabs) {
    const dirty = t.doc && t.doc.text !== t.doc.original;
    const b = button(t.title, () => { active = t; render(); });
    b.classList.toggle('active', t === active);
    b.dataset.tabId = t.id;
    if (t.kind === 'text' || t.kind === 'html') {
        b.addEventListener('keydown', event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                showTabMenu(t).catch(fail);
            }
        });
        b.addEventListener('contextmenu', event => {
            event.preventDefault();
            showTabMenu(t).catch(fail);
        });
    }
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = dirty ? '○' : '×';
    close.classList.toggle('unsaved', !!dirty);
    close.title = dirty ? '未保存の編集があります — タブを閉じる' : 'タブを閉じる';
    close.onclick = e => { e.stopPropagation(); closeTab(t).catch(fail); };
    b.append(close);
    tabsEl.append(b);
} }
async function closeTab(tab) {
    if (!tab || document.querySelector('dialog[open]')) return;
    await editQueue;
    if (!tabs.includes(tab)) return;
    if (tab.doc && tab.doc.text !== tab.doc.original && !await confirm('未保存の編集があります。タブを閉じますか？編集内容はプロジェクトを閉じるまで保持されます。', { title: 'タブを閉じる' })) return;
    tabs = tabs.filter(t => t !== tab);
    if (tab.contextMenu) await tab.contextMenu.close();
    if (active === tab) active = tabs.at(-1);
    render();
}
await listen('close-tab-requested', () => closeTab(active).catch(fail));
await listen('close-window-requested', () => {
    if (!document.querySelector('dialog[open]')) win.close().catch(fail);
});
async function refreshHistory() {
    const projects = await invoke('recent_projects');
    for (const [root, menu] of historyMenus) {
        if (!projects.some(project => project.root === root)) {
            await menu.close();
            historyMenus.delete(root);
        }
    }
    recentProjects = projects;
    if (!session) renderTabs();
}
async function showHistoryMenu(project, tab) {
    let menu = historyMenus.get(project.root);
    if (!menu) {
        const id = ++sequence;
        menu = await Menu.new({ items: [
            { id: `recent-new-window-${id}`, text: '別ウィンドウで開く', action: () => openProjectRoot(project.root, true).catch(fail) },
            { id: `recent-forget-${id}`, text: '履歴から外す', action: () => invoke('forget_project', { root: project.root }).catch(fail) }
        ] });
        historyMenus.set(project.root, menu);
    }
    const bounds = tab.getBoundingClientRect();
    await menu.popup(new LogicalPosition(bounds.left, bounds.bottom), win);
}
async function openProjectRoot(root, newWindow = false) {
    if (openingProject) return;
    openingProject = true;
    try {
        const label = await invoke('open_project', { root, newWindow });
        if (label === win.label) await setup();
    } catch (error) {
        if (!session) await refreshHistory();
        throw error;
    } finally { openingProject = false; }
}
async function showTabMenu(tab) {
    if (!tab.contextMenu) {
        tab.contextMenu = await Menu.new({ items: [{
            id: `tab-action-${tab.id}`,
            text: tab.kind === 'html' ? 'ソースを編集' : '子ウィンドウで開く',
            action: () => (async () => {
                if (tab.kind === 'html') { await openText(tab.path); return; }
                await editQueue;
                if (tab.syncError) throw new Error(tab.syncError);
                await invoke('open_child', { path: tab.path });
            })().catch(fail)
        }, ...(tab.kind === 'text' ? [{
            id: `tab-finder-${tab.id}`,
            text: 'Finderで開く',
            action: () => invoke('reveal_in_finder', { path: tab.path }).catch(fail)
        }] : [])] });
    }
    const tabButton = tabsEl.querySelector(`[data-tab-id="${tab.id}"]`);
    if (!tabButton) return;
    const bounds = tabButton.getBoundingClientRect();
    await tab.contextMenu.popup(new LogicalPosition(bounds.left, bounds.bottom), win);
}
function toolbar(path) { const el = document.createElement('div'); el.className = 'toolbar'; const label = document.createElement('span'); label.className = 'path'; label.textContent = path || 'プロジェクト直下'; el.append(label); content.append(el); return el; }
function focusEditor() {
    const editor = content.querySelector('textarea');
    if (!editor) return;
    const { scrollTop, scrollLeft } = editor;
    editor.focus({ preventScroll: true });
    editor.scrollTop = scrollTop;
    editor.scrollLeft = scrollLeft;
}
function render() { rememberEditorPosition(); rememberEditorPosition = () => {}; focusMode.sync(); renderTabs(); content.replaceChildren(); updateCharacterCount(document.querySelector('#character-count'), active?.kind === 'text' ? active.doc.text : null); if (!active) {
    const box = document.createElement('div');
    box.className = 'welcome';
    const h = document.createElement('h1');
    h.textContent = 'Writing Room';
    const p = document.createElement('p');
    p.textContent = session ? 'タブを開いて執筆を始めましょう。' : '原稿も、資料も、構想も。一つのフォルダから始める執筆の作業室。';
    if (!session) {
        p.style.visibility = 'hidden';
        p.setAttribute('aria-hidden', 'true');
    }
    box.append(h, p, button(session ? 'ファイラーを開く' : 'プロジェクトを開く…', session ? () => openFolder('') : chooseProject));
    if (!session && canResumeWorkspace) {
        const resume = button('前回の作業を再開', resumeWorkspace);
        resume.disabled = resumingWorkspace;
        resume.style.marginLeft = '10px';
        box.append(resume);
    }
    content.append(box);
    return;
} const t = active; if (t.kind === 'files')
    renderFiles(t); if (t.kind === 'html') {
    const iframe = document.createElement('iframe');
    iframe.title = 'プロジェクトのダッシュボード';
    iframe.sandbox = 'allow-scripts';
    iframe.src = `${assetUrl(t.path)}?v=${Date.now()}`;
    content.append(iframe);
} if (t.kind === 'pdf') {
    toolbar(t.path);
    const iframe = document.createElement('iframe');
    iframe.title = t.title;
    iframe.src = `${assetUrl(t.path)}?v=${Date.now()}`;
    content.append(iframe);
} if (t.kind === 'image') {
    const bar = toolbar(t.path);
    const preview = document.createElement('div');
    preview.className = 'image-preview';
    const image = document.createElement('img');
    image.alt = t.title;
    image.src = `${assetUrl(t.path)}?v=${Date.now()}`;
    image.onerror = () => status(`${t.title} を表示できません`, true);
    bar.append(button('画面に合わせる', () => preview.classList.remove('actual-size')),
        button('原寸で表示', () => preview.classList.add('actual-size')));
    preview.append(image);
    content.append(preview);
} if (t.kind === 'text') {
    const editor = document.createElement('textarea');
    editor.spellcheck = false;
    editor.value = t.doc.text;
    const positionKey = JSON.stringify([session.root, t.path]);
    const position = editorPositions.get(positionKey) || { start: 0, end: 0, direction: 'none', top: 0, left: 0 };
    editor.setSelectionRange(position.start, position.end, position.direction);
    rememberEditorPosition = () => editorPositions.set(positionKey, {
        start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection,
        top: editor.scrollTop, left: editor.scrollLeft
    });
    editor.setAttribute('aria-label', t.title);
    editor.addEventListener('input', () => { const text = editor.value; t.doc.text = text; updateCharacterCount(document.querySelector('#character-count'), text); t.pending = (t.pending || 0) + 1; renderTabs(); editQueue = editQueue.then(async () => { const result = await invoke('update_document', { path: t.path, text, revision: t.doc.revision }); t.doc.revision = result.revision; t.doc.original = result.original; t.pending--; t.syncError = null; }).catch(error => { t.pending = Math.max(0, t.pending - 1); t.syncError = String(error); fail(error); }); });
    content.append(editor);
    editor.scrollTop = position.top;
    editor.scrollLeft = position.left;
} }
async function renderFiles(t) { const bar = toolbar(t.path); const parent = t.path.split('/').slice(0, -1).join('/'); if (t.path)
    bar.append(button('↑ 上へ', () => openFolder(parent))); bar.append(button('ダッシュボード', () => openDashboard(t.path, true)), button('HTMLを選ぶ…', () => chooseDashboard(t.path)), button('更新', () => render())); const list = document.createElement('div'); list.className = 'files'; content.append(list); try {
    const entries = await invoke('list_files', { folder: t.path });
    if (active !== t)
        return;
    if (!entries.length) {
        list.textContent = 'このフォルダは空です。';
        return;
    }
    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'row';
        const name = button(`${entry.directory ? '▸' : '·'}  ${entry.name}`, () => entry.directory ? openFolder(entry.path) : openFile(entry.path));
        name.className = 'name';
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = entry.directory ? 'フォルダ' : `${Math.ceil(entry.size / 1024)} KB`;
        row.append(name, meta);
        if (!entry.directory && isText(entry.path))
            row.append(button('別窓', () => invoke('open_child', { path: entry.path })));
        list.append(row);
    }
}
catch (e) {
    fail(e);
} }
const isText = path => /\.(txt|md|markdown|mmd|html?|css|js|json|csv|log|yaml|yml|xml|tex)$/i.test(path);
const assetUrl = path => `project://localhost/${win.label}/${path.split('/').map(encodeURIComponent).join('/')}`;
async function openFolder(path) { addTab({ kind: 'files', path, title: path.split('/').at(-1) || 'ファイル' }); }
async function openFile(path) { if (/\.html?$/i.test(path))
    addTab({ kind: 'html', path, folder: path.split('/').slice(0, -1).join('/'), title: path.split('/').at(-1) });
else if (/\.(svg|png|jpe?g|gif|webp)$/i.test(path))
    addTab({ kind: 'image', path, title: path.split('/').at(-1) });
else if (/\.pdf$/i.test(path))
    addTab({ kind: 'pdf', path, title: path.split('/').at(-1) });
else if (isText(path))
    await openText(path);
else
    await message('このファイル形式の表示にはまだ対応していません。', { title: 'Writing Room' }); }
async function openText(path) { await editQueue; const doc = await invoke('read_document', { path }); addTab({ kind: 'text', path, doc, title: path.split('/').at(-1) }); }
async function save(t = active) { if (t?.kind !== 'text')
    return; await editQueue; if (t.syncError)
    throw new Error(t.syncError); t.doc = await invoke('save_document', { path: t.path }); renderTabs(); status(`${t.title} を保存しました`); }
async function openDashboard(folder, explicit = false) { let path = await invoke('dashboard', { folder, selection: null, disable: false, create: false }); if (!path) {
    if (!explicit && await invoke('dashboard_disabled', { folder }))
        return;
    if (!explicit) {
        const entries = await invoke('list_files', { folder });
        if (entries.some(e => /\.html?$/i.test(e.name)))
            return;
    }
    if (await confirm('表示するHTMLがありません。このフォルダに index.html を作成しますか？', { title: 'ダッシュボードの作成', okLabel: '作成する', cancelLabel: '作成しない' })) {
        path = await invoke('dashboard', { folder, selection: null, disable: false, create: true });
    }
    else {
        await invoke('dashboard', { folder, selection: null, disable: true, create: false });
        status('ダッシュボードは表示しません。ファイラーから後で追加できます。');
        return;
    }
} addTab({ kind: 'html', path, folder, title: folder ? `${folder.split('/').at(-1)} / 概要` : 'ダッシュボード' }); }
async function chooseDashboard(folder) { const entries = await invoke('list_files', { folder }); const html = entries.filter(e => !e.directory && /\.html?$/i.test(e.name)); if (!html.length)
    return openDashboard(folder, true); const selected = await open({ title: 'ダッシュボードのHTMLを選ぶ', defaultPath: `${session.root}/${folder}`, filters: [{ name: 'HTML', extensions: ['html', 'htm'] }], multiple: false, directory: false }); if (!selected)
    return; const prefix = `${session.root}/${folder ? `${folder}/` : ''}`; if (!selected.startsWith(prefix) || selected.slice(prefix.length).includes('/'))
    throw new Error('現在のフォルダ内のHTMLを選択してください。'); const path = await invoke('dashboard', { folder, selection: selected.slice(prefix.length), disable: false, create: false }); tabs = tabs.filter(t => !(t.kind === 'html' && t.folder === folder)); addTab({ kind: 'html', path, folder, title: 'ダッシュボード' }); }
async function setup() {
    restoringTabs = true;
    session = await invoke('get_session');
    if (!session) {
        canResumeWorkspace = await invoke('can_resume_workspace');
        render(); await refreshHistory(); await invoke('refresh_task_menu'); return;
    }
    const projectName = session.root.split('/').at(-1);
    await win.setTitle(session.file ? `${session.file.split('/').at(-1)} — Writing Room — ${projectName}` : `Writing Room — ${projectName}`);
    const missing = [];
    let saved;
    if (!session.parent) {
        try { saved = await invoke('get_tab_state'); }
        catch (error) { tabPersistenceEnabled = false; await fail(error); }
    }
    if (saved) {
        const restored = new Map();
        for (const [index, tab] of saved.tabs.entries()) {
            try {
                await invoke('validate_saved_tab', { tab });
                if (tab.kind === 'files') { await invoke('list_files', { folder: tab.path }); await openFolder(tab.path); }
                else if (tab.kind === 'text') await openText(tab.path);
                else if (tab.kind === 'html' || tab.kind === 'image' || tab.kind === 'pdf') await openFile(tab.path);
                else continue;
                active.title = tab.title;
                restored.set(index, active);
            } catch { missing.push(tab.path || 'プロジェクト直下'); }
        }
        active = restored.get(saved.active) || tabs.at(-1);
        render();
    } else if (session.file) {
    await openText(session.file);
}
else {
    await openFolder('');
    await openDashboard('');
}
    restoringTabs = false;
    status(session.root);
    rememberTabs();
    await invoke('refresh_task_menu');
    if (missing.length) await message(`復元できなかったタブがあります。\n\n${missing.join('\n')}`, { title: 'タブの復元', kind: 'warning' });
}
async function chooseProject() { const root = await open({ title: '執筆プロジェクトのフォルダを選ぶ', directory: true, multiple: false }); if (!root)
    return; await openProjectRoot(root); }
await listen('history-changed', () => { if (!session) refreshHistory().catch(fail); });
await listen('history-error', ({ payload }) => fail(payload));
await listen('open-recent-requested', ({ payload: root }) => openProjectRoot(root).catch(fail));
await listen('open-project-requested', () => chooseProject().catch(fail));
await listen('save-requested', () => save().catch(fail));
const navigateNumbered = createNumberedNavigation({ getActive: () => active, invoke, confirm,
    prepare: async tab => {
        await editQueue;
        if (tab.syncError) throw new Error(tab.syncError);
        if (tab.doc.text !== tab.doc.original) {
            if (!await confirm(`${tab.title} に未保存の編集があります。保存して移動しますか？`, {
                title: '連番ファイルへ移動', okLabel: '保存して移動', cancelLabel: 'キャンセル'
            })) return false;
            await save(tab);
        }
        return true;
    },
    openText: async (path, source) => {
        await editQueue;
        if (source.syncError) throw new Error(source.syncError);
        if (source.doc.text !== source.doc.original) throw new Error('未保存の編集があります。もう一度移動してください。');
        const existing = tabs.find(t => t.kind === 'text' && t.path === path);
        const doc = existing ? null : await invoke('read_document', { path });
        if (active !== source) return;
        if (source.doc.text !== source.doc.original) throw new Error('未保存の編集があります。もう一度移動してください。');
        if (existing) active = existing;
        else {
            if (source.contextMenu) await source.contextMenu.close();
            source.contextMenu = null;
            source.path = path;
            source.title = path.split('/').at(-1);
            source.doc = doc;
        }
        render();
        focusEditor();
    }, status });
await listen('numbered-previous-requested', () => navigateNumbered(-1).catch(fail));
await listen('numbered-next-requested', () => navigateNumbered(1).catch(fail));
function switchTab(direction) {
    if (tabs.length < 2) return;
    const index = tabs.indexOf(active);
    active = tabs[(index + direction + tabs.length) % tabs.length];
    render();
    tabsEl.querySelector(`[data-tab-id="${active.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    focusEditor();
}
await listen('tab-previous-requested', () => switchTab(-1));
await listen('tab-next-requested', () => switchTab(1));
await listen('track-document-requested', async () => {
    try {
        if (document.querySelector('dialog[open]')) return;
        const tab = active;
        if (tab?.kind !== 'text') throw new Error('追跡に追加する原稿の編集タブを開いてください。');
        const path = tab.path;
        await editQueue;
        if (tab.syncError) throw new Error(tab.syncError);
        if (tab.doc.text !== tab.doc.original) {
            if (!await confirm('この原稿を保存してから追跡に追加しますか？', { title: '追跡に追加', okLabel: '保存して追加' })) return;
            if (tab.path !== path) return;
            await save(tab);
        }
        if (tab.path !== path) return;
        const added = await invoke('track_document', { path });
        status(added ? `${tab.title} を追跡に追加しました。「進捗を記録」でcommitできます` : `${tab.title} はすでに追跡されています`);
    } catch (error) { fail(error); }
});
for (const project of [false, true]) {
    await listen(project ? 'show-project-history-requested' : 'show-document-history-requested', async () => {
        try {
            if (document.querySelector('dialog[open]')) return;
            if (!session) throw new Error('プロジェクトを開いてください。');
            if (!project && active?.kind !== 'text') throw new Error('履歴を確認する原稿の編集タブを開いてください。');
            await showHistory({ path: project ? null : active.path, invoke });
        } catch (error) { fail(error); }
    });
}
await listen('record-project-progress-requested', async () => {
    try {
        if (document.querySelector('dialog[open]')) return;
        if (!session) throw new Error('プロジェクトを開いてください。');
        if (!await confirm('プロジェクト内の未保存の原稿を保存してから、全体の差分を確認しますか？', { title: 'プロジェクトを記録', okLabel: '保存して続ける' })) return;
        await prepareTaskExecution();
        await recordProgress({ invoke, status, project: true });
    } catch (error) { fail(error); }
});
await listen('record-progress-requested', async () => {
    try {
        await editQueue;
        const tab = active;
        if (tab?.kind !== 'text') throw new Error('記録する原稿の編集タブを開いてください。');
        if (tab.syncError) throw new Error(tab.syncError);
        if (tab.doc.text !== tab.doc.original) {
            if (!await confirm('この原稿を保存してから差分を確認しますか？', { title: 'この原稿を記録', okLabel: '保存して続ける' })) return;
            await save(tab);
        }
        await recordProgress({ path: tab.path, invoke, status });
    } catch (error) { fail(error); }
});
await listen('focus-mode-requested', () => focusMode.toggle());
const applyEditorFontSize = size => {
    document.documentElement.style.setProperty('--editor-font-size', `${size}px`);
};
let fontSizeQueue = Promise.resolve();
function changeEditorFontSize(action) {
    if (active?.kind !== 'text') return;
    fontSizeQueue = fontSizeQueue.then(() => invoke('change_editor_font_size', { action }))
        .catch(fail);
}
for (const action of ['increase', 'decrease', 'reset']) {
    await listen(`font-${action}-requested`, () => changeEditorFontSize(action));
}
// The native menu handles =; accept + on keyboards where it uses a different key.
window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey ||
        !(event.metaKey || event.ctrlKey) || event.key !== '+' || active?.kind !== 'text') return;
    event.preventDefault();
    changeEditorFontSize('increase');
});
await listen('editor-font-size-changed', ({ payload }) => applyEditorFontSize(payload));
try { applyEditorFontSize(await invoke('get_editor_font_size')); } catch (error) { await fail(error); }

window.addEventListener('message', async (e) => { const iframe = content.querySelector('iframe'); if (!iframe || e.source !== iframe.contentWindow || e.data?.type !== 'project-link')
    return; try {
    const url = new URL(e.data.url);
    if (url.protocol !== 'project:' && url.hostname !== 'project.localhost') {
        await invoke('open_external_url', { url: url.href });
        return;
    }
    const prefix = `/${win.label}/`;
    if (!url.pathname.startsWith(prefix))
        return;
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const folder = path.replace(/\/$/, '');
    try {
        await invoke('list_files', { folder });
        await openFolder(folder);
        await openDashboard(folder);
    }
    catch {
        await openFile(path);
    }
}
catch (error) {
    fail(error);
} });
await listen('document-changed', ({ payload: doc }) => { for (const t of tabs) {
    if (t.doc?.path !== doc.path || doc.revision < t.doc.revision)
        continue;
    if (t.pending)
        continue;
    t.doc.revision = doc.revision;
    t.doc.original = doc.original;
    t.doc.text = doc.text;
    if (t === active) {
        const editor = content.querySelector('textarea');
        if (editor)
            editor.value = doc.text;
    }
} renderTabs(); });
await win.onCloseRequested(async (e) => { e.preventDefault(); try {
    await editQueue;
    if (tabs.some(t => t.syncError))
        throw new Error('同期できていない編集があります。内容をコピーして保管してください。');
    const dirty = session ? await invoke('dirty_project') : [];
    if (dirty.length && !await confirm(`未保存のファイルが ${dirty.length} 件あります。${session.parent ? '子ウィンドウを閉じますか？編集内容は親ウィンドウに保持されます。' : 'このプロジェクトのウィンドウを閉じますか？最後のウィンドウを閉じると編集内容は失われます。'}\n\n${dirty.map(p => p.split('/').at(-1)).join('\n')}`, { title: '未保存の編集', kind: 'warning' }))
        return;
    await flushTabState();
    await invoke('close_window');
}
catch (error) {
    fail(error);
} });
await listen('quit-requested', async () => { try {
    await editQueue;
    const dirty = await invoke('dirty_all');
    if (dirty.length && !await confirm(`未保存のファイルが ${dirty.length} 件あります。保存せずにアプリを終了しますか？\n\n${dirty.join('\n')}`, { title: 'Writing Roomを終了', kind: 'warning' }))
        return;
    await flushTabState();
    await invoke('quit_app');
}
catch (error) {
    fail(error);
} });
async function resumeWorkspace() {
    if (resumingWorkspace || openingProject) return;
    resumingWorkspace = true;
    openingProject = true;
    render();
    try {
        const missing = await invoke('restore_workspace');
        await setup();
        if (missing.length) await message(`復元できなかったプロジェクトがあります。\n\n${missing.join('\n')}`, { title: '作業状態の復元', kind: 'warning' });
    } finally {
        resumingWorkspace = false;
        openingProject = false;
        if (!session) render();
    }
}
setup().catch(fail);
await win.onFocusChanged(({ payload: focused }) => {
    if (focused) invoke('refresh_task_menu').catch(fail);
});

await listen('manage-tasks-requested', () => {
    if (!session) { message('プロジェクトを開いてからコマンドを登録してください').catch(fail); return; }
    manageNamedTasks({ invoke, status, confirm }).catch(fail);
});

await listen('run-task-requested', ({ payload: id }) => {
    if (!session) { message('プロジェクトを開いてからコマンドを実行してください').catch(fail); return; }
    runNamedTask({ invoke, status, prepare: prepareTaskExecution, id, openInApp: openTaskOutputInApp }).catch(fail);
});

await listen('prepare-task-save', async ({ payload }) => {
    let error;
    try {
        await editQueue;
        if (tabs.some(tab => tab.syncError)) throw new Error('同期できていない編集があります。内容を確認してください。');
    } catch (e) { error = String(e); }
    await window.__TAURI__.event.emitTo(payload.sender, 'task-save-ready', { request: payload.request, label: win.label, error });
});
async function prepareTaskExecution() {
    const labels = await invoke('project_editor_windows');
    const request = crypto.randomUUID();
    const pending = new Set(labels);
    let unlisten, timer;
    try {
        await new Promise(async (resolve, reject) => {
            timer = setTimeout(() => reject(new Error('編集内容の同期を確認できませんでした。実行を中止しました。')), 10000);
            try {
                unlisten = await listen('task-save-ready', ({ payload }) => {
                    if (payload.request !== request) return;
                    if (payload.error) { reject(new Error(payload.error)); return; }
                    pending.delete(payload.label);
                    if (!pending.size) resolve();
                });
                await Promise.all(labels.map(label => window.__TAURI__.event.emitTo(label, 'prepare-task-save', { request, sender: win.label })));
                if (!pending.size) resolve();
            } catch (e) { reject(e); }
        });
    } finally { clearTimeout(timer); unlisten?.(); }
}

await listen('show-task-log-requested', () => showTaskLog({ invoke, status, openInApp: openTaskOutputInApp }));

async function openTaskOutputInApp(path) {
    await prepareTaskExecution();
    const output = await invoke('prepare_task_output', { path });
    const existing = tabs.find(tab => tab.path === output.path && tab.kind === output.kind
        || output.doc && tab.kind === 'text' && tab.doc?.path === output.doc.path);
    if (existing) {
        if (output.doc) existing.doc = output.doc;
        active = existing;
        render();
    } else {
        addTab({ kind: output.kind, path: output.path, title: output.path.split('/').at(-1),
            ...(output.doc ? { doc: output.doc } : {}),
            ...(output.kind === 'html' ? { folder: output.path.split('/').slice(0, -1).join('/') } : {}) });
    }
}

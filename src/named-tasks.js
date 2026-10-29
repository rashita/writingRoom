export async function manageNamedTasks({ invoke, status, confirm }) {
    if (document.querySelector('#tasks-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'tasks-dialog';
    dialog.innerHTML = `<form><h2>プロジェクトのコマンド</h2><p>名前と定型コマンドを登録します。</p><div class="task-list"></div><button type="button" class="task-add">コマンドを追加</button><p role="alert"></p><div class="task-actions"><button type="button" class="task-cancel">キャンセル</button><button type="submit">保存</button></div></form>`;
    document.body.append(dialog);
    let busy = true;
    let changed = false;
    let expected;
    let expectedDefaultTask;
    const error = dialog.querySelector('[role="alert"]');
    const list = dialog.querySelector('.task-list');
    function add(task = { id: crypto.randomUUID(), label: '', command: '' }) {
        const row = document.createElement('fieldset');
        row.dataset.id = task.id;
        row.innerHTML = `<label>名前<input class="task-label" required placeholder="例：PDFを作る"></label><label>コマンド<input class="task-command" required placeholder="例：make pdf" spellcheck="false"></label><label>成果物（プロジェクトからの相対パス・任意）<input class="task-output" placeholder="例：Build/book.pdf" spellcheck="false"></label><label class="task-default"><input type="checkbox" class="task-open-external">既定の外部アプリで開く</label><label class="task-default"><input type="checkbox" class="task-auto-open">成功後に自動で開く</label><label class="task-default"><input type="radio" name="default-task">このコマンドを既定とする（⌘B）</label><button type="button">削除</button>`;
        row.querySelector('.task-label').value = task.label;
        row.querySelector('.task-command').value = task.command;
        row.querySelector('.task-output').value = task.output || '';
        row.querySelector('.task-open-external').checked = task.open_external || false;
        row.querySelector('.task-auto-open').checked = task.auto_open || false;
        row.querySelector('button').onclick = () => { row.remove(); ensureDefault(); changed = true; };
        row.oninput = () => { changed = true; };
        list.append(row);
        ensureDefault();
        return row;
    }
    function ensureDefault() {
        if (!list.querySelector('[name="default-task"]:checked')) {
            const first = list.querySelector('[name="default-task"]');
            if (first) first.checked = true;
        }
    }
    async function close() {
        if (busy) return;
        if (!changed || await confirm('コマンドの変更を破棄しますか？', { okLabel: '破棄する' })) dialog.close();
    }
    dialog.querySelector('.task-cancel').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('.task-add').onclick = () => {
        changed = true;
        add().querySelector('input').focus();
    };
    const setBusy = value => {
        busy = value;
        dialog.querySelectorAll('button, input').forEach(el => { el.disabled = value; });
    };
    dialog.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        if (busy) return;
        const tasks = [...list.children].map(row => ({
            id: row.dataset.id,
            label: row.querySelector('.task-label').value.trim(),
            command: row.querySelector('.task-command').value.trim(),
            output: row.querySelector('.task-output').value.trim(),
            auto_open: row.querySelector('.task-auto-open').checked,
            open_external: row.querySelector('.task-open-external').checked,
        }));
        setBusy(true);
        error.textContent = '';
        try {
            const defaultTask = list.querySelector('[name="default-task"]:checked')?.closest('fieldset').dataset.id || null;
            await invoke('save_named_tasks', { tasks, expected, defaultTask, expectedDefaultTask });
            dialog.close();
        } catch (e) { error.textContent = String(e); }
        finally { setBusy(false); }
    };
    dialog.showModal();
    setBusy(true);
    try {
        const settings = await invoke('get_named_task_settings');
        expected = settings.tasks;
        expectedDefaultTask = settings.default_task;
        expected.forEach(add);
        const chosen = [...list.children].find(row => row.dataset.id === expectedDefaultTask);
        if (chosen) chosen.querySelector('[name="default-task"]').checked = true;
        setBusy(false);
        dialog.querySelector('input, .task-add').focus();
    } catch (e) {
        dialog.remove();
        throw e;
    }
}

// Keep just one bounded result per window; nothing is written to disk.
let lastTaskLog;
const LOG_LIMIT = 200000;
function retainLog(record) {
    const clip = text => text.length > LOG_LIMIT ? `${text.slice(0, LOG_LIMIT)}\n（以降のログは省略しました）` : text;
    record.log = clip(record.log);
    lastTaskLog = record;
}
function resultDialog(title) {
    const dialog = document.createElement('dialog');
    dialog.id = 'run-task-dialog';
    dialog.innerHTML = `<h2></h2><p class="task-command"></p><p role="status"></p><pre></pre><div class="task-actions"><button type="button" class="task-rerun" hidden>再実行</button><button type="button" class="task-open-output" hidden>成果物を開く</button><button type="button" class="task-close">閉じる</button></div>`;
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('.task-close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { if (dialog.dataset.running !== 'true') dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}
async function openOutput(record, invoke, openInApp) {
    if (record.openExternal) await invoke('open_task_output', { path: record.output });
    else await openInApp(record.output);
}
function displayRecord(dialog, record, invoke, openInApp) {
    dialog.querySelector('h2').textContent = record.label;
    dialog.querySelector('.task-command').textContent = `${record.time}\n${record.command}`;
    dialog.querySelector('[role="status"]').textContent = record.summary;
    dialog.querySelector('pre').textContent = record.log;
    const open = dialog.querySelector('.task-open-output');
    open.hidden = !record.output;
    open.disabled = !record.success || !!record.outputError;
    open.onclick = async () => {
        open.disabled = true;
        try {
            await openOutput(record, invoke, openInApp);
            if (!record.openExternal) dialog.close();
        }
        catch (e) {
            dialog.querySelector('[role="status"]').textContent = `${record.summary}\n${String(e)}`;
        } finally { open.disabled = false; }
    };
}
export function showTaskLog({ invoke, status, message, openInApp }) {
    const current = document.querySelector('#run-task-dialog');
    if (current?.dataset.running === 'true') { status('コマンドを実行中です'); return; }
    if (!lastTaskLog) { return message('このウィンドウにはコマンドのログがありません', { title: 'コマンドのログ' }); }
    if (current) { current.close(); current.remove(); }
    displayRecord(resultDialog(lastTaskLog.label), lastTaskLog, invoke, openInApp);
}
export async function runNamedTask({ invoke, status, message, prepare, id, openInApp }) {
    const previous = document.querySelector('#run-task-dialog');
    if (previous?.dataset.running === 'true') { status('コマンドを実行中です'); return; }
    if (document.querySelector('#tasks-dialog')) { await message('コマンドの登録画面を閉じてから実行してください', { title: 'コマンドを実行' }); return; }
    if (previous) { previous.close(); previous.remove(); }
    const dialog = resultDialog('コマンドを実行');
    // Mark busy before the first await to prevent overlapping starts.
    dialog.dataset.running = 'true';
    let outputOpenFailed = false;
    const record = { label: 'コマンド', command: '', time: new Date().toLocaleString(), summary: '', log: '', output: '', success: false };
    try {
        const tasks = await invoke('get_named_tasks');
        const task = tasks.find(task => task.id === id);
        if (!task) throw new Error('登録されたコマンドが見つかりません');
        record.label = task.label;
        record.command = task.command;
        dialog.querySelector('h2').textContent = task.label;
        dialog.querySelector('.task-command').textContent = task.command;
        dialog.querySelector('[role="status"]').textContent = '保存して実行中…（閉じても処理は続きます）';
        status(`${task.label}：実行中…`);
        await prepare();
        const result = await invoke('run_named_task', { id });
        record.success = result.success;
        record.output = result.output;
        record.openExternal = result.open_external || false;
        record.outputError = result.output_error;
        record.summary = result.success ? '完了しました' : `失敗しました（${result.code === null ? 'シグナルによる終了' : `終了コード ${result.code}`}）`;
        record.log = [result.stdout && `標準出力\n${result.stdout}`, result.stderr && `標準エラー\n${result.stderr}`].filter(Boolean).join('\n\n') || '出力はありません';
        if (result.output_error) record.summary += `\n${result.output_error}`;
        // Save the log before opening the output.
        retainLog(record);
        if (result.success && result.auto_open && result.output && !result.output_error) {
            try {
                await openOutput(record, invoke, openInApp);
                record.summary += '\n成果物を開きました';
                dialog.close();
            } catch (error) {
                outputOpenFailed = true;
                record.summary += `\n成果物を開けませんでした：${String(error)}`;
            }
        }
    } catch (error) {
        record.summary = '実行できませんでした';
        record.log = String(error);
    } finally {
        retainLog(record);
        dialog.dataset.running = 'false';
        if (!record.success || record.outputError || outputOpenFailed) status(`${record.label}：${record.summary}`, true);
        else status('');
        if (dialog.open) {
            displayRecord(dialog, record, invoke, openInApp);
            const rerun = dialog.querySelector('.task-rerun');
            rerun.hidden = false;
            rerun.onclick = () => runNamedTask({ invoke, status, message, prepare, id, openInApp });
        } else dialog.remove();
    }
}

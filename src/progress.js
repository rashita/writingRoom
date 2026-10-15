// Optional progress UI: all markup and styling live here for easy removal.
export async function recordProgress({ path, invoke, status }) {
    if (document.querySelector('#progress-dialog')) return;
    const expected = await invoke('preview_progress', { path });
    if (!expected.diff) { status('前回のcommitから変更はありません'); return; }
    const dialog = document.createElement('dialog');
    dialog.id = 'progress-dialog';
    dialog.style.cssText = 'width:min(760px,90vw);max-height:85vh;padding:24px;border:1px solid #cbd4cd;border-radius:8px;color:#303b38;background:#f4f3ee';
    dialog.innerHTML = `<form><h2>進捗を記録</h2><p></p><pre style="max-height:40vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:12px;user-select:text"></pre><label for="progress-message">何を進めましたか？</label><input id="progress-message" required placeholder="例：導入の説明を短くした" style="display:block;width:100%;margin:10px 0 16px;padding:10px;font:inherit"><div role="alert" style="white-space:pre-wrap;color:#a13d36"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button type="button">キャンセル</button><button type="submit">記録する</button></div></form>`;
    dialog.querySelector('p').textContent = `対象：${path}（この原稿1件をcommitします）`;
    dialog.querySelector('pre').textContent = expected.diff;
    const input = dialog.querySelector('input');
    const buttons = [...dialog.querySelectorAll('button')];
    let busy = false;
    buttons[0].onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        if (busy || !input.value.trim()) return;
        busy = true;
        buttons.forEach(button => button.disabled = true);
        input.disabled = true;
        try {
            await invoke('commit_progress', { path, expected, message: input.value });
            status('原稿の進捗をcommitしました');
            dialog.close();
        } catch (error) {
            dialog.querySelector('[role="alert"]').textContent = String(error);
        } finally {
            busy = false;
            buttons.forEach(button => button.disabled = false);
            input.disabled = false;
        }
    };
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
}

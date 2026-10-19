export async function showHistory({ path = null, invoke }) {
    if (document.querySelector('dialog[open]')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'history-dialog';
    dialog.setAttribute('aria-labelledby', 'history-title');
    dialog.innerHTML = `<header><div><h2 id="history-title"></h2><p class="history-scope"></p></div><button type="button" aria-label="履歴を閉じる">閉じる</button></header><p class="history-error" role="alert"></p><div class="history-layout"><section class="history-list" aria-label="記録一覧"><div class="history-entries"></div><p class="history-state" role="status"></p><button class="history-more" type="button">さらに読み込む</button></section><section class="history-detail" aria-label="記録の詳細"><p class="history-meta"></p><pre class="history-message"></pre><pre class="history-diff">記録を選ぶと差分を表示します。</pre></section></div>`;
    dialog.querySelector('h2').textContent = path ? 'この原稿の履歴' : 'プロジェクトの履歴';
    dialog.querySelector('.history-scope').textContent = path || 'プロジェクトフォルダ内の記録';
    dialog.querySelector('header button').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove());
    const entries = dialog.querySelector('.history-entries');
    const more = dialog.querySelector('.history-more');
    const state = dialog.querySelector('.history-state');
    const error = dialog.querySelector('.history-error');
    const diff = dialog.querySelector('.history-diff');
    let offset = 0;
    let selection = 0;
    let loading = false;
    const date = value => new Date(value).toLocaleString('ja-JP');
    async function select(entry, button) {
        const request = ++selection;
        for (const item of entries.children) item.setAttribute('aria-pressed', String(item === button));
        dialog.querySelector('.history-meta').textContent = `${date(entry.date)} · ${entry.author} · ${entry.short_id}`;
        dialog.querySelector('.history-message').textContent = entry.message;
        diff.textContent = '差分を読み込んでいます…';
        error.textContent = '';
        try {
            const patch = await invoke('progress_history_diff', { path, id: entry.id });
            if (request !== selection || !dialog.isConnected) return;
            diff.replaceChildren();
            if (!patch) { diff.textContent = 'この記録には表示できる差分がありません。'; return; }
            const fragment = document.createDocumentFragment();
            for (const line of patch.split('\n')) {
                const span = document.createElement('span');
                span.className = line.startsWith('+') ? 'history-added' : line.startsWith('-') ? 'history-removed' : line.startsWith('@@') ? 'history-hunk' : '';
                span.textContent = `${line}\n`;
                fragment.append(span);
            }
            diff.append(fragment);
            diff.scrollTop = 0;
        } catch (err) {
            if (request !== selection || !dialog.isConnected) return;
            diff.textContent = '差分を表示できませんでした。記録を選び直すと再試行できます。';
            error.textContent = String(err);
        }
    }
    async function load() {
        if (loading) return;
        loading = true;
        more.disabled = true;
        error.textContent = '';
        state.textContent = '履歴を読み込んでいます…';
        try {
            const page = await invoke('list_progress_history', { path, offset });
            if (!dialog.isConnected) return;
            for (const entry of page) {
                const button = document.createElement('button');
                button.type = 'button';
                button.setAttribute('aria-pressed', 'false');
                const title = document.createElement('strong');
                title.textContent = entry.message.split('\n')[0] || '（メッセージなし）';
                const meta = document.createElement('small');
                meta.textContent = `${date(entry.date)} · ${entry.short_id}`;
                button.append(title, meta);
                button.onclick = () => select(entry, button);
                entries.append(button);
                if (offset === 0 && entries.children.length === 1) select(entry, button);
            }
            offset += page.length;
            more.hidden = page.length < 50;
            state.textContent = offset ? `${offset}件の記録を表示` : 'まだ記録はありません。';
        } catch (err) {
            error.textContent = String(err);
            state.textContent = '履歴を読み込めませんでした。';
            more.textContent = '再試行';
        } finally {
            loading = false;
            more.disabled = false;
        }
    }
    more.onclick = load;
    document.body.append(dialog);
    dialog.showModal();
    await load();
}

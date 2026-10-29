export function numberedPath(path, direction) {
    const slash = path.lastIndexOf('/') + 1;
    const name = path.slice(slash);
    const match = /^(.*?)([0-9]+)(\.[^.]+)?$/.exec(name);
    if (!match) return null;
    const number = BigInt(match[2]) + BigInt(direction);
    if (number < 0n) return null;
    return path.slice(0, slash) + match[1] + String(number).padStart(match[2].length, '0') + (match[3] || '');
}

export function createNumberedNavigation({ getActive, invoke, confirm, openText, message, prepare = async () => true }) {
    let busy = false;
    return async direction => {
        const tab = getActive();
        if (busy || tab?.kind !== 'text') return;
        const path = numberedPath(tab.path, direction);
        if (!path) {
            await message(/(?:^|\D)0+(?:\.[^.]+)?$/.test(tab.title) && direction < 0
                ? 'これより前の連番ファイルはありません。' : 'ファイル名の末尾に連番がありません。', { title: '連番ファイルへ移動' });
            return;
        }
        busy = true;
        try {
            if (!await prepare(tab) || getActive() !== tab) return;
            const folder = path.slice(0, path.lastIndexOf('/') + 1).replace(/\/$/, '');
            const entries = await invoke('list_files', { folder });
            if (!entries.some(entry => entry.path === path)) {
                if (!await confirm(`${path.split('/').at(-1)} を作成しますか？`, {
                    title: '連番ファイルの作成', okLabel: '作成', cancelLabel: 'キャンセル'
                })) return;
                if (getActive() !== tab) return;
                await invoke('create_numbered_document', { path });
            }
            if (getActive() !== tab) return;
            await openText(path, tab);
        } finally { busy = false; }
    };
}

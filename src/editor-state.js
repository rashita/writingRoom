// Full editing state belongs to an open manuscript, never to a reusable tab.
export function editorKey(root, tab) {
    return JSON.stringify([root, tab.path, !!tab.untitled]);
}

export function createEditorStateStore() {
    const open = new Map();
    const positions = new Map();
    return {
        get: key => open.get(key) || positions.get(key),
        save(key, snapshot) { open.set(key, snapshot); positions.delete(key); },
        retain(keys) {
            const keep = new Set(keys);
            for (const [key, snapshot] of open) {
                if (keep.has(key)) continue;
                const { anchor, head } = snapshot.state.selection.main;
                positions.set(key, { anchor, head, top: snapshot.top, left: snapshot.left });
                open.delete(key);
            }
        },
        rename(from, to) {
            for (const entries of [open, positions]) {
                if (!entries.has(from)) continue;
                entries.set(to, entries.get(from));
                entries.delete(from);
            }
        }
    };
}

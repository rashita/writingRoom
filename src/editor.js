import { EditorState, EditorView, StateEffect, history, historyKeymap, defaultKeymap, keymap } from './cm-bundle.js';

function textChange(old, text) {
    let from = 0, end = old.length, nextEnd = text.length;
    while (from < end && from < nextEnd && old[from] === text[from]) from++;
    while (end > from && nextEnd > from && old[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
    return { from, to: end, insert: text.slice(from, nextEnd) };
}

// Plain text editing for now: no Markdown styling, completion or auto-indentation.
export function createEditor({ parent, text, title, disabled = false, saved, onChange }) {
    let receiving = false;
    const extensions = [
        history(),
        keymap.of([...historyKeymap, ...defaultKeymap.filter(binding =>
            binding.key !== 'Enter' && binding.key !== 'Mod-Enter')]),
        EditorState.tabSize.of(4),
        EditorView.lineWrapping,
        // CodeMirror rewrites the root class on focus and state updates.
        EditorView.editorAttributes.of({ class: 'manuscript-editor' }),
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({ 'aria-label': title, spellcheck: 'false', autocapitalize: 'off' }),
        EditorView.updateListener.of(update => {
            if (update.docChanged && !receiving) onChange(update.state.doc.toString());
        })
    ];
    let state = saved?.state;
    if (!state) state = EditorState.create({ doc: text, extensions, selection: saved ? { anchor: Math.min(saved.anchor, text.length), head: Math.min(saved.head, text.length) } : undefined });
    else {
        if (state.doc.toString() !== text) state = state.update({ changes: textChange(state.doc.toString(), text) }).state;
        state = state.update({ effects: StateEffect.reconfigure.of(extensions) }).state;
    }
    const view = new EditorView({ state, parent });
    if (saved) view.requestMeasure({
        read: () => null,
        write: () => { view.scrollDOM.scrollTop = saved.top; view.scrollDOM.scrollLeft = saved.left; }
    });
    return {
        focus() {
            const { scrollTop, scrollLeft } = view.scrollDOM;
            view.focus();
            view.scrollDOM.scrollTop = scrollTop;
            view.scrollDOM.scrollLeft = scrollLeft;
        },
        snapshot: () => ({ state: view.state, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }),
        setText(text) {
            const old = view.state.doc.toString();
            if (old === text) return;
            // Keep unaffected selections in place when another window edits this document.
            receiving = true;
            try { view.dispatch({ changes: textChange(old, text) }); }
            finally { receiving = false; }
        },
        destroy: () => view.destroy()
    };
}

import { EditorView } from './cm-bundle.js';

// Scroll effects run after the current transaction, never inside a view update.
export function createTypewriter(view, enabled = false) {
    let compositionTimer = 0;
    let commitScroll;
    let frame = 0, dragging = false, destroyed = false;
    const schedule = () => {
        if (!enabled || destroyed || dragging || view.composing || frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (!enabled || destroyed || dragging || view.composing) return;
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
        });
    };
    let padding;
    const resize = () => {
        const next = Math.max(0, (view.scrollDOM.clientHeight - view.defaultLineHeight) / 2);
        if (next === padding) return;
        padding = next;
        view.dom.style.setProperty('--typewriter-padding', `${padding}px`);
        // Geometry also changes when CodeMirror measures newly visible text.
        // Updating the padding must never pull a reader back to the caret.
    };
    // WebKit can scroll up one line while removing marked text on commit.
    // Restore before painting, without intercepting or changing the IME edit.
    const beforeInput = event => {
        if (enabled && !dragging && event.isComposing && event.inputType === 'deleteCompositionText') {
            commitScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
        } else if (event.inputType !== 'insertFromComposition') {
            commitScroll = undefined;
        }
    };
    const restoreCommitScroll = () => {
        if (!enabled || !commitScroll) return;
        if (view.scrollDOM.scrollTop !== commitScroll.top) view.scrollDOM.scrollTop = commitScroll.top;
        if (view.scrollDOM.scrollLeft !== commitScroll.left) view.scrollDOM.scrollLeft = commitScroll.left;
    };
    const input = event => {
        if (event.inputType === 'deleteCompositionText' || event.inputType === 'insertFromComposition') restoreCommitScroll();
    };
    const pointerDown = () => { dragging = true; cancel(); };
    const pointerUp = () => { dragging = false; };
    const compositionEnd = () => {
        restoreCommitScroll();
        commitScroll = undefined;
        // CodeMirror finishes its own composition bookkeeping after this event.
        clearTimeout(compositionTimer);
        compositionTimer = setTimeout(schedule, 50);
    };
    const cancel = () => { cancelAnimationFrame(frame); frame = 0; commitScroll = undefined; };
    view.dom.addEventListener('beforeinput', beforeInput, true);
    view.dom.addEventListener('input', input, true);
    view.dom.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    view.scrollDOM.addEventListener('wheel', cancel, { passive: true });
    view.dom.addEventListener('compositionend', compositionEnd);
    const observer = new ResizeObserver(resize);
    observer.observe(view.scrollDOM);
    const setEnabled = value => {
        enabled = value;
        cancel();
        view.scrollDOM.classList.toggle('typewriter-mode', enabled);
        resize();
        schedule();
    };
    setEnabled(enabled);
    return {
        setEnabled,
        center: schedule,
        update(update) {
            if (update.transactions.some(transaction =>
                ['input', 'delete', 'undo', 'redo', 'select'].some(event => transaction.isUserEvent(event))
                && !transaction.isUserEvent('select.pointer'))) schedule();
            if (update.geometryChanged) resize();
        },
        destroy() {
            destroyed = true;
            cancel();
            clearTimeout(compositionTimer);
            observer.disconnect();
            view.dom.removeEventListener('beforeinput', beforeInput, true);
            view.dom.removeEventListener('input', input, true);
            view.dom.removeEventListener('pointerdown', pointerDown);
            window.removeEventListener('pointerup', pointerUp);
            window.removeEventListener('pointercancel', pointerUp);
            view.scrollDOM.removeEventListener('wheel', cancel);
            view.dom.removeEventListener('compositionend', compositionEnd);
        }
    };
}

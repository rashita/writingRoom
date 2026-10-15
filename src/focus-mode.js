export function createFocusMode(body, getEditor) {
    let enabled = false;
    const setEnabled = value => {
        for (const [selector, variable] of [['nav', '--focus-tabs-height'], ['footer', '--focus-status-height']]) {
            const bar = body.querySelector(selector);
            if (!bar) continue;
            if (value) body.style.setProperty(variable, `${bar.offsetHeight}px`);
            bar.inert = value;
        }
        enabled = value;
        body.classList.toggle('focus-mode', enabled);
    };
    return {
        toggle() {
            const editor = getEditor();
            if (!editor) return;
            setEnabled(!enabled);
            // Keep the existing editor, selection and scroll position intact.
            editor.focus({ preventScroll: true });
        },
        sync() {
            if (!getEditor()) setEnabled(false);
        },
        handleKeydown(event) {
            if (!enabled || event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault();
            setEnabled(false);
        }
    };
}

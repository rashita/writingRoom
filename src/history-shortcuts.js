// Capture the second stroke before it can become manuscript text.
export function createHistoryShortcuts({ getContext, waiting, record, history }) {
    let context = null;
    let consumedKey = null;
    const cancel = () => {
        if (!context) return;
        context = null;
        waiting(false);
    };
    const consume = event => {
        consumedKey = event.key.toLowerCase();
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    return {
        cancel,
        handleKeyup(event) {
            if (event.key.toLowerCase() === consumedKey) consumedKey = null;
        },
        handleKeydown(event) {
            if (event.isComposing || event.keyCode === 229) { cancel(); return; }
            const key = event.key.toLowerCase();
            if (event.repeat && key === consumedKey) { consume(event); return; }
            if (!event.repeat) consumedKey = null;
            const current = getContext();
            if (context && current !== context) cancel();
            if (!context) {
                if (!current || event.defaultPrevented || event.altKey || event.shiftKey ||
                    !(event.metaKey || event.ctrlKey) || key !== 'k') return;
                consume(event);
                if (event.repeat) return;
                context = current;
                waiting(true);
                return;
            }
            if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
            if (event.repeat) { consume(event); return; }
            if (key === 'escape') { consume(event); cancel(); return; }
            if (!event.altKey && !event.shiftKey && (key === 'k' || key === 'l')) {
                consume(event);
                const target = context;
                cancel();
                if (key === 'k') record(target);
                else history(target);
                return;
            }
            cancel();
            // Let unrelated shortcuts (e.g. Save) work normally; consume an
            // unassigned plain second stroke so it cannot alter the manuscript.
            if (!(event.metaKey || event.ctrlKey || event.altKey)) consume(event);
        }
    };
}

// Capture the second stroke before it can become manuscript text.
export function createChordShortcuts({ getContext, waiting, prefix, actions }) {
    let context = null;
    let consumedKey = null;
    const cancel = () => {
        if (!context) return;
        context = null;
        waiting(false);
    };
    const keyIdentity = event => event.code || event.key.toLowerCase();
    const consume = event => {
        consumedKey = keyIdentity(event);
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    return {
        cancel,
        handleKeyup(event) {
            if (keyIdentity(event) === consumedKey) consumedKey = null;
        },
        handleKeydown(event) {
            const current = getContext();
            if (context && current !== context) cancel();
            const key = event.key.toLowerCase();
            // During an explicitly requested chord, recognize physical letter keys even
            // when the IME reports Process/229 or marks this stroke as composing.
            const stroke = /^Key[A-Z]$/.test(event.code || '') ? event.code.slice(3).toLowerCase() : key;
            if (event.repeat && keyIdentity(event) === consumedKey) { consume(event); return; }
            if (!event.repeat) consumedKey = null;
            if (context && !event.altKey && !event.shiftKey && Object.hasOwn(actions, stroke)) {
                consume(event);
                if (event.repeat) return;
                const target = context;
                cancel();
                actions[stroke](target);
                return;
            }
            if (event.isComposing || event.keyCode === 229) { cancel(); return; }
            if (!context) {
                if (!current || event.defaultPrevented || event.altKey || event.shiftKey ||
                    !(event.metaKey || event.ctrlKey) || key !== prefix) return;
                consume(event);
                if (event.repeat) return;
                context = current;
                waiting(true);
                return;
            }
            if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
            if (event.repeat) { consume(event); return; }
            if (key === 'escape') { consume(event); cancel(); return; }
            cancel();
            // Let unrelated shortcuts (e.g. Save) work normally; consume an
            // unassigned plain second stroke so it cannot alter the manuscript.
            if (!(event.metaKey || event.ctrlKey || event.altKey)) consume(event);
        }
    };
}

export function createHistoryShortcuts({ getContext, waiting, record, history }) {
    return createChordShortcuts({ getContext, waiting, prefix: 'k', actions: { k: record, l: history } });
}

// Opt-in diagnostic capture. Records geometry and event order, never manuscript text.
export function startTypewriterTrace(duration = 20000) {
    window.stopTypewriterTrace?.();
    const editor = document.querySelector('.manuscript-editor');
    const scroller = editor?.querySelector('.cm-scroller');
    const content = editor?.querySelector('.cm-content');
    if (!scroller || !content) throw new Error('テキストタブを開いてください。');
    const started = performance.now(), records = [];
    let previous = '', stopped = false;
    const geometry = () => {
        const last = content.lastElementChild;
        const selection = window.getSelection();
        const rect = selection?.rangeCount && content.contains(selection.focusNode)
            ? selection.getRangeAt(0).getBoundingClientRect() : null;
        return {
            top: scroller.scrollTop, height: scroller.scrollHeight, clientHeight: scroller.clientHeight,
            padding: getComputedStyle(content).paddingBottom,
            lastHeight: last?.getBoundingClientRect().height,
            caretTop: rect?.top, caretHeight: rect?.height
        };
    };
    const record = (event, extra = {}) => {
        if (stopped || records.length >= 3000) return;
        records.push({ ms: Math.round((performance.now() - started) * 10) / 10, event, ...geometry(), ...extra });
    };
    const sample = () => {
        const value = JSON.stringify(geometry());
        if (value !== previous) { previous = value; record('geometry'); }
    };
    let prototype = scroller, descriptor;
    while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop'))) prototype = Object.getPrototypeOf(prototype);
    const own = Object.getOwnPropertyDescriptor(scroller, 'scrollTop');
    if (descriptor?.get && descriptor?.set && (!own || own.configurable)) {
        Object.defineProperty(scroller, 'scrollTop', {
            configurable: true,
            get() { return descriptor.get.call(this); },
            set(value) {
                const before = descriptor.get.call(this);
                descriptor.set.call(this, value);
                if (before !== descriptor.get.call(this)) record('scrollTop-write', { before, requested: value, stack: new Error().stack });
            }
        });
    }
    const events = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'scroll', 'wheel', 'pointerdown'];
    const handle = event => record(event.type, {
        inputType: event.inputType, isComposing: event.isComposing,
        key: event.type === 'keydown' ? (event.key === 'Enter' ? 'Enter' : 'other') : undefined
    });
    for (const event of events) editor.addEventListener(event, handle, true);
    const mutations = new MutationObserver(() => record('DOM-mutation'));
    mutations.observe(content, { subtree: true, childList: true, characterData: true });
    const interval = setInterval(sample, 8);
    const stop = () => {
        if (stopped) return;
        record('stop');
        stopped = true;
        clearInterval(interval);
        clearTimeout(timer);
        mutations.disconnect();
        for (const event of events) editor.removeEventListener(event, handle, true);
        if (own) Object.defineProperty(scroller, 'scrollTop', own);
        else delete scroller.scrollTop;
        window.typewriterTraceLog = JSON.stringify({ userAgent: navigator.userAgent, records }, null, 2);
        console.log(window.typewriterTraceLog);
        return window.typewriterTraceLog;
    };
    const timer = setTimeout(stop, duration);
    window.stopTypewriterTrace = stop;
    record('start');
    console.log('20秒間、入力イベントとスクロール位置を記録します。本文は記録しません。');
}

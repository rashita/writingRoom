// Move focus out of the manuscript while a chord is pending, so the IME
// cannot start inserting the second stroke into the editor.
export function createChordInput(document) {
    let sink, previous;
    return {
        begin() {
            if (sink) return;
            previous = document.activeElement;
            sink = document.createElement('div');
            sink.tabIndex = -1;
            sink.className = 'chord-input';
            sink.setAttribute('aria-label', '次の操作キーを待っています');
            sink.contentEditable = 'false';
            document.body.append(sink);
            sink.focus({ preventScroll: true });
        },
        end() {
            if (!sink) return;
            const restore = document.activeElement === sink && previous?.isConnected;
            sink.remove();
            sink = null;
            if (restore) previous.focus({ preventScroll: true });
            previous = null;
        }
    };
}

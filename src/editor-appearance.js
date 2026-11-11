const colors = [
    ['background', '本文の背景', '#ffffff'],
    ['foreground', '本文の文字色', '#303b38'],
    ['activeLineBackground', '現在行の背景', '#004444'],
    ['selectionBackground', '選択範囲の背景', '#d7d4f0']
];
const hexColor = /^#[0-9a-f]{6}$/i;
const properties = {
    background: '--editor-background',
    foreground: '--editor-foreground',
    activeLineBackground: '--editor-active-line-background',
    selectionBackground: '--editor-selection-background',
    fontFamily: '--editor-font-family',
    fontSize: '--project-editor-font-size'
};

export function applyEditorAppearance(target, appearance) {
    for (const [key, property] of Object.entries(properties)) {
        let value = appearance[key];
        if (key === 'fontSize') {
            value = Number.isInteger(value) && value >= 12 && value <= 32 ? `${value}px` : null;
        } else if (key === 'fontFamily') {
            if (!value || !CSS.supports('font-family', value)) value = null;
        } else if (!hexColor.test(value)) {
            value = null;
        }
        if (value) target.style.setProperty(property, value);
        else target.style.removeProperty(property);
    }
    target.toggleAttribute('data-editor-selection-color', hexColor.test(appearance.selectionBackground));
}

export function showEditorAppearance({ appearance, save, preview, close }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'editor-appearance-dialog';
    dialog.setAttribute('aria-labelledby', 'editor-appearance-title');
    dialog.innerHTML = `
        <form>
            <h2 id="editor-appearance-title">プロジェクトのエディタ外観</h2>
            <p>空欄の項目はアプリの既定値を使います。</p>
            <div class="editor-appearance-fields"></div>
            <label>フォント<input name="fontFamily" placeholder="Hiragino Mincho ProN" autocomplete="off"></label>
            <label>文字サイズ（px）<input name="fontSize" type="number" min="12" max="32" step="1"></label>
            <div class="editor-appearance-sample manuscript-editor" aria-label="プレビュー">
                <div class="cm-activeLine">窓の向こうに、夕暮れが広がる。</div>
                <div>次の一行を<span class="cm-selectionBackground">書き始める</span>。</div>
            </div>
            <p role="alert" hidden></p>
            <div class="actions">
                <button type="button" data-reset>既定に戻す</button>
                <button type="button" data-cancel>キャンセル</button>
                <button type="submit">保存</button>
            </div>
        </form>`;
    const form = dialog.querySelector('form');
    const fields = form.querySelector('.editor-appearance-fields');
    const pickers = new Map();
    for (const [key, label, fallback] of colors) {
        const row = document.createElement('div');
        row.className = 'editor-appearance-color';
        row.innerHTML = `
            <label>${label}<input name="${key}" placeholder="#RRGGBB" pattern="#[0-9a-fA-F]{6}" spellcheck="false" autocomplete="off"></label>
            <input type="color" aria-label="${label}を選ぶ">`;
        const picker = row.querySelector('[type=color]');
        picker.addEventListener('input', () => {
            form.elements[key].value = picker.value;
            update();
        });
        pickers.set(key, { picker, fallback });
        fields.append(row);
    }
    const sample = form.querySelector('.editor-appearance-sample');
    const alert = form.querySelector('[role=alert]');
    let saving = false;
    function update() {
        const draft = {};
        alert.hidden = true;
        for (const key of Object.keys(properties)) {
            const input = form.elements[key];
            const value = input.value.trim();
            if (key === 'fontFamily') {
                input.setCustomValidity(value && !CSS.supports('font-family', value) ? 'フォント名を確認してください' : '');
            }
            if (value && input.validity.valid) draft[key] = key === 'fontSize' ? Number(value) : value;
        }
        for (const [key, { picker, fallback }] of pickers) picker.value = draft[key] ?? fallback;
        applyEditorAppearance(sample, draft);
        preview(draft);
        return draft;
    }
    for (const key of Object.keys(properties)) form.elements[key].value = appearance[key] ?? '';
    form.addEventListener('input', event => {
        if (event.target.type !== 'color') update();
    });
    form.querySelector('[data-reset]').onclick = () => {
        for (const key of Object.keys(properties)) form.elements[key].value = '';
        update();
    };
    form.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); close(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const draft = update();
        if (!form.reportValidity()) return;
        saving = true;
        for (const control of form.elements) control.disabled = true;
        try {
            await save(draft);
            dialog.close();
        } catch (error) {
            alert.textContent = String(error);
            alert.hidden = false;
        } finally {
            saving = false;
            for (const control of form.elements) control.disabled = false;
        }
    });
    document.body.append(dialog);
    dialog.showModal();
    update();
}

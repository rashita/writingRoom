import { markdownLanguage } from './cm-bundle.js';

// Parse on demand so ordinary typing does not pay for an outline rebuild.
export function getHeadings(text) {
    const headings = [];
    markdownLanguage.parser.parse(text).iterate({ enter(node) {
        const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
        if (!match) return;
        const source = text.slice(node.from, node.to);
        const title = node.name.startsWith('ATX')
            ? source.replace(/^#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
            : source.replace(/\n[^\n]*$/, '').trim().replace(/\s*\n\s*/g, ' ');
        headings.push({ from: node.from, end: node.to, level: Number(match[1]), title: title || '（空の見出し）' });
    } });
    return headings;
}

export function currentHeadingRange(text, position) {
    const headings = getHeadings(text);
    const heading = headings.filter(h => h.from <= position).at(-1);
    if (!heading) return null;
    const next = headings.find(h => h.from > heading.from && h.level <= heading.level);
    const from = heading.end;
    const to = next ? Math.max(from, next.from - 1) : text.length;
    if (to <= from || !text.slice(from, to).trim()) return null;
    return { heading: heading.from, from, to };
}

export function currentHeadingIndex(headings, position) {
    let index = 0;
    for (let i = 0; i < headings.length && headings[i].from <= position; i++) index = i;
    return index;
}

export function showHeadingList({ headings, position, onChoose, onClose, title: listTitle = '見出しへ移動', onSwitch, switchLabel = '全体の見出し', selectedIndex }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'heading-dialog';
    dialog.setAttribute('aria-labelledby', 'heading-list-title');
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.id = 'heading-list-title';
    title.textContent = listTitle;
    const close = document.createElement('button');
    close.textContent = '閉じる';
    close.addEventListener('click', () => dialog.close());
    let switched = false;
    header.append(title);
    if (onSwitch) {
        const switchButton = document.createElement('button');
        switchButton.textContent = switchLabel;
        switchButton.addEventListener('click', () => { switched = true; dialog.close(); onSwitch(); });
        header.append(switchButton);
    }
    header.append(close);
    const list = document.createElement('div');
    list.className = 'heading-list';
    let accepted = false;
    let selected = selectedIndex ?? currentHeadingIndex(headings, position);
    const buttons = headings.map((heading, index) => {
        const button = document.createElement('button');
        const startsFile = heading.path && (index === 0 || headings[index - 1].path !== heading.path);
        button.textContent = startsFile ? `${heading.title} — ${heading.path.split('/').at(-1)}` : heading.title;
        button.style.paddingLeft = `${12 + (heading.level - 1) * 16}px`;
        button.setAttribute('aria-label', `見出し${heading.level}：${heading.title}`);
        if (index === selected) button.setAttribute('aria-current', 'location');
        button.addEventListener('focus', () => { selected = index; });
        button.addEventListener('click', () => { accepted = true; dialog.close(); onChoose(heading); });
        return button;
    });
    list.append(...buttons);
    if (!headings.length) list.textContent = '対象の原稿にはMarkdownの見出しがありません。';
    dialog.append(header, list);
    dialog.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.stopPropagation(); return; }
        if (!buttons.includes(document.activeElement)) return;
        let next;
        if (event.key === 'ArrowDown') next = Math.min(selected + 1, buttons.length - 1);
        if (event.key === 'ArrowUp') next = Math.max(selected - 1, 0);
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        buttons[next].focus();
    });
    dialog.addEventListener('close', () => { dialog.remove(); if (!switched) onClose(accepted); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    if (buttons.length) {
        buttons[selected].focus({ preventScroll: true });
        buttons[selected].scrollIntoView({ block: 'nearest' });
    } else close.focus();
    return () => { if (dialog.open) dialog.close(); };
}

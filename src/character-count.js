const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const numberFormat = new Intl.NumberFormat('ja-JP');

export function countCharacters(text) {
    let count = 0;
    for (const { segment } of segmenter.segment(text)) {
        if (!/^[\r\n\u2028\u2029]+$/u.test(segment)) count++;
    }
    return count;
}

export function updateCharacterCount(element, text) {
    element.hidden = text === null;
    element.textContent = text === null ? '' : `${numberFormat.format(countCharacters(text))}文字`;
}

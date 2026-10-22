import { StateEffect, StateField, Decoration, EditorView, WidgetType } from './cm-bundle.js';

export const closeHeading = StateEffect.define();
export const openHeading = StateEffect.define();
class FoldMarker extends WidgetType {
    toDOM(view) {
        const button = document.createElement('button');
        button.className = 'heading-fold-marker';
        button.textContent = '…';
        button.setAttribute('aria-label', '見出しの本文を開く');
        button.addEventListener('click', event => {
            const position = view.posAtDOM(event.currentTarget);
            view.dispatch({ effects: openHeading.of(position) });
            view.focus();
        });
        return button;
    }
}
export const headingFolds = StateField.define({
    create: () => Decoration.none,
    update(folds, transaction) {
        folds = folds.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (effect.is(closeHeading)) {
                const { from, to } = effect.value;
                folds = folds.update({ filter: (a, b) => a !== from || b !== to,
                    add: [Decoration.replace({ widget: new FoldMarker() }).range(from, to)], sort: true });
            }
            if (effect.is(openHeading)) folds = folds.update({ filter: (from, to) => effect.value < from || effect.value > to });
        }
        if (transaction.selection) {
            const head = transaction.newSelection.main.head;
            folds = folds.update({ filter: (from, to) => head <= from || head >= to });
        }
        return folds;
    },
    provide: field => EditorView.decorations.from(field)
});

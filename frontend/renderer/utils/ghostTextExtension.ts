import {
  StateField,
  StateEffect,
} from '@codemirror/state';
import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  keymap,
} from '@codemirror/view';

// Effects to set/clear ghost text
export const setGhostText = StateEffect.define<{ text: string; pos: number }>();
export const clearGhostText = StateEffect.define<void>();

// Ghost text widget
class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.textContent = this.text;
    span.style.opacity = '0.4';
    span.style.color = '#9ca3af';
    span.style.fontStyle = 'italic';
    span.style.pointerEvents = 'none';
    span.className = 'cm-ghost-text';
    return span;
  }

  eq(other: GhostTextWidget) {
    return this.text === other.text;
  }

  ignoreEvent() {
    return true;
  }
}

// State field to track ghost text
interface GhostTextState {
  text: string;
  pos: number;
}

const ghostTextField = StateField.define<GhostTextState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    // Clear on any document change (user typed something)
    if (tr.docChanged) {
      return null;
    }

    for (const effect of tr.effects) {
      if (effect.is(setGhostText)) {
        return effect.value;
      }
      if (effect.is(clearGhostText)) {
        return null;
      }
    }

    return value;
  },
});

// Decoration plugin that reads the state field and shows the widget
const ghostTextDecorations = EditorView.decorations.compute(
  [ghostTextField],
  (state) => {
    const ghost = state.field(ghostTextField);
    if (!ghost || !ghost.text) return Decoration.none;

    // Ensure position is valid
    if (ghost.pos < 0 || ghost.pos > state.doc.length) return Decoration.none;

    const widget = Decoration.widget({
      widget: new GhostTextWidget(ghost.text),
      side: 1, // after the cursor
    });

    return Decoration.set([widget.range(ghost.pos)]);
  }
);

// Keymap: Tab accepts ghost text, Escape clears it
const ghostTextKeymap = keymap.of([
  {
    key: 'Tab',
    run(view) {
      const ghost = view.state.field(ghostTextField);
      if (!ghost || !ghost.text) return false;

      // Insert the ghost text at the position
      view.dispatch({
        changes: { from: ghost.pos, insert: ghost.text },
        selection: { anchor: ghost.pos + ghost.text.length },
        effects: clearGhostText.of(undefined),
      });
      return true;
    },
  },
  {
    key: 'Escape',
    run(view) {
      const ghost = view.state.field(ghostTextField);
      if (!ghost) return false;

      view.dispatch({
        effects: clearGhostText.of(undefined),
      });
      return true;
    },
  },
]);

// Export the complete extension bundle
export function ghostTextExtension() {
  return [ghostTextField, ghostTextDecorations, ghostTextKeymap];
}

// Helper: set ghost text on an editor view
export function showGhostText(view: EditorView, text: string, pos: number) {
  view.dispatch({
    effects: setGhostText.of({ text, pos }),
  });
}

// Helper: clear ghost text
export function hideGhostText(view: EditorView) {
  view.dispatch({
    effects: clearGhostText.of(undefined),
  });
}

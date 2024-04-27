import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { MinorMode, ModeState, ModeType } from "./entities";

export const modeEffect = StateEffect.define<ModeState>();

export const modeField = StateField.define<ModeState>({
  create() {
    return { type: ModeType.Normal, minor: MinorMode.Normal };
  },
  update(mode, tr) {
    for (const effect of tr.effects) {
      if (effect.is(modeEffect)) {
        mode = effect.value;
      }
    }

    return mode;
  },
});

export const yankEffect = StateEffect.define<string | Text>();

export const registerField = StateField.define<string | Text>({
  create() {
    return "";
  },
  update(register, tr) {
    for (const effect of tr.effects) {
      if (effect.is(yankEffect)) {
        register = effect.value;
      }
    }

    return register;
  },
});

export type SearchRegister = {
  active: SearchQuery | null;
  original?: EditorSelection;
};

export const searchRegisterField = StateField.define<SearchRegister>({
  create() {
    return { active: null };
  },

  update(search, tr) {
    for (const effect of tr.effects) {
      if (effect.is(searchEffect)) {
        const effectValue = effect.value;

        switch (effectValue.type) {
          case SearchEffKind.Start: {
            search = { ...search, original: effectValue.selection };

            break;
          }
          case SearchEffKind.Exit: {
            search = {
              original: undefined,
              active: effectValue.query ?? search.active,
            };

            break;
          }
        }
      }
    }

    return search;
  },
});

export const enum SearchEffKind {
  Start,
  Exit,
}

export const searchEffect = StateEffect.define<
  | {
      type: SearchEffKind.Start;
      selection: EditorSelection;
    }
  | {
      type: SearchEffKind.Exit;
      query?: SearchQuery;
    }
>();

type HistoryEffect =
  | {
      type: "move";
      offset: 1 | -1;
      head?: EditorState;
    }
  | {
      type: "add";
      state: EditorState;
      temp?: boolean;
    }
  | {
      type: "commit";
      state: EditorState;
    };

export const historyEffect = StateEffect.define<HistoryEffect>();

export const historyField = StateField.define<{
  checkpoints: EditorState[];
  cursor: number;
  pending: EditorState | null;
  head: EditorState | null;
}>({
  create() {
    return { checkpoints: [], cursor: -1, pending: null, head: null };
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(historyEffect)) {
        const effectValue = effect.value;
        switch (effectValue.type) {
          case "move": {
            const cursor = value.cursor + effectValue.offset;

            value = {
              checkpoints: value.checkpoints,
              pending: null,
              cursor,
              head: value.head ?? effectValue.head ?? null,
            };

            break;
          }
          case "add": {
            if (process.env.NODE_ENV === "development") {
              if (value.pending && effectValue.temp) {
                throw new Error("Unexpected temp");
              }
            }

            const checkpoints =
              value.cursor === -1
                ? value.checkpoints
                : value.checkpoints.slice(value.cursor + 1);

            value = effectValue.temp
              ? {
                  checkpoints: value.checkpoints,
                  cursor: value.cursor,
                  pending: effectValue.state,
                  head: value.head,
                }
              : {
                  checkpoints: [effectValue.state, ...checkpoints],
                  cursor: -1,
                  pending: null,
                  head: null,
                };

            break;
          }
          case "commit": {
            if (process.env.NODE_ENV === "development") {
              if (!value.pending) {
                throw new Error("unexpected commit");
              }
            }

            if (effectValue.state.doc.eq(value.pending!.doc)) {
              value = {
                ...value,
                pending: null,
              };

              break;
            }

            const checkpoints =
              value.cursor === -1
                ? value.checkpoints
                : value.checkpoints.slice(value.cursor + 1);

            value = {
              checkpoints: [value.pending!, ...checkpoints],
              cursor: -1,
              pending: null,
              head: null,
            };
            break;
          }
        }
      }
    }

    return value;
  },
});

import {
  Compartment,
  EditorSelection,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  Text,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { MinorMode, ModeState, ModeType, NonInsertMode } from "./entities";
import { pathRegister } from "./lib";

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

export function resetMode(
  mode: NonInsertMode,
  override?: Partial<NonInsertMode>
) {
  return modeEffect.of({ type: mode.type, minor: mode.minor, ...override });
}

export function overwriteMode(
  mode: NonInsertMode,
  override?: Partial<NonInsertMode>
) {
  return modeEffect.of({ ...mode, ...override });
}

export function sameMode(mode: ModeState, otherMode: ModeState) {
  return (
    mode.type === otherMode.type &&
    (mode as any).minor === (otherMode as any).minor
  );
}

export function sameModeState(mode: ModeState, otherMode: ModeState) {
  return (
    sameMode(mode, otherMode) &&
    (mode as any).count === (otherMode as any).count &&
    (mode as any).register === (otherMode as any).register &&
    (mode as any).expecting === (otherMode as any).expecting
  );
}

export function modeStatus(mode: ModeState) {
  let result = "";

  if (mode.type !== ModeType.Insert) {
    if (mode.count) {
      result += mode.count;
    }

    result += minorModeStr(mode.minor);
  }

  if (mode.expecting) {
    result += mode.expecting.minor;
  }

  return result;
}

function minorModeStr(minor: MinorMode) {
  switch (minor) {
    case MinorMode.Normal:
      return "";
    case MinorMode.Goto:
      return "g";
    case MinorMode.Match:
      return "m";
    case MinorMode.Space:
      return "<space>";
    case MinorMode.LeftBracket:
      return "[";
    case MinorMode.RightBracket:
      return "]";
    default: {
      if (process.env.NODE_ENV === "development") {
        throw new Error("Unexpected mode");
      }
    }
  }
}

export const yankEffect = StateEffect.define<
  | [string, Array<string | Text>]
  | {
      reset: {
        values: Record<string, Array<string | Text>>;
        history: Record<string, Array<string | Text>>;
      };
    }
>();

// FIXME: handle '+'
export function readRegister(state: EditorState, register?: string) {
  switch (register) {
    case "#": {
      return state.selection.ranges.map((_, i) => String(i + 1));
    }
    case "_": {
      return [];
    }
    case ".": {
      return state.selection.ranges.map((range) =>
        state.sliceDoc(range.from, range.to)
      );
    }
    case "%": {
      const path = state.facet(pathRegister);

      return path != null ? [path] : [];
    }
    default: {
      return state.field(registersField)[register ?? `"`] as
        | Array<string | Text>
        | undefined;
    }
  }
}

export async function readClipboard(state: EditorState) {
  const yanked = readRegister(state, "+");

  const copied = await navigator.clipboard.readText();

  if (yanked?.map((yank) => yank.toString()).join("\n") === copied) {
    return yanked;
  }

  return [copied];
}

export const registersField = StateField.define<
  Record<string, Array<string | Text>>
>({
  create() {
    return {};
  },
  update(registers, tr) {
    for (const effect of tr.effects) {
      if (effect.is(yankEffect)) {
        if (!Array.isArray(effect.value)) {
          registers = effect.value.reset.values;

          if (process.env.NODE_ENV === "development") {
            const regs = new Set(Object.keys(registers));

            if (["_", "%", ".", "#"].some((reg) => regs.has(reg))) {
              console.error(`unexpected read-only register`);
            }
          }

          continue;
        }

        const [reg] = effect.value;
        let [, value] = effect.value;

        switch (reg) {
          case "_":
          case "%":
          case ".":
          case "#": {
            return registers;
          }

          case ":": {
            value = value.length ? [value[0]] : [];

            break;
          }
          case "+": {
            navigator.clipboard.writeText(
              // FIXME: proper line ending?
              value.map((yank) => yank.toString()).join("\n")
            );

            break;
          }
        }

        if (value.length === 0) {
          const { [reg]: _reg, ...rest } = registers;

          registers = rest;
        } else {
          registers = { ...registers, [reg]: value };
        }
      }
    }

    return registers;
  },
});

export const registersHistoryField = StateField.define<
  Record<string, Array<string | Text>>
>({
  create() {
    return {};
  },
  update(registers, tr) {
    for (const effect of tr.effects) {
      if (effect.is(yankEffect)) {
        if (!Array.isArray(effect.value)) {
          registers = effect.value.reset.history;
          continue;
        }

        const [reg] = effect.value;
        let [, value] = effect.value;

        switch (reg) {
          case ":": {
            value = value.length ? [value[0]] : [];

            break;
          }
          case "/": {
            break;
          }

          default: {
            continue;
          }
        }

        if (value.length === 0) {
          continue;
        }

        const { [reg]: current, ...rest } = registers;

        registers = {
          [reg]: [...(current ?? []), value[0]],
          ...rest,
        };
      }
    }

    return registers;
  },
});

type HistoryEffect =
  | {
      type: "move";
      offset: number;
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

export const syntaxHistoryEffect = StateEffect.define<
  | {
      type: "add";
      prev: EditorSelection;
      next: EditorSelection;
    }
  | {
      type: "move";
      offset: 1 | -1;
    }
  | {
      type: "reset";
    }
  | {
      type: "freeze";
      frozen?: boolean;
    }
>();

export const syntaxHistoryField = StateField.define<
  {
    cursor: number;
    frozen: boolean;
  } & (
    | {
        selections: [];
        head: null;
      }
    | {
        selections: [EditorSelection, ...EditorSelection[]];
        head: EditorSelection;
      }
  )
>({
  create() {
    return { selections: [], cursor: 0, head: null, frozen: false };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(syntaxHistoryEffect)) {
        switch (effect.value.type) {
          case "freeze": {
            value = { ...value, frozen: effect.value.frozen ?? true };
            break;
          }
          case "add": {
            value = {
              selections: [...value.selections, effect.value.prev],
              cursor: value.cursor + 1,
              head: effect.value.next,
              frozen: false,
            };
            break;
          }
          case "move": {
            value = {
              ...value,
              cursor: value.cursor + effect.value.offset,
            };
            break;
          }
          case "reset": {
            if (!value.frozen) {
              value = {
                frozen: false,
                selections: [],
                cursor: 0,
                head: null,
              };
            }
          }
        }
      }
    }

    return value;
  },
});

export function expandSyntaxHistory(
  state: EditorState,
  expand: (start: TransactionSpec, callback: (tr: Transaction) => void) => void,
  done: (spec: TransactionSpec) => void
) {
  const history = state.field(syntaxHistoryField);

  if (history.cursor < history.selections.length) {
    done({
      selection:
        history.cursor === history.selections.length - 1
          ? history.head!
          : history.selections[history.cursor + 1],
      effects: syntaxHistoryEffect.of({ type: "move", offset: +1 }),
    });

    return;
  }

  expand(
    {
      effects: syntaxHistoryEffect.of({ type: "freeze" }),
    },
    (tr) => {
      done(
        tr.selection?.eq(state.selection)
          ? {
              effects: syntaxHistoryEffect.of({
                type: "freeze",
                frozen: false,
              }),
            }
          : {
              selection: tr.selection,
              changes: tr.changes,
              scrollIntoView: tr.scrollIntoView,
              effects: [
                ...tr.effects,
                syntaxHistoryEffect.of({
                  type: "add",
                  prev: state.selection,
                  next: tr.newSelection,
                }),
              ],
            }
      );
    }
  );
}

export function undoSyntaxHistory(state: EditorState) {
  const history = state.field(syntaxHistoryField);

  if (history.cursor > 0) {
    return {
      selection: history.selections[history.cursor - 1],
      effects: syntaxHistoryEffect.of({ type: "move", offset: -1 }),
    };
  }
}

export const themeCompartment = new Compartment();
export const themeEffect = StateEffect.define<string>();
export const themeField = StateField.define<{
  current: string;
  themes: Array<{ name: string; dark?: boolean; extension: Extension }>;
}>({
  create() {
    return {} as any;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(themeEffect)) {
        value = { ...value, current: effect.value };
      }
    }

    return value;
  },
});

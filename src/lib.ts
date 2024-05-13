import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorLineBoundaryRight,
  cursorLineDown,
  cursorLineStart,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
  deleteCharBackward,
  deleteCharForward,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  selectAll,
  selectCharLeft,
  selectCharRight,
  selectDocEnd,
  selectDocStart,
  selectGroupLeft,
  selectGroupRight,
  selectLineBoundaryRight,
  selectLineDown,
  selectLineStart,
  selectLineUp,
  selectPageDown,
  selectPageUp,
  selectParentSyntax,
  toggleComment,
} from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Extension,
  SelectionRange,
  StateField,
  Text,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  KeyBinding,
  Panel,
  WidgetType,
  drawSelection,
  getPanel,
  keymap,
  showPanel,
} from "@codemirror/view";
import {
  SearchQuery,
  getSearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { matchBrackets, syntaxTree } from "@codemirror/language";

import { MinorMode, ModeState, ModeType } from "./entities";
import {
  SearchEffKind,
  historyEffect,
  historyField,
  modeEffect,
  modeField,
  registerField,
  searchEffect,
  searchRegisterField,
  yankEffect,
} from "./state";
import type { SyntaxNode } from "@lezer/common";

const MODE_EFF = {
  NORMAL: modeEffect.of({
    type: ModeType.Normal,
    minor: MinorMode.Normal,
  }),
  NORMAL_GOTO: modeEffect.of({
    type: ModeType.Normal,
    minor: MinorMode.Goto,
  }),
  NORMAL_MATCH: modeEffect.of({
    type: ModeType.Normal,
    minor: MinorMode.Match,
  }),
  SELECT: modeEffect.of({
    type: ModeType.Select,
    minor: MinorMode.Normal,
  }),
  SELECT_GOTO: modeEffect.of({
    type: ModeType.Select,
    minor: MinorMode.Goto,
  }),
  SELECT_MATCH: modeEffect.of({
    type: ModeType.Select,
    minor: MinorMode.Match,
  }),
  INSERT: modeEffect.of({ type: ModeType.Insert }),
};

function moveDown(view: EditorView, mode: NonInsertMode) {
  mode.type === ModeType.Normal ? cursorLineDown(view) : selectLineDown(view);
}

function moveUp(view: EditorView, mode: NonInsertMode) {
  mode.type === ModeType.Normal ? cursorLineUp(view) : selectLineUp(view);
}

function moveLeft(view: EditorView, mode: NonInsertMode) {
  mode.type === ModeType.Normal ? cursorCharLeft(view) : selectCharLeft(view);
}

function moveRight(view: EditorView, mode: NonInsertMode) {
  mode.type === ModeType.Normal ? cursorCharRight(view) : selectCharRight(view);
}

function addSearch(view: EditorView, query: SearchQuery) {
  const searchRegister = view.state.field(searchRegisterField);
  const match = query
    .getCursor(
      view.state,
      (searchRegister.original ?? view.state.selection).main.to
    )
    .next();

  if (!match.done) {
    view.dispatch({
      selection: EditorSelection.range(match.value.from, match.value.to),
      scrollIntoView: true,
    });
  } else {
    view.dispatch({
      selection: searchRegister.original!,
      scrollIntoView: true,
    });
  }
}

type NonInsertMode = Exclude<
  ModeState,
  {
    type: ModeType.Insert;
  }
>;

type NormalLikeMode = NonInsertMode & { minor: MinorMode.Normal };

type SimpleCommand<M> = (
  view: EditorView,
  mode: M
) => boolean | undefined | void;

type ViewProxy = {
  dispatch(tr: TransactionSpec): void;
  dispatch(...tr: TransactionSpec[]): void;
  original: EditorView;
  state: EditorState;
};

type CheckpointCommand<M> = (
  view: ViewProxy,
  mode: M
) => boolean | undefined | void;
type CheckpointCommandDef<M> = {
  checkpoint: true | "temp";
  command: CheckpointCommand<M>;
};

type ExplicitCommandDef<M> = SimpleCommand<M> | CheckpointCommandDef<M>;
type CommandDef<M> = ExplicitCommandDef<M> | string;

const helixCommandBindings: {
  insert: Record<string, SimpleCommand<undefined>>;
  normal: Record<string, CommandDef<NormalLikeMode>>;
  goto: Record<string, CommandDef<NonInsertMode>>;
  match: Record<string, CommandDef<NonInsertMode>>;
} = {
  insert: {
    Backspace(view) {
      deleteCharBackward(view);
    },
    Delete(view) {
      deleteCharForward(view);
    },
    Enter(view) {
      insertNewlineAndIndent(view);
    },
    Escape(view) {
      view.dispatch({
        effects: [
          MODE_EFF.NORMAL,
          historyEffect.of({ type: "commit", state: view.state }),
        ],
      });
    },
  },
  normal: {
    // this one is special: we let it apply to all other minor modes
    Escape(view, mode_) {
      const mode = mode_ as NonInsertMode;

      if (
        mode.type === ModeType.Normal &&
        mode.minor === MinorMode.Normal &&
        mode.expecting == null
      ) {
        return true;
      }

      view.dispatch({
        effects: [MODE_EFF.NORMAL],
      });

      if (mode.expecting) {
        const panel = getPanel(view, commandPanel) as CommandPanel;
        panel.showCommand(null);
      }
    },
    ["/"](view) {
      view.dispatch({
        effects: searchEffect.of({
          type: SearchEffKind.Start,
          selection: view.state.selection,
        }),
      });

      // openSearchPanel(view);
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });

      const panel = getPanel(view, commandPanel) as CommandPanel | null;

      panel?.showSearchInput();
    },
    ["y"](view) {
      const selection = view.state.selection.main;
      const range = helixSelection(selection, view.state.doc);

      view.dispatch({
        effects: yankEffect.of(view.state.doc.slice(range.from, range.to)),
      });
    },
    ["a"]: {
      checkpoint: "temp",
      command(view) {
        // TODO: extend selection
        const selection = view.state.selection.main;

        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: EditorSelection.cursor(selection.to),
        });
      },
    },
    ["A"]: {
      checkpoint: "temp",
      command(view) {
        const selection = view.state.selection.main;
        const end = view.state.doc.lineAt(selection.to).to;

        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: EditorSelection.cursor(end),
        });
      },
    },
    ["c"]: {
      checkpoint: "temp",
      command(view) {
        const selection = view.state.selection.main;
        const range = helixSelection(selection, view.state.doc);

        view.dispatch({
          effects: [
            yankEffect.of(view.state.doc.slice(range.from, range.to)),
            MODE_EFF.INSERT,
          ],
          changes: {
            from: range.from,
            to: range.to,
            insert: "",
          },
        });
      },
    },
    ["d"]: {
      checkpoint: true,
      command(view) {
        const selection = view.state.selection.main;

        const range = helixSelection(selection, view.state.doc);

        view.dispatch({
          effects: [
            yankEffect.of(view.state.doc.slice(range.from, range.to)),
            MODE_EFF.NORMAL,
          ],
          changes: {
            from: range.from,
            to: range.to,
          },
        });
      },
    },
    ["P"]: {
      checkpoint: true,
      command(view) {
        const range = view.state.selection.main;
        const yanked = view.state.field(registerField);

        const spec = { from: range.from, insert: yanked };

        const change = view.state.changes(spec);

        view.dispatch(
          { changes: change },
          {
            selection: { anchor: range.from, head: range.from + yanked.length },
            sequential: true,
          },
          { effects: MODE_EFF.NORMAL }
        );
      },
    },
    ["p"]: {
      checkpoint: true,
      command(view) {
        const range = view.state.selection.main;
        const yanked = view.state.field(registerField);

        const spec = { from: range.to, insert: yanked };

        const change = view.state.changes(spec);

        view.dispatch(
          { changes: change },
          {
            selection: { anchor: range.to, head: range.to + yanked.length },
            sequential: true,
          },
          { effects: MODE_EFF.NORMAL }
        );
      },
    },
    ["R"]: {
      checkpoint: true,
      command(view) {
        const tr = view.state.replaceSelection(view.state.field(registerField));
        tr.effects = MODE_EFF.NORMAL;

        view.dispatch(tr);
      },
    },
    ["w"](view, mode) {
      if (mode.type === ModeType.Normal) {
        const current = view.state.selection.main;

        view.dispatch({
          selection: EditorSelection.single(Math.max(current.from, current.to)),
        });
      }

      return selectGroupRight(view);
    },
    ["b"](view, mode) {
      if (mode.type === ModeType.Normal) {
        const current = view.state.selection.main;
        view.dispatch({
          selection: EditorSelection.single(Math.min(current.from, current.to)),
        });
      }

      return selectGroupLeft(view);
    },
    ["v"](view, mode) {
      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.SELECT : MODE_EFF.NORMAL,
      });
    },
    ["g"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL_GOTO : MODE_EFF.SELECT_GOTO,
      });
    },
    ["m"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL_MATCH : MODE_EFF.SELECT_MATCH,
      });
    },
    ["i"]: {
      checkpoint: "temp",
      command(view) {
        const selection = view.state.selection.main;
        const cursor = Math.min(selection.from, selection.to);

        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: EditorSelection.cursor(cursor),
        });
      },
    },
    ["h"](view, mode) {
      return moveLeft(view, mode);
    },
    ["j"]: moveDown,
    ["ArrowDown"]: "j",
    ["ArrowUp"]: "k",
    ["k"]: moveUp,
    ["ArrowRight"]: "l",
    ["ArrowLeft"]: "h",
    ["l"](view, mode) {
      return moveRight(view, mode);
    },
    ["%"](view) {
      return selectAll(view);
    },
    ["o"]: {
      checkpoint: "temp",
      command(view) {
        insertLineAndEdit(view, true);
      },
    },
    ["O"]: {
      checkpoint: "temp",
      command(view) {
        insertLineAndEdit(view, false);
      },
    },
    ["f"](view, mode) {
      setFindMode(view, "f", mode, {
        inclusive: true,
        reverse: false,
      });
    },
    ["F"](view, mode) {
      setFindMode(view, "F", mode, {
        inclusive: true,
        reverse: true,
      });
    },
    ["t"](view, mode) {
      setFindMode(view, "t", mode, {
        inclusive: false,
        reverse: false,
      });
    },
    ["T"](view, mode) {
      setFindMode(view, "T", mode, {
        inclusive: false,
        reverse: true,
      });
    },
    ["u"](view) {
      const { checkpoints, cursor } = view.state.field(historyField);

      const nextCursor = cursor + 1;

      const state = checkpoints[nextCursor];

      if (!state) {
        return true;
      }

      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: state.doc,
        },
        selection: state.selection,
        effects: historyEffect.of({
          type: "move",
          offset: 1,
          head: view.state,
        }),
        scrollIntoView: true,
      });
    },
    ["U"](view) {
      const { checkpoints, cursor, head } = view.state.field(historyField);

      const nextCursor = cursor - 1;

      const state = nextCursor === -1 ? head : checkpoints[nextCursor];

      if (!state) {
        return true;
      }

      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: state.doc,
        },
        selection: state.selection,
        effects: historyEffect.of({
          type: "move",
          offset: -1,
        }),
        scrollIntoView: true,
      });
    },
    ["x"](view) {
      const initial = view.state.selection.main;

      const anchorLine = view.state.doc.lineAt(initial.anchor);
      const headLine = view.state.doc.lineAt(initial.head);
      const [startLine, endLine] =
        anchorLine.number < headLine.number
          ? [anchorLine, headLine]
          : [headLine, anchorLine];
      const ideal = EditorSelection.range(startLine.from, endLine.to);

      let nextSel: SelectionRange;

      if (
        ideal.from === initial.from &&
        ideal.to === initial.to &&
        view.state.doc.lines > endLine.number
      ) {
        const nextLine = view.state.doc.line(endLine.number + 1);
        nextSel = EditorSelection.range(startLine.from, nextLine.to);
      } else {
        nextSel = EditorSelection.range(startLine.from, endLine.to);
      }

      view.dispatch({
        selection: nextSel,
      });

      return true;
    },
    ["n"](view) {
      const register = view.state.field(searchRegisterField);

      const active = register.active;

      if (!active?.valid) {
        return true;
      }

      const cursor = active.getCursor(view.state, view.state.selection.main.to);

      let match = cursor.next();

      if (match.done) {
        match = active.getCursor(view.state).next();
      }

      if (!match.done) {
        view.dispatch({
          selection: EditorSelection.range(match.value.from, match.value.to),
          scrollIntoView: true,
        });
      }
    },
    ["N"](view) {
      const register = view.state.field(searchRegisterField);

      const active = register.active;

      if (!active?.valid) {
        return true;
      }

      const cursor = active.getCursor(view.state);
      const selection = view.state.selection.main;

      let match: { from: number; to: number } | undefined;
      let before = false;

      for (const item of {
        [Symbol.iterator]() {
          return cursor;
        },
      }) {
        if (item.to < selection.from) {
          match = item;
          before = true;
        } else if (item.from > selection.to) {
          if (before) {
            break;
          } else {
            match = item;
          }
        }
      }

      if (match) {
        view.dispatch({
          selection: EditorSelection.range(match.from, match.to),
          scrollIntoView: true,
        });
      }
    },
    ["Ctrl-d"](view, mode) {
      mode.type === ModeType.Normal
        ? cursorPageDown(view)
        : selectPageDown(view);
    },
    ["PageDown"](view, mode) {
      mode.type === ModeType.Normal
        ? cursorPageDown(view)
        : selectPageDown(view);
    },
    ["PageUp"](view, mode) {
      mode.type === ModeType.Normal ? cursorPageUp(view) : selectPageUp(view);
    },
    ["Ctrl-u"](view, mode) {
      mode.type === ModeType.Normal ? cursorPageUp(view) : selectPageUp(view);
    },
    [";"](view) {
      const selection = view.state.selection.main;

      view.dispatch({
        selection: EditorSelection.cursor(selection.head),
      });
    },
    ["Alt-;"](view) {
      const selection = view.state.selection.main;

      view.dispatch({
        selection: EditorSelection.range(selection.head, selection.anchor),
      });
    },
    ["Alt-ArrowUp"](view) {
      return selectParentSyntax(view);
    },
    ["Alt-o"]: "Alt-ArrowUp",
    ["Alt-ArrowRight"](view) {
      moveToSibling(view, true);
    },
    ["Alt-n"]: "Alt-ArrowRight",
    ["Alt-ArrowLeft"](view) {
      moveToSibling(view, false);
    },
    ["Alt-p"]: "Alt-ArrowLeft",
    ["Ctrl-c"]: {
      checkpoint: true,
      command(view) {
        toggleComment(view);

        view.original.dispatch({
          effects: MODE_EFF.NORMAL,
        });
      },
    },
    [">"]: {
      checkpoint: true,
      command(view) {
        return indentMore(view);
      },
    },
    ["<"]: {
      checkpoint: true,
      command(view) {
        return indentLess(view);
      },
    },
  },
  goto: {
    ["g"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      isNormal ? cursorDocStart(view) : selectDocStart(view);

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["e"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      isNormal ? cursorDocEnd(view) : selectDocEnd(view);

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["h"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      isNormal ? cursorLineStart(view) : selectLineStart(view);

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    j: moveDown,
    k: moveUp,
    ["l"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      isNormal ? cursorLineBoundaryRight(view) : selectLineBoundaryRight(view);

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
  },
  match: {
    ["s"]: {
      checkpoint: true,
      command(view, mode) {
        view.dispatch({
          effects: modeEffect.of({
            type: mode.type,
            minor: MinorMode.Match,
            expecting: {
              callback: surround,
              metadata: view,
            },
          }),
        });
      },
    },
    ["m"](view, mode) {
      const selection = matchBracket(view) ?? undefined;

      const isNormal = mode.type === ModeType.Normal;

      view.dispatch({
        selection:
          selection?.from == null
            ? undefined
            : isNormal
            ? EditorSelection.cursor(selection.from)
            : EditorSelection.range(
                view.state.selection.main.anchor,
                selection.from
              ),
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
        scrollIntoView: true,
      });
    },
  },
};

function setFindMode(
  view: EditorView,
  status: string,
  mode: NormalLikeMode,
  metadata: { inclusive: boolean; reverse: boolean }
) {
  const effect = modeEffect.of({
    type: mode.type,
    minor: MinorMode.Normal,
    expecting: {
      callback: findText,
      metadata,
    },
  });

  const panel = getPanel(view, commandPanel) as CommandPanel;
  panel.showCommand(status);

  view.dispatch({ effects: effect });
}

// TODO: fix selection ranges
function helixSelection(range: SelectionRange, doc: Text) {
  const to = Math.min(range.to + 1, doc.length);

  const forward = range.head >= range.anchor;

  const anchor = forward ? range.anchor : to;
  const head = forward ? to : range.head;

  return EditorSelection.range(anchor, head);
}

// function codemirrorSelection(range: SelectionRange) {
//   if (range.from === range.to) {
//     return range;
//   }

//   const forward = range.from === range.anchor;

//   return forward
//     ? EditorSelection.range(range.anchor, range.head - 1)
//     : EditorSelection.range(range.anchor - 1, range.head);
// }

function moveToSibling(view: EditorView, forward: boolean) {
  const tree = syntaxTree(view.state);

  const selection = view.state.selection.main;
  let stack = tree.resolveStack(selection.from, 1);

  let sibling: SyntaxNode | null = null;

  while (true) {
    const node = stack.node;

    if (node && node.from <= selection.from && node.to >= selection.to) {
      sibling = forward ? node?.nextSibling : node?.prevSibling;

      if (sibling) {
        break;
      }
    }

    if (stack.next) {
      stack = stack.next;
    } else {
      break;
    }
  }

  if (!sibling) {
    view.dispatch({
      selection: EditorSelection.range(0, view.state.doc.length),
      scrollIntoView: true,
    });

    return;
  }

  view.dispatch({
    selection: EditorSelection.range(sibling.from, sibling.to),
    scrollIntoView: true,
  });
}

function insertLineAndEdit(view: ViewProxy, below: boolean) {
  let from: number;
  let cursor: number;

  if (below) {
    const line = view.state.doc.lineAt(view.state.selection.main.to);

    from = line.to;
    cursor = from + 1;
  } else {
    const line = view.state.doc.lineAt(view.state.selection.main.from);

    from = line.from;
    cursor = from;
  }

  view.dispatch({
    changes: {
      from,
      insert: "\n",
    },
    selection: EditorSelection.cursor(cursor),
    effects: MODE_EFF.INSERT,
  });
}

function toCodemirrorKeymap(keybindings: typeof helixCommandBindings) {
  const allKeys = [
    ...new Set(
      Object.values(keybindings)
        .flat()
        .flatMap((binding) => Object.keys(binding))
    ),
  ];

  function apply<M>(def: ExplicitCommandDef<M>, view: EditorView, mode: M) {
    if (typeof def === "function") {
      return def(view, mode);
    } else {
      const temp = def.checkpoint === "temp";

      return def.command(
        {
          original: view,
          dispatch(...args: any[]) {
            view.dispatch(
              {
                effects: historyEffect.of({
                  type: "add",
                  state: view.state,
                  temp,
                }),
              },
              ...args
            );
          },
          get state() {
            return view.state;
          },
        },
        mode
      );
    }
  }

  function getExplicitCommand<M>(
    key: string,
    bindings: Record<string, CommandDef<M>>
  ) {
    while (true) {
      const binding = bindings[key];

      if (typeof binding === "string") {
        key = binding;

        continue;
      }

      return binding;
    }
  }

  const codemirrorKeybindings: KeyBinding[] = [];

  for (const key of allKeys) {
    const insertCommand = getExplicitCommand(key, keybindings.insert) as
      | SimpleCommand<undefined>
      | undefined;
    const normalCommand = getExplicitCommand(key, keybindings.normal) as
      | ExplicitCommandDef<NormalLikeMode>
      | undefined;
    const gotoCommand = getExplicitCommand(key, keybindings.goto) as
      | ExplicitCommandDef<NonInsertMode>
      | undefined;
    const matchCommand = getExplicitCommand(key, keybindings.match) as
      | ExplicitCommandDef<NonInsertMode>
      | undefined;

    const esc = key === "Escape";
    const isChar = key.length === 1;

    const command = (view: EditorView) => {
      const mode = view.state.field(modeField);

      if (mode.type === ModeType.Insert) {
        if (insertCommand) {
          return insertCommand(view, undefined) ?? true;
        } else {
          return false;
        }
      }

      if (mode.expecting && isChar) {
        return false;
      }

      let result: boolean | void | undefined;

      if (esc || (mode.minor === MinorMode.Normal && normalCommand)) {
        result = apply(normalCommand!, view, mode as any);
      } else if (mode.minor === MinorMode.Goto && gotoCommand) {
        result = apply(gotoCommand, view, mode);
      } else if (mode.minor === MinorMode.Match && matchCommand) {
        result = apply(matchCommand, view, mode);
      } else {
        return false;
      }

      return result ?? true;
    };

    codemirrorKeybindings.push({
      key,
      run: command,
    });
  }

  return codemirrorKeybindings;
}

class EndLineCursor extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.classList.add("cm-hx-cursor");
    span.classList.add("cm-hx-cursor-endline");
    span.textContent = " ";
    return span;
  }
}

const cursorMark = Decoration.mark({ class: "cm-hx-cursor" });
const endlineCursorWidget = Decoration.widget({ widget: new EndLineCursor() });

const cursorField = StateField.define<DecorationSet>({
  create(state) {
    return drawCursorMark(state.selection, state.doc);
  },

  update(_value, tr) {
    return drawCursorMark(tr.newSelection, tr.newDoc);
  },

  provide(field) {
    return EditorView.decorations.from(field);
  },
});

function drawCursorMark(selection: EditorSelection, doc: Text) {
  const head = selection.main.head;
  const line = doc.lineAt(head);

  if (line.to === head) {
    return Decoration.set(
      endlineCursorWidget.range(selection.main.head, selection.main.head)
    );
  } else {
    return Decoration.set(
      cursorMark.range(selection.main.head, selection.main.head + 1)
    );
  }
}

function letThrough(tr: Transaction) {
  return tr;
}

const changeFilter = EditorState.transactionFilter.from(modeField, (mode) =>
  mode.type === ModeType.Insert
    ? letThrough
    : (tr) => {
        const userEvent = tr.annotation(Transaction.userEvent);

        if (userEvent == null) {
          return tr;
        }

        if (!userEvent.startsWith("input")) {
          return tr;
        }

        // WARNING: coupling to internals
        if (userEvent === "input.type.compose.start") {
          return [];
        }

        if (!userEvent.startsWith("input.type")) {
          return tr;
        }

        if (mode.minor !== MinorMode.Normal) {
          return {
            effects:
              mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
          };
        }

        return [];
      }
);

// TODO: this trick doesn't work with compositing. We have to
// bite the bullet and let an external source of input take care of this.
const inputHandler = EditorView.inputHandler.from(
  modeField,
  (mode) => (view, _from, _to, text) => {
    if (mode.type === ModeType.Insert) {
      return false;
    }

    if (mode.expecting) {
      mode.expecting.callback(view, text, mode.expecting.metadata);
      return true;
    }

    return false;
  }
);

const updateListener = EditorView.updateListener.of((viewUpdate) => {
  const { state, startState } = viewUpdate;

  const panel = getPanel(viewUpdate.view, statusPanel) as ReturnType<
    typeof statusPanel
  >;

  const mode = state.field(modeField);
  const startMode = startState.field(modeField);

  if (mode !== startMode) {
    const startExternalMode = toExternalMode(startMode);
    const externalMode = toExternalMode(mode);

    if (startExternalMode !== externalMode) {
      panel.setMode(externalMode);
    }
  }

  panel.setLineCol();
});

const helixKeymap = keymap.of(toCodemirrorKeymap(helixCommandBindings));

/**
 * The main helix extension.
 *
 * It provides Helix-like keybindings, plus two panels to emulate the statusline and the command line.
 */
export function helix(): Extension {
  return [
    EditorView.theme({
      ".cm-cursor": {
        display: "none !important",
      },
      ".cm-hx-cursor": {
        background: "#ccc",
      },
      // WARNING: flaky
      ".cm-searchMatch": {
        background: "initial",
      },
    }),
    drawSelection({
      cursorBlinkRate: 0,
    }),
    helixKeymap,
    modeField,
    historyField,
    registerField,
    searchRegisterField,
    changeFilter,
    inputHandler,
    cursorField,
    updateListener,
    showPanel.of(statusPanel),
    showPanel.of(commandPanel),
    search(),
  ];
}

function commandPanel(view: EditorView) {
  return new CommandPanel(view);
}

function statusPanel(view: EditorView) {
  const dom = el("div");

  dom.style.display = "flex";
  dom.style.justifyContent = "space-between";
  dom.style.fontFamily = "monospace";

  const mode = el("span");

  mode.textContent = "NOR";
  dom.insertBefore(mode, null);

  const pos = el("span");

  dom.insertBefore(pos, null);

  function setLineCol() {
    const { line, column } = lineCol(view);

    pos.textContent = `${line}:${column}`;
  }

  setLineCol();

  return {
    dom,
    setMode(modeStr: string) {
      mode.textContent = modeStr;
    },
    setLineCol,
  };
}

function lineCol(view: EditorView) {
  const head = view.state.selection.main.head;
  const lineDesc = view.state.doc.lineAt(head);
  const line = lineDesc.number;
  const column = head - lineDesc.from + 1;

  return { line, column };
}

class CommandPanel implements Panel {
  dom: HTMLDivElement;

  private command: HTMLElement;
  private input: HTMLElement;

  constructor(private view: EditorView) {
    this.dom = el("div") as any;
    this.dom.style.display = "flex";
    this.dom.style.justifyContent = "space-between";
    this.dom.style.fontFamily = "monospace";
    this.dom.style.minHeight = "2em";

    this.command = el("span");

    this.input = el("span");
    this.input.style.visibility = "hidden";

    this.showCommand(null);

    {
      const label = el("span");
      label.textContent = "search:";

      this.input.insertBefore(label, null);
    }

    this.dom.insertBefore(this.input, null);
    this.dom.insertBefore(this.command, null);
  }

  showSearchInput() {
    const input = this.searchInput();

    this.input.insertBefore(input, null);
    this.input.style.visibility = "";

    input.focus();
  }

  showCommand(command: string | null) {
    if (command) {
      this.command.textContent = command;
    } else {
      this.command.innerHTML = "&nbsp;";
    }
  }

  private searchInput() {
    const { view } = this;

    const input = el("input") as HTMLInputElement;

    input.type = "text";
    input.style.border = "none";
    input.style.outline = "none";
    input.style.background = "inherit";

    let isCompositing = false;

    input.addEventListener("compositionstart", () => {
      isCompositing = true;
    });

    input.addEventListener("compositionend", () => {
      isCompositing = false;
    });

    input.addEventListener("blur", () => {
      this.closeSearchPanel(false);
    });

    input.addEventListener("input", () => {
      const query = new SearchQuery({
        search: input.value,
        regexp: true,
        caseSensitive: false,
      });

      const effect = setSearchQuery.of(query);

      view.dispatch({ effects: effect });

      addSearch(view, query);
    });

    input.addEventListener("keydown", (event) => {
      if (isCompositing) {
        return;
      }
      const isEnter = event.key === "Enter";

      if (isEnter || event.key === "Escape") {
        this.closeSearchPanel(isEnter);
      }
    });

    return input;
  }

  private closeSearchPanel(accept: boolean) {
    this.view.dispatch({
      effects: [
        searchEffect.of({
          type: SearchEffKind.Exit,
          query: accept ? getSearchQuery(this.view.state) : undefined,
        }),
        setSearchQuery.of(new SearchQuery({ search: "" })),
      ],
    });

    this.input.removeChild(this.input.lastChild!);
    this.input.style.visibility = "hidden";

    this.view.focus();
  }
}

function toExternalMode(mode: ModeState) {
  switch (mode.type) {
    case ModeType.Normal:
      return "NOR";
    case ModeType.Select:
      return "SEL";
    case ModeType.Insert:
      return "INS";
  }
}

function findText(
  view: EditorView,
  text: string,
  {
    inclusive,
    reverse,
  }: {
    inclusive: boolean;
    reverse: boolean;
  }
) {
  const mode = view.state.field(modeField);
  const select = mode.type === ModeType.Select;
  const selection = view.state.selection.main;

  const start = reverse ? selection.from : selection.to;

  const doc = view.state.doc.toString();

  const rawIndex = reverse
    ? doc.lastIndexOf(text, start)
    : doc.indexOf(text, start);

  const resetEffect = select ? MODE_EFF.SELECT : MODE_EFF.NORMAL;

  if (rawIndex === -1) {
    view.dispatch({
      effects: resetEffect,
    });

    return;
  }

  const index = inclusive ? rawIndex : reverse ? rawIndex + 1 : rawIndex - 1;

  const newSelection = EditorSelection.range(selection.head, index);

  view.dispatch({
    effects: resetEffect,
    selection: newSelection,
  });
}

const PAIRS: Record<string, [string, string, boolean]> = {
  "(": ["(", ")", true],
  ")": ["(", ")", false],
  "{": ["{", "}", true],
  "}": ["{", "}", false],
  "[": ["[", "]", true],
  "]": ["[", "]", false],
  "<": ["<", ">", true],
  ">": ["<", ">", false],
};

const MATCHEABLE = new Set([...Object.keys(PAIRS), `"`, "'"]);

function matchBracket(view: EditorView) {
  const selection = view.state.selection.main;

  const char = view.state.doc
    .slice(selection.head, selection.head + 1)
    .toString();

  if (!MATCHEABLE.has(char)) {
    // TODO: find surrounding pair

    return null;
  }

  const open = PAIRS[char]?.[2] ?? false;
  const match = matchBrackets(
    view.state,
    selection.head + (open ? 0 : 1),
    open ? 1 : -1
  );

  if (match) {
    return match.end;
  }
}

function surround(view: EditorView, char: string, proxy: ViewProxy) {
  const pair = PAIRS[char];

  const selection = view.state.selection.main;
  const range = helixSelection(selection, view.state.doc);

  const open = pair?.[0] ?? char;
  const close = pair?.[1] ?? char;

  view.dispatch({
    changes: [
      {
        from: range.from,
        insert: open,
      },
      {
        from: range.to,
        insert: close,
      },
    ],
    effects: MODE_EFF.NORMAL,
  });

  const newSelection = proxy.original.state.selection.main;
  const offset = newSelection.anchor === newSelection.from ? 1 : -1;

  const anchor = newSelection.anchor - offset;
  const head = newSelection.head + offset;

  proxy.original.dispatch({
    selection: EditorSelection.range(anchor, head),
  });
}

function el(tag: string) {
  return document.createElement(tag);
}

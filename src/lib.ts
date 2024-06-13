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
  Facet,
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
  ViewPlugin,
  WidgetType,
  drawSelection,
  getPanel,
  keymap,
  showPanel,
} from "@codemirror/view";
import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { matchBrackets, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

import { MinorMode, ModeState, ModeType } from "./entities";
import {
  SearchEffKind,
  historyEffect,
  historyField,
  modeEffect,
  modeField,
  registerField,
  sameMode,
  searchEffect,
  searchRegisterField,
  yankEffect,
} from "./state";
import { CommandPanel, panelStyles, statusPanel } from "./panels";

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

function moveBy(
  view: EditorView,
  mode: NonInsertMode,
  cursor: (view: EditorView) => void,
  select: (view: EditorView) => void
) {
  if (mode.type === ModeType.Select) {
    select(view);

    return;
  }

  const selection = view.state.selection.main;

  if (selection.from !== selection.to) {
    view.dispatch({
      selection: EditorSelection.cursor(selection.head),
    });
  }

  cursor(view);
}

function moveDown(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorLineDown, selectLineDown);
}

function moveUp(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorLineUp, selectLineUp);
}

function moveLeft(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorCharLeft, selectCharLeft);
}

function moveRight(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorCharRight, selectCharRight);
}

// FIXME: refactor with "n" and "N", wrap around
function addSearch(view: EditorView, query: SearchQuery) {
  let match;
  const searchRegister = view.state.field(searchRegisterField);

  if (query.valid) {
    match = query
      .getCursor(
        view.state,
        (searchRegister.original ?? view.state.selection).main.to
      )
      .next();
  }

  if (match && !match.done) {
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
        const panel = getHelixPanel(view, commandPanel);
        panel.showMinor(null);
      }
    },
    ["/"](view) {
      view.dispatch({
        effects: searchEffect.of({
          type: SearchEffKind.Start,
          selection: view.state.selection,
        }),
      });

      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });

      const panel = getHelixPanel(view, commandPanel);

      panel.showSearchInput();
    },
    [":"](view) {
      const panel = getHelixPanel(view, commandPanel);

      panel.showCommandInput();
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
    ["I"]: {
      checkpoint: "temp",
      command(view) {
        const selection = view.state.selection.main;
        const start = view.state.doc.lineAt(selection.from).from;

        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: EditorSelection.cursor(start),
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
    ["r"]: {
      checkpoint: true,
      command(view, mode) {
        view.dispatch({
          effects: modeEffect.of({
            ...mode,
            expecting: {
              callback: replaceWithChar,
              metadata: view,
            },
          }),
        });

        getHelixPanel(view.original, commandPanel).showMinor("r");
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
      getHelixPanel(view, commandPanel).showMinor("g");
    },
    ["m"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL_MATCH : MODE_EFF.SELECT_MATCH,
      });
      getHelixPanel(view, commandPanel).showMinor("m");
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
        if (active) {
          showSearchError(view, active);
        }

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
        if (active) {
          showSearchError(view, active);
        }

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
      moveBy(view, mode, cursorPageDown, selectPageDown);
    },
    ["PageDown"]: "Ctrl-d",
    ["PageUp"]: "Ctrl-u",
    ["Ctrl-u"](view, mode) {
      moveBy(view, mode, cursorPageUp, selectPageUp);
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
        scrollIntoView: true,
      });
    },
    ["Alt-:"](view) {
      const selection = view.state.selection.main;

      view.dispatch({
        selection: EditorSelection.range(selection.from, selection.to),
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
    ["`"]: {
      checkpoint: true,
      command(view) {
        changeCase(view, false);
      },
    },
    ["Alt-`"]: {
      checkpoint: true,
      command(view) {
        changeCase(view, true);
      },
    },
    ["~"]: {
      checkpoint: true,
      command(view) {
        changeCase(view);
      },
    },
    ["*"](view) {
      const selection = helixSelection(
        view.state.selection.main,
        view.state.doc
      );
      const selected = view.state.doc
        .slice(selection.from, selection.to)
        .toString();

      view.dispatch({
        effects: searchEffect.of({
          type: SearchEffKind.Exit,
          query: new SearchQuery({
            search: selected,
            caseSensitive: /[A-Z]/.test(selected),
            regexp: false,
          }),
        }),
      });
    },
    ["_"](view) {
      const selection = helixSelection(
        view.state.selection.main,
        view.state.doc
      );
      const selected = view.state.doc
        .slice(selection.from, selection.to)
        .toString();
      const trimmed = selected.trim();

      if (trimmed === selected) {
        return;
      }

      const startOffset = selected.indexOf(trimmed);
      const endOffset = selected.length - trimmed.length - startOffset;

      const anchor =
        selection.anchor === selection.from
          ? selection.anchor + startOffset
          : selection.anchor - endOffset;
      const head =
        selection.head === selection.to
          ? selection.head - endOffset
          : selection.head + startOffset;

      view.dispatch({
        selection: EditorSelection.range(anchor, head),
      });
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
    ["j"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      moveDown(view, mode);

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["k"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      moveUp(view, mode);

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
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

        getHelixPanel(view.original, commandPanel).showMinor("ms");
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

  const panel = getHelixPanel(view, commandPanel);
  panel.showMinor(status);

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
            view.dispatch(commitToHistory(view, temp), ...args);
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

  const panel = getHelixPanel(viewUpdate.view, statusPanel);

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
 * A facet to define typable commands. No effort is made to prevent overrides,
 * collisions, etc.
 */
export const commandFacet = Facet.define<TypableCommand[], TypableCommand[]>({
  combine(commands) {
    return commands.flat();
  },
});

/**
 * A command that can be typed in command mode `:`.
 */
export interface TypableCommand {
  name: string;
  aliases?: string[];
  help: string;

  /**
   * The handler for the command. The return type can specify a message,
   * and qualify it as an error if desired.
   */
  // TODO: offer a way to influence edits history
  // TODO: offer way to make command interactive as the user types (e.g. `:g`)
  handler(
    view: EditorView,
    args: any[]
  ): { message: string; error?: boolean } | void;
}

/**
 * The main helix extension.
 *
 * It provides Helix-like keybindings, plus two panels to emulate the statusline and the commandline.
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
    panelStyles,
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
    ViewPlugin.define((view) => ({
      update(update) {
        const mode = update.state.field(modeField);
        const startMode = update.startState.field(modeField);

        const panel = getHelixPanel(view, commandPanel);

        if ((panel.hasMessage() && update.docChanged) || update.selectionSet) {
          panel.clearMessage();
        }

        if (
          !sameMode(mode, startMode) &&
          mode.type !== ModeType.Insert &&
          mode.minor === MinorMode.Normal
        ) {
          panel.showMinor(null);
        }
      },
    })),
    commandFacet.of([
      {
        name: "goto",
        aliases: ["g"],
        help: "Goto line number",
        handler(view, args) {
          if (args.length === 0) {
            return { message: "Line number required", error: true };
          }

          const lineNo = Number(args[0]);

          if (!Number.isFinite(lineNo) || lineNo <= 0) {
            return { message: "Invalid line number", error: true };
          }

          const effectiveLine = Math.min(lineNo, view.state.doc.lines);

          const line = view.state.doc.line(effectiveLine);

          view.dispatch({
            selection: EditorSelection.cursor(line.from),
            scrollIntoView: true,
          });
        },
      },
      {
        name: "clipboard-yank",
        help: "Yank main selection into system clipboard",
        handler(view) {
          const selection = view.state.selection.main;
          const range = helixSelection(selection, view.state.doc);

          navigator.clipboard.writeText(
            view.state.doc.slice(range.from, range.to).toString()
          );

          return { message: "Yanked main selection to + register" };
        },
      },
    ]),
  ];
}

function commandPanel(view: EditorView) {
  return new CommandPanel(view, commandFacet, addSearch);
}

function getHelixPanel(
  view: EditorView,
  panel: typeof commandPanel
): CommandPanel;
function getHelixPanel(
  view: EditorView,
  panel: typeof statusPanel
): ReturnType<typeof statusPanel>;
function getHelixPanel(view: EditorView, panel: any) {
  return getPanel(view, panel);
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

  const start = selection.head;

  const doc = view.state.doc.toString();

  const rawIndex = reverse
    ? doc.lastIndexOf(text, start - 1)
    : doc.indexOf(text, start + 1);

  const resetEffect = select ? MODE_EFF.SELECT : MODE_EFF.NORMAL;

  const panel = getHelixPanel(view, commandPanel);

  if (rawIndex === -1) {
    view.dispatch({
      effects: resetEffect,
    });

    panel.showMinor(null);

    return;
  }

  const index = inclusive ? rawIndex : reverse ? rawIndex + 1 : rawIndex - 1;

  const newSelection = select
    ? EditorSelection.range(selection.anchor, index)
    : EditorSelection.range(selection.head, index);

  view.dispatch({
    effects: resetEffect,
    selection: newSelection,
  });

  panel.showMinor(null);
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

function commitToHistory(view: EditorView, temp = false) {
  return {
    effects: historyEffect.of({
      type: "add",
      state: view.state,
      temp,
    }),
  };
}

function changeCase(view: ViewProxy, upper?: boolean) {
  const selection = view.state.selection.main;
  const selected = view.state.doc.slice(selection.from, selection.to);

  let insert;

  if (upper == null) {
    insert = [...selected.toString()]
      .map((char) => {
        let next = char.toUpperCase();

        return next === char ? char.toLowerCase() : next;
      })
      .join("");
  } else if (upper) {
    insert = selected.toString().toUpperCase();
  } else {
    insert = selected.toString().toLowerCase();
  }

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert,
    },
  });
}

function replaceWithChar(view: EditorView, char: string, viewProxy: ViewProxy) {
  const selection = view.state.selection.main;
  const selected = view.state.doc.slice(selection.from, selection.to);

  viewProxy.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: selected.toString().replace(/[^\n]/g, char),
    },
    effects: MODE_EFF.NORMAL,
  });

  getHelixPanel(view, commandPanel).showMinor(null);
}

function showSearchError(view: EditorView, query: SearchQuery) {
  let message = "";

  try {
    query.getCursor(view.state);
  } catch (error: any) {
    message = error?.message;
  }

  getHelixPanel(view, commandPanel).showMessage(
    `Invalid regex /${query.search}/: ${message}`,
    true
  );
}

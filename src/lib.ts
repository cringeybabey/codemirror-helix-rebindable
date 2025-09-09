import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocStart,
  deleteCharBackward,
  deleteCharForward,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  selectAll,
  selectDocStart,
  selectParentSyntax,
  toggleComment,
} from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Extension,
  Facet,
  type Range,
  SelectionRange,
  type StateEffect,
  type Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  type KeyBinding,
  ViewPlugin,
  WidgetType,
  drawSelection,
  getPanel,
  keymap,
  showPanel,
} from "@codemirror/view";
import { SearchQuery } from "@codemirror/search";

import {
  MinorMode,
  ModeState,
  ModeType,
  type NonInsertMode,
  type NormalLikeMode,
  SearchMode,
} from "./entities";

import {
  expandSyntaxHistory,
  historyEffect,
  historyField,
  modeEffect,
  modeField,
  overwriteMode,
  readClipboard,
  readRegister,
  registersField,
  registersHistoryField,
  resetMode,
  sameMode,
  sameModeState,
  syntaxHistoryEffect,
  syntaxHistoryField,
  themeCompartment,
  themeEffect,
  themeField,
  undoSyntaxHistory,
  yankEffect,
} from "./state";
import {
  CommandPanel,
  CommandPanelMessage,
  panelStyles,
  panelTheme,
  statusPanel,
} from "./panels";
import {
  MODE_EFF,
  ViewProxy,
  rangeIsAtomic,
  changeCase,
  cmSelToInternal,
  cmdCount,
  countCommands,
  cursorToLineEnd,
  cursorToLineStart,
  insertLine,
  openLine,
  internalSelToCM,
  matchBracket,
  moveByHalfPage,
  moveDown,
  moveLeft,
  moveRight,
  moveToSibling,
  moveUp,
  paste,
  removeText,
  replaceWithChar,
  resetCount,
  setFindMode,
  surround,
  withHelixSelection,
  mapSel,
  rotateSelection,
  changeNumber,
  yanksForSelection,
  yank,
  extendToDelimiters,
  nextClusterBreak,
  rangeIsForward,
} from "./commands";
import { backwardsSearch } from "./search";

function startSearch(view: EditorView, mode: SearchMode) {
  const initialScroll = view.scrollSnapshot();
  const initialSelection = view.state.selection;

  let input = "";
  let query: SearchQuery | null = null;

  function reset() {
    view.dispatch({
      selection: initialSelection,
    });

    resetScroll(view, initialScroll);
  }

  return {
    // FIXME: this is not correct. We should join the contents of the register here
    // and keep the multi-selection in case somebody pastes from '/'
    init: view.state.field(registersField)["/"]?.toString() ?? "",
    onInput(input_: string) {
      if (input !== input_) {
        input = input_;
        query = searchQuery(input);
      } else {
        return;
      }

      if (!query?.valid && mode !== SearchMode.Selection) {
        return;
      }

      if (mode === SearchMode.Global) {
        return;
      }

      if (mode === SearchMode.Selection) {
        if (!query.valid) {
          if (!input) {
            view.dispatch({
              selection: initialSelection,
            });
          }
          return;
        }

        const selections = [];

        for (const sel of initialSelection.ranges) {
          const match = query.getCursor(view.state, sel.from, sel.to);

          for (const matched of {
            [Symbol.iterator]() {
              return match;
            },
          }) {
            selections.push(matched);
          }
        }

        const newRanges = selections.map((sel) =>
          EditorSelection.range(sel.from, sel.to)
        );

        const newSelection =
          newRanges.length === 0
            ? initialSelection
            : EditorSelection.create(newRanges, 0);

        view.dispatch({
          selection: newSelection,
        });

        return;
      }

      let match = query.getCursor(view.state, initialSelection.main.to).next();

      if (match.done) {
        match = query.getCursor(view.state).next();
      }

      if (match.done) {
        reset();
      } else {
        const selection = EditorSelection.range(
          match.value.from,
          match.value.to
        );

        view.dispatch({
          selection,
          effects: EditorView.scrollIntoView(selection, { y: "center" }),
        });
      }
    },

    onClose(accept: boolean) {
      if (!accept) {
        reset();

        return;
      }

      // TODO: previous value
      if (input != null) {
        view.dispatch({
          effects: yankEffect.of(["/", [input]]),
        });
      }

      if (mode === SearchMode.Global) {
        const externalCommands = view.state.facet(externalCommandsFacet);
        const query = input || readRegister(view.state, "/");

        if (query) {
          return externalCommands.global_search?.(query.toString());
        }
      }
    },
  };
}

function searchQuery(query: string) {
  return new SearchQuery({
    search: query,
    regexp: true,
    caseSensitive: /[A-Z]/.test(query),
  });
}

const searchFacet = Facet.define<string | undefined, SearchQuery | undefined>({
  combine(inputs) {
    const input = inputs[0];

    return input ? searchQuery(input) : undefined;
  },
});

type SimpleCommand<M> = (
  view: EditorView,
  mode: M
) => boolean | undefined | void;

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
  insert: Record<string, SimpleCommand<ModeState & { type: ModeType.Insert }>>;
  normal: Record<string, CommandDef<NormalLikeMode>>;
  goto: Record<string, CommandDef<NonInsertMode>>;
  match: Record<string, CommandDef<NonInsertMode>>;
  space: Record<string, CommandDef<NonInsertMode>>;
  leftBracket: Record<string, CommandDef<NonInsertMode>>;
  rightBracket: Record<string, CommandDef<NonInsertMode>>;
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
    // we need these two due to https://github.com/codemirror/dev/issues/634
    // FIXME: stuff like Shift-<arrow> doesn't quite work with `editor.cursor-shape.insert === "block"`.
    ArrowLeft: cursorCharLeft,
    ArrowRight: cursorCharRight,
    Escape(view, mode) {
      if (mode.expecting) {
        view.dispatch({
          effects: MODE_EFF.INSERT,
        });

        return true;
      }

      view.dispatch({
        effects: [
          MODE_EFF.NORMAL,
          historyEffect.of({ type: "commit", state: view.state }),
        ],
        selection: mapSel(view.state.selection, (range) =>
          range.empty ? internalSelToCM(range, view.state.doc) : range
        ),
      });
    },
    ["Ctrl-r"](view) {
      view.dispatch({
        effects: modeEffect.of({
          type: ModeType.Insert,
          expecting: {
            minor: "<C-r>",
            callback(view, char, _metadata) {
              const yanked = readRegister(view.state, char);

              paste(view, yanked, false, 1, { select: false, reset: false });

              view.dispatch({
                effects: MODE_EFF.INSERT,
              });
            },
            metadata: undefined,
          },
        }),
      });
    },
    Tab: indentMore,
    "Shift-Tab": indentLess,
  },
  normal: {
    // this one is special: we let it apply to all other minor modes
    Escape(view, mode_) {
      const mode = mode_ as NonInsertMode;

      if (
        mode.type === ModeType.Normal &&
        mode.minor === MinorMode.Normal &&
        mode.expecting == null &&
        mode.register == null &&
        mode.count == null
      ) {
        return true;
      }

      view.dispatch({
        effects: [MODE_EFF.NORMAL],
      });
    },
    ["/"](view) {
      const panel = getCommandPanel(view);

      panel.showSearchInput();
    },
    ["s"](view) {
      const panel = getCommandPanel(view);

      panel.showSearchInput(SearchMode.Selection);
    },
    ["Alt-s"](view) {
      const selections: SelectionRange[] = [];
      const lines = new Set<number>();

      for (const range of view.state.selection.ranges) {
        const start = view.state.doc.lineAt(range.from).number;
        const endLine = view.state.doc.lineAt(range.to);
        const end =
          endLine.from === range.to ? endLine.number - 1 : endLine.number;

        for (let l = start; l <= end; l++) {
          const line = view.state.doc.line(l);

          if (lines.has(line.number)) {
            continue;
          }

          lines.add(line.number);

          selections.push(EditorSelection.range(line.from, line.to));
        }
      }

      view.dispatch({
        selection: EditorSelection.create(selections, 0),
      });
    },
    [","](view) {
      if (view.state.selection.ranges.length === 1) {
        return true;
      }

      view.dispatch({
        selection: view.state.selection.asSingle(),
      });
    },
    ["("](view) {
      rotateSelection(view, false);
    },
    [")"](view) {
      rotateSelection(view, true);
    },
    ...countCommands,
    [":"](view, mode) {
      view.dispatch({
        effects: resetMode(mode),
      });

      getCommandPanel(view).showCommandInput();
    },
    ["y"](view, mode) {
      getCommandPanel(view).showMessage(yank(view, mode));
    },
    ["a"]: {
      checkpoint: "temp",
      command(view) {
        // TODO: extend selection
        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: mapSel(view.state.selection, (range) =>
            EditorSelection.range(range.to, range.to)
          ),
        });
      },
    },
    ["A"]: {
      checkpoint: "temp",
      command(view, mode) {
        cursorToLineEnd(view, mode, true);
      },
    },
    ["I"]: {
      checkpoint: "temp",
      command(view) {
        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: mapSel(view.state.selection, (range) => {
            // TODO: line start takes into account whitespace
            const start = view.state.doc.lineAt(range.from).from;

            return EditorSelection.cursor(start);
          }),
        });
      },
    },
    ["c"]: {
      checkpoint: "temp",
      command(view) {
        removeText(view, { edit: true });
      },
    },
    ["d"]: {
      checkpoint: true,
      command(view) {
        removeText(view);
      },
    },
    ["Alt-c"]: {
      checkpoint: "temp",
      command(view) {
        removeText(view, { yank: false, edit: true });
      },
    },
    ["Alt-d"]: {
      checkpoint: true,
      command(view) {
        removeText(view, { yank: false });
      },
    },
    ["P"]: {
      checkpoint: true,
      command(view, mode) {
        const yanked = readRegister(view.state, mode.register);

        paste(view, yanked, true, cmdCount(mode));
      },
    },
    ["p"]: {
      checkpoint: true,
      command(view, mode) {
        const yanked = readRegister(view.state, mode.register);

        paste(view, yanked, false, cmdCount(mode));
      },
    },
    ["R"]: {
      checkpoint: true,
      command(view, mode) {
        const contents = readRegister(view.state, mode.register);

        if (!contents) {
          return true;
        }

        const count = cmdCount(mode);
        const yanks = yanksForSelection(view.state.selection, contents);

        const replacements =
          count === 1
            ? yanks
            : yanks.map((yank) => yank.toString().repeat(count));

        const byIndex = new Map(
          view.state.selection.ranges.map((range, i) => [range, i])
        );

        const tr = view.state.changeByRange((range) => {
          const insert = replacements[byIndex.get(range)!];

          if (!insert) {
            return { range };
          }

          // FIXME: fix ranges
          return {
            range: EditorSelection.range(
              range.from,
              range.from + insert.length
            ),
            changes: {
              from: range.from,
              to: range.to,
              insert: insert,
            },
          };
        });

        view.dispatch({
          ...tr,
          effects: [...tr.effects, MODE_EFF.NORMAL],
        });
      },
    },
    ["r"]: {
      checkpoint: true,
      command(view, mode) {
        view.dispatch({
          effects: modeEffect.of({
            ...mode,
            expecting: {
              minor: "r",
              callback: replaceWithChar,
              metadata: view,
            },
          }),
        });
      },
    },
    ["w"](view, mode) {
      // FIXME: this is a temporary hack to have something
      moveByGroup(view, mode, true);
    },
    ["e"](view, mode) {
      moveByGroup(view, mode, true);
    },
    ["b"](view, mode) {
      moveByGroup(view, mode, false);
    },
    ["v"](view, mode) {
      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.SELECT : MODE_EFF.NORMAL,
      });
    },
    ["g"](view, mode) {
      view.dispatch({
        effects: overwriteMode(mode, { minor: MinorMode.Goto }),
      });
    },
    ["Space"](view, mode) {
      view.dispatch({
        effects: overwriteMode(mode, { minor: MinorMode.Space }),
      });
    },
    ["m"](view, mode) {
      view.dispatch({
        effects: overwriteMode(mode, { minor: MinorMode.Match }),
      });
    },
    ["i"]: {
      checkpoint: "temp",
      command(view) {
        view.dispatch({
          effects: MODE_EFF.INSERT,
          selection: mapSel(view.state.selection, (range) =>
            EditorSelection.range(range.from, range.from)
          ),
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
        openLine(view, true);
      },
    },
    ["O"]: {
      checkpoint: "temp",
      command(view) {
        openLine(view, false);
      },
    },
    ["f"](view, mode) {
      setFindMode(view, "f", mode, {
        inclusive: true,
        forward: true,
      });
    },
    ["F"](view, mode) {
      setFindMode(view, "F", mode, {
        inclusive: true,
        forward: false,
      });
    },
    ["t"](view, mode) {
      setFindMode(view, "t", mode, {
        inclusive: false,
        forward: true,
      });
    },
    ["T"](view, mode) {
      setFindMode(view, "T", mode, {
        inclusive: false,
        forward: false,
      });
    },
    ["u"](view, mode) {
      const { checkpoints, cursor } = view.state.field(historyField);

      const nextCursor = cursor + cmdCount(mode);

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
        effects: [
          historyEffect.of({
            type: "move",
            offset: cmdCount(mode),
            head: view.state,
          }),
          resetCount(mode),
        ],
        scrollIntoView: true,
      });
    },
    ["U"](view, mode) {
      const { checkpoints, cursor, head } = view.state.field(historyField);

      const nextCursor = cursor - cmdCount(mode);

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
        effects: [
          historyEffect.of({
            type: "move",
            offset: -cmdCount(mode),
          }),
          resetCount(mode),
        ],
        scrollIntoView: true,
      });
    },
    ["x"](view, mode) {
      function extend(range: SelectionRange) {
        const startLine = view.state.doc.lineAt(range.from);
        let endLine = view.state.doc.lineAt(range.to);

        if (!range.empty && range.to === endLine.from) {
          endLine = view.state.doc.line(endLine.number - 1);
        }

        const ideal = EditorSelection.range(
          startLine.from,
          Math.min(
            view.state.doc.length,
            endLine.to + view.state.lineBreak.length
          )
        );

        const perfectLineSelection =
          ideal.from === range.from && ideal.to === range.to;

        if (perfectLineSelection || mode.count) {
          const nextLineNumber = Math.min(
            endLine.number + cmdCount(mode),
            view.state.doc.lines
          );
          const nextLine = view.state.doc.line(nextLineNumber);

          return EditorSelection.range(
            startLine.from,
            Math.min(
              view.state.doc.length,
              nextLine.to + view.state.lineBreak.length
            )
          );
        } else {
          return ideal;
        }
      }

      view.dispatch({
        selection: mapSel(view.state.selection, extend),
        effects: resetCount(mode),
      });

      return true;
    },
    ["n"](view, mode) {
      const query = view.state.facet(searchFacet);

      if (!query?.valid) {
        if (query) {
          showSearchError(view, query);
        }

        view.dispatch({
          effects: resetCount(mode),
        });

        return true;
      }

      let cursor = query.getCursor(view.state, view.state.selection.main.to);

      let match;

      let found = false;
      let wrapped = false;

      for (let _i = 0; _i < cmdCount(mode); _i++) {
        match = cursor.next();
        found ||= !match.done;

        if (match.done) {
          cursor = query.getCursor(view.state);
          wrapped = true;
          match = cursor.next();
          found ||= !match.done;
        }

        if (!found) {
          getCommandPanel(view).showError("No more matches");

          return;
        }
      }

      const newRange = EditorSelection.range(
        match!.value.from,
        match!.value.to
      );

      let newSel: EditorSelection | SelectionRange = newRange;

      if (mode.type === ModeType.Select) {
        newSel = view.state.selection.addRange(newRange);
      }

      view.dispatch({
        selection: newSel,
        scrollIntoView: true,
      });

      if (wrapped) {
        getCommandPanel(view).showMessage("Wrapped around document");
      }
    },
    ["N"](view, mode) {
      const query = view.state.facet(searchFacet);

      if (!query?.valid) {
        if (query) {
          showSearchError(view, query);
        }

        view.dispatch({
          effects: resetCount(mode),
        });

        return true;
      }

      const result = backwardsSearch(view.state, query, mode, (match) => {
        const selection = EditorSelection.range(match.from, match.to);

        view.dispatch({
          selection: selection,
          effects: EditorView.scrollIntoView(selection, { y: "center" }),
        });
      });

      if (result?.wrapped) {
        getCommandPanel(view).showMessage("Wrapped around document");
      } else if (result?.match === false) {
        getCommandPanel(view).showError("No more matches");
      }

      view.dispatch({
        effects: resetCount(mode),
      });
    },
    ["Ctrl-a"]: {
      checkpoint: true,
      command(view) {
        changeNumber(view, true);
      },
    },
    ["Ctrl-x"]: {
      checkpoint: true,
      command(view) {
        changeNumber(view, false);
      },
    },
    ["Ctrl-d"](view, mode) {
      moveByHalfPage(view, mode, true);
    },
    ["PageDown"]: "Ctrl-d",
    ["PageUp"]: "Ctrl-u",
    ["Ctrl-u"](view, mode) {
      moveByHalfPage(view, mode, false);
    },
    [";"](view) {
      withHelixSelection(view, () => {
        view.dispatch({
          selection: mapSel(view.state.selection, (range) =>
            EditorSelection.cursor(range.head)
          ),
          scrollIntoView: true,
        });

        return true;
      });
    },
    ["Alt-;"](view) {
      view.dispatch({
        selection: mapSel(view.state.selection, (range) =>
          rangeIsAtomic(range, view.state.doc)
            ? range
            : EditorSelection.range(range.head, range.anchor)
        ),
        scrollIntoView: true,
      });
    },
    ["Alt-:"](view) {
      view.dispatch({
        selection: mapSel(view.state.selection, (range) =>
          rangeIsAtomic(range, view.state.doc)
            ? range
            : EditorSelection.range(range.from, range.to)
        ),
      });
    },
    ["Alt-ArrowUp"](view) {
      expandSyntaxHistory(
        view.state,
        (start, dispatch) => {
          view.dispatch(start);

          selectParentSyntax({
            state: view.state,
            dispatch,
          });
        },
        (spec) => view.dispatch(spec)
      );
    },
    ["Alt-o"]: "Alt-ArrowUp",
    ["Alt-i"]: "Alt-ArrowDown",
    ["Alt-ArrowDown"](view) {
      const result = undoSyntaxHistory(view.state);

      if (result) {
        view.dispatch(result);
      }
    },
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
      const yanked = new Set(
        view.state.selection.ranges.map((range) =>
          escapeRegex(view.state.doc.sliceString(range.from, range.to))
        )
      );
      const search = [...yanked].join("|");

      // FIXME: add \b
      view.dispatch({
        effects: yankEffect.of(["/", [search]]),
      });

      getCommandPanel(view).showMessage(`register '/' set to '${search}'`);
    },
    ["_"](view) {
      view.dispatch({
        selection: mapSel(view.state.selection, (range) => {
          const selected = view.state.doc
            .slice(range.from, range.to)
            .toString();

          const trimmed = selected.trim();

          if (trimmed === selected) {
            return range;
          }

          const startOffset = selected.indexOf(trimmed);
          const endOffset = selected.length - trimmed.length - startOffset;

          const anchor =
            range.anchor === range.from
              ? range.anchor + startOffset
              : range.anchor - endOffset;
          const head =
            range.head === range.to
              ? range.head - endOffset
              : range.head + startOffset;

          return EditorSelection.range(anchor, head);
        }),
      });
    },
    ["Home"]: cursorToLineStart,
    ["End"]: cursorToLineEnd,
    ["J"]: {
      checkpoint: true,
      command(view) {
        // FIXME: multiple
        const selection = view.state.selection.main;

        const { doc } = view.state;

        const startLine = doc.lineAt(selection.from);

        if (startLine.number >= doc.lines) {
          return;
        }

        let endLine = doc.lineAt(selection.to);

        const sameLine = endLine.number === startLine.number;

        if (sameLine) {
          endLine = doc.line(startLine.number + 1);
        }

        let content = "";
        let removed = 0;

        for (
          let lineNo = startLine.number;
          lineNo <= endLine.number;
          lineNo++
        ) {
          let lineContent = startLine.text;

          if (lineNo > startLine.number) {
            const lineText = doc.line(lineNo).text;

            lineContent = lineText.trimStart();

            let trimmed = lineText.length - lineContent.length;

            if (
              !sameLine &&
              lineNo === endLine.number &&
              selection.to - endLine.from < trimmed
            ) {
              // FIXME: this is not the actual behavior in Helix.
              trimmed = selection.to - endLine.from;
            }

            removed += trimmed;
          }

          content += lineContent;
          content += lineNo === endLine.number ? "" : " ";
        }

        const newTo = sameLine
          ? selection.to
          : selection.to -
            removed -
            (endLine.number - startLine.number) *
              (view.state.lineBreak.length - 1);

        view.dispatch({
          changes: {
            from: startLine.from,
            to: endLine.to,
            insert: content,
          },
          selection:
            selection.anchor > selection.head
              ? EditorSelection.range(newTo, selection.from)
              : EditorSelection.range(selection.from, newTo),
        });
      },
    },
    ["["](view, mode) {
      view.dispatch({
        effects: overwriteMode(mode, { minor: MinorMode.LeftBracket }),
      });
    },
    ["]"](view, mode) {
      view.dispatch({
        effects: overwriteMode(mode, { minor: MinorMode.RightBracket }),
      });
    },
    [`"`](view, mode) {
      view.dispatch({
        effects: overwriteMode(mode, {
          expecting: {
            minor: `"`,
            metadata: undefined,
            callback(view, char, _metadata) {
              view.dispatch({
                effects: modeEffect.of({ ...mode, register: char }),
              });
            },
          },
        }),
      });
    },
    Tab() {
      // FIXME: jumplist
    },
    ["Shift-Tab"]() {
      // ignore
    },
  },
  goto: {
    ["g"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      withHelixSelection(view, () =>
        isNormal ? cursorDocStart(view) : selectDocStart(view)
      );

      view.dispatch({
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["e"](view, mode) {
      const isNormal = mode.type === ModeType.Normal;

      const start = view.state.selection.ranges[0].from;

      const lastLine = view.state.doc.line(view.state.doc.lines);

      const line =
        lastLine.text || view.state.doc.lines === 1
          ? lastLine
          : view.state.doc.line(view.state.doc.lines - 1);
      const end = line.from;

      view.dispatch({
        selection: internalSelToCM(
          isNormal
            ? EditorSelection.cursor(end)
            : EditorSelection.range(start, end),
          view.state.doc
        ),
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
        scrollIntoView: true,
      });
    },
    ["h"]: cursorToLineStart,
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
    ["l"]: cursorToLineEnd,
    ["n"](view, mode) {
      const externalCommandDefs = view.state.facet(externalCommandsFacet);

      const result = externalCommandDefs[":buffer-next"]?.();

      getCommandPanel(view).showMessage(result);

      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["p"](view, mode) {
      const externalCommandDefs = view.state.facet(externalCommandsFacet);

      const result = externalCommandDefs[":buffer-previous"]?.();

      getCommandPanel(view).showMessage(result);

      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
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
              minor: "s",
              callback: surround,
              metadata: view,
            },
          }),
        });
      },
    },
    ["m"](view, mode) {
      const bracketSelections = matchBracket(view) ?? undefined;

      const isNormal = mode.type === ModeType.Normal;

      const selections = bracketSelections.map((bracketSelection) => {
        if (bracketSelection == null) {
          return undefined;
        }

        let selection = EditorSelection.range(
          bracketSelection.from,
          bracketSelection.to
        );

        if (!isNormal) {
          const bracketCursor = bracketSelection.from;
          const internal = cmSelToInternal(
            view.state.selection.main,
            view.state.doc
          );

          selection = internalSelToCM(
            EditorSelection.range(internal.anchor, bracketCursor),
            view.state.doc
          );
        }

        return selection;
      });

      view.dispatch({
        selection: EditorSelection.create(
          view.state.selection.ranges.map((range, i) => selections[i] ?? range),
          view.state.selection.mainIndex
        ),
        effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
        scrollIntoView: true,
      });
    },
    ["a"](view, mode) {
      view.dispatch({
        effects: modeEffect.of({
          type: mode.type,
          minor: MinorMode.Match,
          expecting: {
            minor: "a",
            callback: extendToDelimiters,
            metadata: true,
          },
        }),
      });
    },
    ["i"](view, mode) {
      view.dispatch({
        effects: modeEffect.of({
          type: mode.type,
          minor: MinorMode.Match,
          expecting: {
            minor: "i",
            callback: extendToDelimiters,
            metadata: false,
          },
        }),
      });
    },
  },
  space: {
    ["y"](view, mode) {
      getCommandPanel(view).showMessage(yank(view, mode, "+"));
    },
    ["p"]: {
      checkpoint: true,
      command(view) {
        view.dispatch({ effects: MODE_EFF.NORMAL });

        readClipboard(view.state).then((yanked) =>
          paste(view, yanked, false, 1, { reset: false })
        );
      },
    },
    ["P"]: {
      checkpoint: true,
      command(view) {
        view.dispatch({ effects: MODE_EFF.NORMAL });

        readClipboard(view.state).then((yanked) =>
          paste(view, yanked, true, 1, { reset: false })
        );
      },
    },
    // FIXME: align with the non-clipboard one
    ["R"]: {
      checkpoint: true,
      command(view) {
        view.dispatch({ effects: MODE_EFF.NORMAL });

        readClipboard(view.state).then((yanked) => {
          const tr = view.state.replaceSelection(yanked[0]);
          view.dispatch(tr);
        });
      },
    },
    ["f"](view, mode) {
      const externalCommandDefs = view.state.facet(externalCommandsFacet);

      const result = externalCommandDefs.file_picker?.();

      getCommandPanel(view).showMessage(result);

      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["b"](view, mode) {
      const externalCommandsDef = view.state.facet(externalCommandsFacet);

      const result = externalCommandsDef.buffer_picker?.();

      getCommandPanel(view).showMessage(result);

      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
    ["/"](view, mode) {
      const enabled =
        view.state.facet(externalCommandsFacet).global_search != null;

      if (enabled) {
        getCommandPanel(view).showSearchInput(SearchMode.Global);
      }

      view.dispatch({
        effects:
          mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
      });
    },
  },
  leftBracket: {
    ...countCommands,
    ["Space"]: {
      checkpoint: true,
      command(view) {
        insertLine(view, false);
      },
    },
  },
  rightBracket: {
    ...countCommands,
    ["Space"]: {
      checkpoint: true,
      command(view) {
        insertLine(view, true);
      },
    },
  },
};

function moveByGroup(view: EditorView, mode: NormalLikeMode, forward: boolean) {
  const normal = mode.type === ModeType.Normal;

  const tr = view.state.changeByRange((range) => {
    const rangeForward = rangeIsForward(range);
    const [headCursor, anchorCursor] = rangeIsAtomic(range, view.state.doc)
      ? [range, range]
      : [
          EditorSelection.range(
            nextClusterBreak(view.state.doc, range.head, !rangeForward),
            range.head
          ),
          EditorSelection.range(
            range.anchor,
            nextClusterBreak(view.state.doc, range.anchor, rangeForward)
          ),
        ];

    let nextAnchor = forward ? headCursor.from : headCursor.to;

    let nextHead = view.moveByGroup(
      EditorSelection.cursor(nextAnchor),
      forward
    ).head;

    const oldEnd = forward ? headCursor.to : headCursor.from;

    if (nextHead === oldEnd) {
      nextAnchor = nextHead;

      nextHead = view.moveByGroup(
        EditorSelection.cursor(nextAnchor),
        forward
      ).head;
    }

    const nextRange = EditorSelection.range(nextAnchor, nextHead);

    if (!normal) {
      const nextHeadCursor = rangeIsAtomic(nextRange, view.state.doc)
        ? nextRange
        : EditorSelection.range(
            nextClusterBreak(view.state.doc, nextRange.head, !forward),
            nextRange.head
          );
      [nextAnchor, nextHead] =
        nextHeadCursor.to < anchorCursor.from
          ? [anchorCursor.to, nextHeadCursor.from]
          : [anchorCursor.from, nextHeadCursor.to];

      const range = EditorSelection.range(nextAnchor, nextHead);

      return {
        range,
      };
    }

    return {
      range: nextRange,
    };
  });

  view.dispatch(tr);
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
      | SimpleCommand<ModeState & { type: ModeType.Insert }>
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
    const spaceCommand = getExplicitCommand(key, keybindings.space) as
      | ExplicitCommandDef<NonInsertMode>
      | undefined;
    const leftBracketCommand = getExplicitCommand(
      key,
      keybindings.leftBracket
    ) as ExplicitCommandDef<NonInsertMode> | undefined;
    const rightBracketCommand = getExplicitCommand(
      key,
      keybindings.rightBracket
    ) as ExplicitCommandDef<NonInsertMode> | undefined;

    const esc = key === "Escape";
    const isChar = key.length === 1 || key === "Space";

    const command = (view: EditorView) => {
      const mode = view.state.field(modeField);

      if (mode.type === ModeType.Insert) {
        if (insertCommand) {
          return insertCommand(view, mode) ?? true;
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
      } else if (mode.minor === MinorMode.Space && spaceCommand) {
        result = apply(spaceCommand, view, mode);
      } else if (mode.minor === MinorMode.LeftBracket && leftBracketCommand) {
        result = apply(leftBracketCommand, view, mode);
      } else if (mode.minor === MinorMode.RightBracket && rightBracketCommand) {
        result = apply(rightBracketCommand, view, mode);
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
const endlineCursorWidget = Decoration.widget({
  widget: new EndLineCursor(),
  side: 1,
});

function drawCursorMark(selection: EditorSelection, doc: Text) {
  const headSelections = selection.ranges.map((range) =>
    internalSelToCM(
      EditorSelection.cursor(cmSelToInternal(range, doc).head),
      doc
    )
  );

  const decorations: Range<Decoration>[] = [];

  for (const headSel of headSelections) {
    const line = doc.lineAt(headSel.head);

    if (headSel.from === doc.length || line.to === headSel.from) {
      decorations.push(endlineCursorWidget.range(headSel.from, headSel.from));
    } else {
      decorations.push(cursorMark.range(headSel.head, headSel.anchor));
    }
  }

  return Decoration.set(decorations);
}

function letThrough(tr: Transaction) {
  return tr;
}

const selectByClickFilter = EditorState.transactionFilter.from(
  modeField,
  (mode) =>
    mode.type === ModeType.Insert
      ? letThrough
      : (tr) => {
          const userEvent = tr.annotation(Transaction.userEvent);

          if (userEvent !== "select.pointer") {
            return tr;
          }

          const selection = tr.newSelection.main;

          if (!selection.empty) {
            return tr;
          }

          return [
            tr,
            {
              selection: internalSelToCM(selection, tr.newDoc),
            },
          ];
        }
);

const unhandledCommandsFilter = EditorState.transactionFilter.from(
  modeField,
  (mode) =>
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

          if (!userEvent.startsWith("input.type")) {
            return tr;
          }

          if (mode.minor !== MinorMode.Normal) {
            return {
              effects:
                mode.type === ModeType.Normal
                  ? MODE_EFF.NORMAL
                  : MODE_EFF.SELECT,
            };
          }

          return [];
        }
);

// TODO: this trick doesn't work with compositing. We have to
// bite the bullet and let an external source of input take care of this.
const expectingInputHandler = EditorView.inputHandler.from(
  modeField,
  (mode) => (view, _from, _to, text) => {
    if (mode.expecting) {
      mode.expecting.callback(view, text, mode.expecting.metadata);
      return true;
    }

    return false;
  }
);

const modeUpdateListener = EditorView.updateListener.of((viewUpdate) => {
  const { state, startState } = viewUpdate;

  const panel = getPanel(viewUpdate.view, statusPanel) as ReturnType<
    typeof statusPanel
  >;

  const mode = state.field(modeField);
  // if helix was no enabled before (when using compartments) this could throw
  const startMode = startState.field(modeField, false);

  if (mode !== startMode) {
    const startExternalMode = startMode ? toExternalMode(startMode) : undefined;
    const externalMode = toExternalMode(mode);

    if (
      startExternalMode !== externalMode ||
      (mode as NonInsertMode).register !==
        (startMode as NonInsertMode | undefined)?.register
    ) {
      panel.setMode(externalMode, (mode as NonInsertMode).register);
    }
  }

  panel.setLineCol();
});

const helixKeymap = keymap.of(toCodemirrorKeymap(helixCommandBindings));

type ExternalCommand =
  | "file_picker"
  | "buffer_picker"
  | ":buffer-next"
  | ":buffer-previous";

type ExternalActionHandler = () => CommandPanelMessage | void;

type ExternalCommandsDefinition = Partial<
  Record<ExternalCommand, ExternalActionHandler>
> & {
  [":buffer-close"]?: {
    handler(buffers?: string[]): void | CommandPanelMessage;
    autocomplete?(args: string[]): string[];
  };
  global_search?(input: string): void | CommandPanelMessage;
};

/**
 * A facet that allows to define external commands.
 */
const externalCommandsFacet = Facet.define<
  ExternalCommandsDefinition,
  ExternalCommandsDefinition
>({
  combine(values) {
    const handlers = [...values];
    handlers.reverse();

    if (process.env.NODE_ENV === "development") {
      const merged = values.reduce((acc, defs) => {
        for (const key of Object.keys(defs)) {
          if (acc[key] == null) {
            acc[key] = 1;
          } else {
            acc[key]++;
          }
        }

        return acc;
      }, {} as Record<string, number>);

      const multiple = Object.entries(merged).flatMap(([key, count]) =>
        count > 1 ? [key] : []
      );

      if (multiple.length > 0) {
        console.warn(
          `Multiple definitions found for external commands: ${multiple.join(
            ", "
          )}`
        );
      }
    }

    return handlers.reduce((acc, def) => {
      return { ...acc, ...def };
    }, {});
  },
});

export { externalCommandsFacet as externalCommands };

/**
 * Exposes the contents of a given register for external consumption
 * for e.g. reading registers in external UI elements, suck as pickers.
 */
function externalReadRegister(state: EditorState, register: string) {
  const contents = readRegister(state, register);

  return contents?.at(0);
}

export { externalReadRegister as readRegister };

/**
 * Allows the embedder to provide the "path" i.e. the contents of the `%` register.
 */
export const pathRegister = Facet.define<
  string | undefined,
  string | undefined
>({
  combine(values) {
    return values.at(-1);
  },
});

/**
 * Creates a snapshot of the extension state suitable to initialize
 * the extension later (see `init` and `globalInit`). Snapshots are JSON-serializable.
 *
 * If `global` is true, the snapshot only contains global state. This way
 * it is slimmer, but it is only valid for `globalInit`.
 */
export function snapshot(state: EditorState, global = false): Object {
  return {
    registers: state.field(registersField),
    registersHistory: state.field(registersHistoryField),
    ...(global
      ? {}
      : {
          history: state.field(historyField),
        }),
  };
}

/**
 * Generates a list of transactions that can be dispatched to
 * another editor to ensure that its global state is synchronized
 * with `state`.
 */
export function globalStateSync(state: EditorState): TransactionSpec[] {
  return [
    {
      effects: yankEffect.of({
        reset: {
          values: state.field(registersField),
          history: state.field(registersHistoryField),
        },
      }),
    },
  ];
}

/**
 * A facet to define typable commands. No effort is made to prevent overrides,
 * collisions, etc.
 */
export const commands = Facet.define<TypableCommand[], TypableCommand[]>({
  combine(commands) {
    const combined = commands.flat();

    return combined.sort((cmdA, cmdB) =>
      cmdA.name < cmdB.name ? -1 : cmdA.name > cmdB.name ? 1 : 0
    );
  },
});

const exportedResetMode: StateEffect<any> = MODE_EFF.NORMAL;

/**
 * An effect to reset the mode of an editor.
 */
export { exportedResetMode as resetMode };

/**
 * A command that can be typed in command mode `:`.
 */
export interface TypableCommand {
  name: string;
  aliases?: string[];
  help: string;

  autocomplete?: (args: string[]) => string[];

  /**
   * The handler for the command. The return type can specify a message,
   * and qualify it as an error if desired.
   */
  // TODO: offer a way to influence edits history
  // TODO: offer way to make command interactive as the user types (e.g. `:g`)
  handler(view: EditorView, args: any[]): CommandPanelMessage | void;
}

export interface Options {
  config?: Config;

  /**
   * Themes accessible from the `:theme` command.
   */
  themes?: Array<{ name: string; extension: Extension; dark?: boolean }>;

  /**
   * If provided, sets the extension initial state from a previous state, or a snapshot
   * created by `snapshot()`.
   */
  init?: EditorState | Object;

  /**
   * Like `init`, but it will only restore global state that should be shared between different "tabs".
   * For instance, registers are global state, while undo/redo history is not.
   */
  globalInit?: EditorState | Object;
}

/**
 * Editor configuration.
 * The names follow Helix's options' naming.
 */
export interface Config {
  "editor.cursor-shape.insert"?: "block" | "bar";
}

const themeFacet = Facet.define<
  (theme: { name: string; dark?: boolean }) => void
>({ static: true });

/**
 * Facet that allows to listen to theme changes.
 */
export { themeFacet as themeListener };

/**
 * The main helix extension.
 *
 * It provides Helix-like keybindings, plus two panels to emulate the statusline and the commandline.
 */
export function helix(options: Options = {}): Extension {
  const cursorShape =
    options?.config?.["editor.cursor-shape.insert"] ?? "block";

  const globalState = options.globalInit ?? options.init;

  const initialRegisters =
    globalState instanceof EditorState
      ? globalState.field(registersField)
      : globalState
      ? (globalState as any).registers
      : undefined;

  const initialHistory =
    options.init instanceof EditorState
      ? options.init.field(historyField)
      : options.init
      ? (options.init as any).history
      : undefined;

  const initialRegistersHistory =
    globalState instanceof EditorState
      ? globalState.field(registersHistoryField)
      : globalState
      ? (globalState as any).registersHistory
      : undefined;

  const initialTheme = options.themes?.length ? options.themes[0] : undefined;

  return [
    ...(initialTheme
      ? [
          themeField.init(() => initialTheme.name),
          themeCompartment.of([
            initialTheme.extension,
            initialTheme.dark ? panelTheme.dark : panelTheme.light,
          ]),
        ]
      : [panelTheme.light]),
    EditorView.theme({
      ".cm-hx-block-cursor .cm-cursor": {
        display: "none !important",
      },
      ".cm-hx-block-cursor .cm-hx-cursor": {
        background: "#ccc",
      },
    }),
    panelStyles,
    ...(initialTheme ? [] : [panelTheme.light]),
    drawSelection({
      cursorBlinkRate: 0,
      drawRangeCursor: cursorShape === "bar",
    }),
    helixKeymap,
    modeField,
    initialHistory ? historyField.init(() => initialHistory) : historyField,
    initialRegisters
      ? registersField.init(() => initialRegisters)
      : registersField,
    initialRegistersHistory
      ? registersHistoryField.init(() => initialRegistersHistory)
      : registersHistoryField,
    searchFacet.from(registersField, (registers) => registers["/"]?.toString()),
    unhandledCommandsFilter,
    selectByClickFilter,
    expectingInputHandler,
    EditorState.allowMultipleSelections.of(true),
    EditorState.transactionFilter.from(syntaxHistoryField, ({ selections }) =>
      selections.length === 0
        ? letThrough
        : (tr) => {
            for (const effect of tr.effects) {
              if (effect.is(syntaxHistoryEffect)) {
                return tr;
              }
            }

            return [tr, { effects: syntaxHistoryEffect.of({ type: "reset" }) }];
          }
    ),
    EditorView.decorations.compute(["selection", "doc", modeField], (state) => {
      if (
        cursorShape === "bar" &&
        state.field(modeField).type === ModeType.Insert
      ) {
        return Decoration.set([]);
      }

      return drawCursorMark(state.selection, state.doc);
    }),
    modeUpdateListener,
    showPanel.of(statusPanel),
    showPanel.of(commandPanel),
    syntaxHistoryField,
    ViewPlugin.define((view) => {
      view.scrollDOM.classList.add("cm-hx-block-cursor");

      if (view.state.doc.length !== 0) {
        setTimeout(() => {
          view.dispatch({
            selection: EditorSelection.range(1, 0),
          });
        });
      }

      return {
        update(update) {
          const mode = update.state.field(modeField);
          const startMode = update.startState.field(modeField);

          const panel = getCommandPanel(view);

          if (
            (panel.hasMessage() && update.docChanged) ||
            update.selectionSet
          ) {
            panel.clearMessage();
          }

          const modeChanged = !sameMode(mode, startMode);

          if (modeChanged || !sameModeState(mode, startMode)) {
            panel.showMinor(mode);
          }

          if (modeChanged && cursorShape === "bar") {
            view.scrollDOM.classList.toggle(
              "cm-hx-block-cursor",
              mode.type !== ModeType.Insert
            );
          }
        },
      };
    }),
    commands.of([
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

          navigator.clipboard.writeText(
            view.state.doc.slice(selection.from, selection.to).toString()
          );

          return { message: "Yanked main selection to + register" };
        },
      },
      {
        name: "clear-register",
        help: "Clear given register. If no argument is provided, clear all registers",
        // FIXME: autocomplete
        handler(view, args) {
          if (args.length > 1) {
            return {
              message: `Expected at most 1 argument, got ${args.length}`,
              error: true,
            };
          }

          if (args.length === 0) {
            const registers = view.state.field(registersField);

            view.dispatch({
              effects: Object.keys(registers).map((reg) =>
                yankEffect.of([reg, []])
              ),
            });
          } else {
            // FIXME: not unicode length
            if (args[0].length > 1) {
              return { message: `invalid register ${args[0]}`, error: true };
            }

            view.dispatch({
              effects: yankEffect.of([args[0], []]),
            });
          }
        },
      },
      ...(options.themes != null && options.themes.length > 0
        ? [
            {
              name: "theme",
              help: "Change the editor theme (or show the current them if none specified)",
              autocomplete([_themeName, extra]) {
                if (extra) {
                  return [];
                }

                return [];

                // FIXME: implement autocomplete for successive arguments
                // return (
                //   options.themes?.flatMap((theme) =>
                //     theme.name.startsWith(themeName) ? [theme.name] : []
                //   ) ?? []
                // );
              },
              handler(view, args) {
                if (args.length > 1) {
                  return {
                    message: `Expected at most 1 argument, got ${args.length}`,
                    error: true,
                  };
                }

                if (args.length === 0) {
                  return { message: view.state.field(themeField) };
                }

                const theme = options.themes?.find(
                  (theme) => theme.name === args[0]
                );

                if (theme == null) {
                  return {
                    message: `Could not load theme ${args[0]}`,
                    error: true,
                  };
                }

                const currentThemeExtensions = themeCompartment.get(view.state);

                if (
                  Array.isArray(currentThemeExtensions) &&
                  currentThemeExtensions.includes(theme.extension)
                ) {
                  return;
                }

                view.dispatch({
                  effects: [
                    themeCompartment.reconfigure([
                      theme.extension,
                      theme.dark ? panelTheme.dark : panelTheme.light,
                    ]),
                    themeEffect.of(theme.name),
                  ],
                });

                view.state.facet(themeFacet).forEach((cb) => cb(theme));
              },
            } satisfies TypableCommand,
          ]
        : []),
    ]),
    commands.compute([externalCommandsFacet], (state) => {
      const externalCommands = state.facet(externalCommandsFacet);

      const hardcodedCommands: Array<[ExternalCommand, string, string[]]> = [
        [":buffer-next", "Goto next buffer", ["bn", "bnext"]],
        [":buffer-previous", "Goto previous buffer", ["bp", "bprev"]],
      ];

      const bufferClose = externalCommands[":buffer-close"]
        ? ({
            name: "buffer-close",
            aliases: ["bc", "bclose"],
            help: "Close the current buffer",
            autocomplete: externalCommands[":buffer-close"].autocomplete,
            handler(view, args) {
              const defs = view.state.facet(externalCommandsFacet);

              return defs[":buffer-close"]?.handler(args);
            },
          } satisfies TypableCommand)
        : undefined;

      return [
        ...hardcodedCommands
          .filter(([name]) => !!externalCommands[name])
          .map(([name, help, aliases]) => ({
            name: name.slice(1),
            aliases,
            help,
            handler(view: EditorView) {
              const defs = view.state.facet(externalCommandsFacet);

              return defs[name]?.();
            },
          })),
        ...(bufferClose ? [bufferClose] : []),
      ];
    }),
  ];
}

function commandPanel(view: EditorView) {
  return new CommandPanel(view, commands, (mode) => startSearch(view, mode));
}

function getCommandPanel(view: EditorView) {
  return getPanel(view, commandPanel) as CommandPanel;
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

function commitToHistory(view: EditorView, temp = false) {
  return {
    effects: historyEffect.of({
      type: "add",
      state: view.state,
      temp,
    }),
  };
}

function showSearchError(view: EditorView, query: SearchQuery) {
  let message = "";

  try {
    query.getCursor(view.state);
  } catch (error: any) {
    message = error?.message;
  }

  getCommandPanel(view).showError(
    `Invalid regex /${query.search}/: ${message}`
  );
}

function resetScroll(view: EditorView, effect: StateEffect<any>) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      view.dispatch({ effects: effect });
    })
  );
}

function escapeRegex(text: string) {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

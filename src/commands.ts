import { Command, EditorView } from "@codemirror/view";
import { MinorMode, ModeType, NonInsertMode, NormalLikeMode } from "./entities";
import {
  EditorSelection,
  EditorState,
  SelectionRange,
  Text,
  findClusterBreak,
} from "@codemirror/state";
import { modeEffect, modeField } from "./state";
import { matchBrackets, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { cursorLineStart, selectLineStart } from "@codemirror/commands";

type ViewLike = {
  state: EditorState;
  dispatch: EditorView["dispatch"];
};

export type ViewProxy = ViewLike & { original: EditorView };

export const MODE_EFF = {
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
  NORMAL_SPACE: modeEffect.of({
    type: ModeType.Normal,
    minor: MinorMode.Space,
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
  SELECT_SPACE: modeEffect.of({
    type: ModeType.Select,
    minor: MinorMode.Space,
  }),
  INSERT: modeEffect.of({ type: ModeType.Insert }),
};

function moveByChar(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const initial = view.state.selection.main;
  const select = mode.type === ModeType.Select;

  const next = select
    ? selectByChar(view, mode, forward)
    : cursorByChar(view, mode, forward);

  if (initial.eq(next)) {
    return false;
  }

  view.dispatch({
    selection: next,
    effects: resetCount(mode),
    scrollIntoView: true,
  });

  return true;
}

export function withHelixSelection(view: EditorView, command: Command) {
  view.dispatch({
    selection: cmSelToInternal(view.state.selection.main, view.state.doc),
  });

  const result = command(view);

  view.dispatch({
    selection: internalSelToCM(view.state.selection.main, view.state.doc),
  });

  return result;
}

export function cmSelToInternal(range: SelectionRange, doc: Text) {
  if (range.empty) {
    return range;
  }

  const end = nextClusterBreak(doc, range.to, false);
  const [anchor, head] = rangeForward(range)
    ? [range.from, end]
    : [end, range.from];

  return EditorSelection.range(
    anchor,
    head,
    range.goalColumn,
    range.bidiLevel ?? undefined
  );
}

export function internalSelToCM(range: SelectionRange, doc: Text) {
  const end = nextClusterBreak(doc, range.to, true);
  const [anchor, head] = rangeForward(range)
    ? [range.from, end]
    : [end, range.from];

  return EditorSelection.range(
    anchor,
    head,
    range.goalColumn,
    range.bidiLevel ?? undefined
  );
}

export function cursorToLineStart(view: EditorView, mode: NonInsertMode) {
  const isNormal = mode.type === ModeType.Normal;

  withHelixSelection(view, (view) =>
    isNormal ? cursorLineStart(view) : selectLineStart(view)
  );

  view.dispatch({
    effects: isNormal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
  });
}

export function cursorToLineEnd(view: EditorView, mode: NonInsertMode) {
  const select = mode.type === ModeType.Select;

  const selection = cmSelToInternal(view.state.selection.main, view.state.doc);

  const line = view.state.doc.lineAt(selection.head);

  if (line.length === 0) {
    return false;
  }

  const goal = nextClusterBreak(view.state.doc, line.to, false);

  const next = select
    ? EditorSelection.range(selection.anchor, goal, selection.goalColumn)
    : EditorSelection.cursor(goal, undefined, undefined, selection.goalColumn);

  view.dispatch({
    selection: internalSelToCM(next, view.state.doc),
    effects: select ? MODE_EFF.SELECT : MODE_EFF.NORMAL,
  });

  return true;
}

function cursorByChar(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);
  const selection = view.state.selection.main;

  let counter = count;

  const by =
    count > 1
      ? () => () => {
          counter--;

          return counter > 0;
        }
      : undefined;

  const cursor = cmSelToInternal(selection, doc).head;

  const moved = view.moveByChar(EditorSelection.cursor(cursor), forward, by);

  return internalSelToCM(EditorSelection.cursor(moved.head), doc);
}

function selectByChar(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);

  const initial = cmSelToInternal(view.state.selection.main, doc);

  let counter = count;

  const by =
    count > 1
      ? () => () => {
          counter--;

          return counter > 0;
        }
      : undefined;

  const next = view.moveByChar(
    EditorSelection.cursor(initial.head),
    forward,
    by
  );

  return internalSelToCM(EditorSelection.range(initial.anchor, next.head), doc);
}

function selectByLine(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);
  const initial = cmSelToInternal(view.state.selection.main, doc);
  let selection = initial;

  for (let _i = 0; _i < count; _i++) {
    selection = view.moveVertically(
      EditorSelection.cursor(
        selection.head,
        undefined,
        undefined,
        selection.goalColumn
      ),
      forward
    );
  }

  return internalSelToCM(
    EditorSelection.range(initial.anchor, selection.head, selection.goalColumn),
    doc
  );
}

function cursorByLine(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);
  const initial = view.state.selection.main;

  const selection = cmSelToInternal(initial, doc);
  let cursor = selection.head;
  let goalColumn = selection.goalColumn;

  for (let _i = 0; _i < count; _i++) {
    const line = doc.lineAt(cursor).number;

    if ((forward && line === doc.lines) || (!forward && line === 1)) {
      break;
    }

    const next = view.moveVertically(
      EditorSelection.cursor(cursor, undefined, undefined, goalColumn),
      forward
    );

    cursor = next.to;
    goalColumn = next.goalColumn;
  }

  return internalSelToCM(
    EditorSelection.cursor(cursor, undefined, undefined, goalColumn),
    doc
  );
}

export function moveByHalfPage(
  view: EditorView,
  mode: NonInsertMode,
  forward: boolean
) {
  const select = mode.type === ModeType.Select;

  const next = select
    ? selectByHalfPage(view, forward)
    : cursorByHalfPage(view, forward);

  if (next.eq(view.state.selection.main)) {
    return false;
  }

  view.dispatch({
    selection: EditorSelection.create([next]),
    scrollIntoView: true,
  });
}

function cursorByHalfPage(view: EditorView, forward: boolean) {
  const doc = view.state.doc;
  const selection = cmSelToInternal(view.state.selection.main, doc);

  const lineBlock = view.lineBlockAt(doc.lineAt(selection.head).from);
  const end = view.lineBlockAt(forward ? doc.length : 0);

  const height = Math.min(
    view.scrollDOM.clientHeight / 2,
    Math.abs(lineBlock.top - end.top)
  );

  if (height < 1) {
    return view.state.selection.main;
  }

  const next = view.moveVertically(
    EditorSelection.cursor(
      selection.head,
      undefined,
      undefined,
      selection.goalColumn
    ),
    forward,
    height
  );

  return internalSelToCM(next, doc);
}

function selectByHalfPage(view: EditorView, forward: boolean) {
  const doc = view.state.doc;
  const selection = cmSelToInternal(view.state.selection.main, doc);

  const lineBlock = view.lineBlockAt(doc.lineAt(selection.head).from);
  const end = view.lineBlockAt(forward ? doc.length : 0);

  const height = Math.min(
    view.scrollDOM.clientHeight / 2,
    Math.abs(lineBlock.top - end.top)
  );

  if (height < 1) {
    return view.state.selection.main;
  }

  const next = view.moveVertically(
    EditorSelection.cursor(
      selection.head,
      undefined,
      undefined,
      selection.goalColumn
    ),
    forward,
    height
  );

  return internalSelToCM(
    EditorSelection.range(selection.anchor, next.head, next.goalColumn),
    doc
  );
}

function moveByLine(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const select = mode.type === ModeType.Select;
  const initial = view.state.selection.main;

  const next = select
    ? selectByLine(view, mode, forward)
    : cursorByLine(view, mode, forward);

  if (initial.eq(next)) {
    return false;
  }

  view.dispatch({
    selection: EditorSelection.create([next]),
    effects: resetCount(mode),
    scrollIntoView: true,
  });

  return true;
}

export function moveDown(view: EditorView, mode: NonInsertMode) {
  return moveByLine(view, mode, true);
}

export function moveUp(view: EditorView, mode: NonInsertMode) {
  return moveByLine(view, mode, false);
}

export function moveLeft(view: EditorView, mode: NonInsertMode) {
  moveByChar(view, mode, false);
}

export function moveRight(view: EditorView, mode: NonInsertMode) {
  moveByChar(view, mode, true);
}

export function setFindMode(
  view: EditorView,
  status: string,
  mode: NormalLikeMode,
  metadata: { inclusive: boolean; forward: boolean }
) {
  const effect = modeEffect.of({
    type: mode.type,
    minor: MinorMode.Normal,
    count: mode.count,
    expecting: {
      minor: status,
      callback: findText,
      metadata,
    },
  });

  view.dispatch({ effects: effect });
}

function findText(
  view: EditorView,
  text: string,
  {
    inclusive,
    forward,
  }: {
    inclusive: boolean;
    forward: boolean;
  }
) {
  const mode = view.state.field(modeField);
  const count = mode.type === ModeType.Insert ? 1 : cmdCount(mode);
  const select = mode.type === ModeType.Select;
  const selection = cmSelToInternal(view.state.selection.main, view.state.doc);
  const doc = view.state.doc;

  const start = selection.head;

  const docString = doc.sliceString(0);

  let rawIndex = start;

  for (let _i = 0; _i < count; _i++) {
    if (!forward && rawIndex === 0) {
      rawIndex = -1;
      break;
    }

    rawIndex = forward
      ? docString.indexOf(text, rawIndex + 1)
      : docString.lastIndexOf(text, rawIndex - 1);

    if (rawIndex < 0) {
      break;
    }
  }

  const resetEffect = select ? MODE_EFF.SELECT : MODE_EFF.NORMAL;

  if (rawIndex === -1) {
    view.dispatch({
      effects: resetEffect,
    });

    return;
  }

  const index = inclusive ? rawIndex : forward ? rawIndex - 1 : rawIndex + 1;

  const newSelection = select
    ? EditorSelection.range(selection.anchor, index)
    : EditorSelection.range(selection.head, index);

  view.dispatch({
    effects: resetEffect,
    selection: internalSelToCM(newSelection, doc),
  });
}

export function moveToSibling(view: EditorView, forward: boolean) {
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

export function matchBracket(view: EditorView) {
  const selection = view.state.selection.main;

  const char = view.state.doc.sliceString(selection.head, selection.head + 1);

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

export function surround(view: EditorView, char: string, proxy: ViewProxy) {
  const pair = PAIRS[char];

  const selection = view.state.selection.main;

  const open = pair?.[0] ?? char;
  const close = pair?.[1] ?? char;

  view.dispatch({
    changes: [
      {
        from: selection.from,
        insert: open,
      },
      {
        from: selection.to,
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

export function replaceWithChar(_: EditorView, char: string, view: ViewLike) {
  const selection = view.state.selection.main;
  const selected = view.state.doc.sliceString(selection.from, selection.to);

  let len = 0;
  let offset = 0;

  while (true) {
    const next = findClusterBreak(selected, offset, true);

    if (next === offset) {
      break;
    }

    offset = next;
    len++;
  }

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: char.repeat(len),
    },
    effects: MODE_EFF.NORMAL,
  });
}

export function changeCase(view: ViewLike, upper?: boolean) {
  const selection = view.state.selection.main;
  const selected = view.state.doc.sliceString(selection.from, selection.to);

  let insert;

  if (upper == null) {
    insert = [...selected]
      .map((char) => {
        let next = char.toUpperCase();

        return next === char ? char.toLowerCase() : next;
      })
      .join("");
  } else if (upper) {
    insert = selected.toUpperCase();
  } else {
    insert = selected.toLowerCase();
  }

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert,
    },
  });
}

export function paste(
  view: ViewLike,
  yanked: string | Text | undefined,
  before: boolean,
  count: number,
  reset = true
) {
  const range = view.state.selection.main;

  yanked ??= "";

  const spec = { from: range.to, insert: yanked.toString().repeat(count) };

  const change = view.state.changes(spec);

  view.dispatch(
    { changes: change },
    {
      selection: before
        ? { anchor: range.to, head: range.to + yanked.length }
        : { anchor: range.from, head: range.from + yanked.length },
      sequential: true,
    },
    reset ? { effects: MODE_EFF.NORMAL } : {}
  );
}

export function insertLineAndEdit(view: ViewLike, below: boolean) {
  let from: number;
  let cursor: number;

  if (below) {
    const line = view.state.doc.lineAt(view.state.selection.main.to);

    from = line.to;
    cursor = from + view.state.lineBreak.length;
  } else {
    const line = view.state.doc.lineAt(view.state.selection.main.from);

    from = line.from;
    cursor = from;
  }

  view.dispatch({
    changes: {
      from,
      insert: view.state.lineBreak,
    },
    selection: EditorSelection.cursor(cursor),
    effects: MODE_EFF.INSERT,
  });
}

export function cmdCount(mode: NonInsertMode) {
  return mode.count ?? 1;
}

export function resetCount(mode: NonInsertMode) {
  const { count: _count, ...rest } = mode;

  return modeEffect.of(rest);
}

function rangeForward(range: SelectionRange) {
  return range.head > range.from;
}

export function atomicRange(range: SelectionRange, doc: Text) {
  const len = range.to - range.from;

  if (len <= 1) {
    return true;
    // FIXME: this is not quite correct, it is not aligned with `findClusterBreak()`
  } else if (len === 2) {
    const charCode = doc.sliceString(range.from, range.to).charCodeAt(0);

    return charCode >= 0xd800 && charCode <= 0xdfff;
  } else {
    return false;
  }
}

export function rangeLen(range: SelectionRange) {
  return range.to - range.from;
}

export function cloneRange(
  range: SelectionRange,
  override: Partial<SelectionRange>
) {
  return EditorSelection.range(
    override.anchor ?? range.anchor,
    override.head ?? range.head,
    override.goalColumn ?? range.goalColumn,
    override.bidiLevel ?? range.bidiLevel ?? undefined
  );
}

function nextClusterBreak(doc: Text, pos: number, forward: boolean) {
  if ((!forward && pos === 0) || (forward && pos === doc.length)) {
    return pos;
  }

  const line = doc.lineAt(pos);

  // this assumes non-crazy line-breaks
  if (forward && line.to === pos) {
    return pos + 1;
  } else if (!forward && line.from === pos) {
    return pos - 1;
  }

  return findClusterBreak(line.text, pos - line.from, forward) + line.from;
}

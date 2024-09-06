import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
  cursorLineUp,
  selectCharLeft,
  selectCharRight,
  selectLineDown,
  selectLineUp,
} from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { MinorMode, ModeType, NonInsertMode, NormalLikeMode } from "./entities";
import {
  EditorSelection,
  EditorState,
  SelectionRange,
  Text,
} from "@codemirror/state";
import { modeEffect, modeField } from "./state";
import { matchBrackets, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

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

export function moveBy(
  view: EditorView,
  mode: NonInsertMode,
  cursor: (view: EditorView) => void,
  select: (view: EditorView) => void
) {
  let count = cmdCount(mode);

  if (mode.type === ModeType.Select) {
    for (let _i = 0; _i < count; _i++) {
      select(view);
    }
  } else {
    const selection = view.state.selection.main;

    if (selection.from !== selection.to) {
      view.dispatch({
        selection: EditorSelection.cursor(selection.head),
      });
    }

    for (let _i = 0; _i < count; _i++) {
      cursor(view);
    }
  }

  if (mode.count) {
    view.dispatch({
      effects: resetCount(mode),
    });
  }
}

export function moveDown(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorLineDown, selectLineDown);
}

export function moveUp(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorLineUp, selectLineUp);
}

export function moveLeft(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorCharLeft, selectCharLeft);
}

export function moveRight(view: EditorView, mode: NonInsertMode) {
  moveBy(view, mode, cursorCharRight, selectCharRight);
}

export function setFindMode(
  view: EditorView,
  status: string,
  mode: NormalLikeMode,
  metadata: { inclusive: boolean; reverse: boolean }
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
    reverse,
  }: {
    inclusive: boolean;
    reverse: boolean;
  }
) {
  const mode = view.state.field(modeField);
  const count = mode.type === ModeType.Insert ? 1 : cmdCount(mode);
  const select = mode.type === ModeType.Select;
  const selection = view.state.selection.main;

  const start = selection.head;

  const doc = view.state.doc.toString();

  let rawIndex = start;

  for (let _i = 0; _i < count; _i++) {
    if (reverse && rawIndex === 0) {
      rawIndex = -1;
      break;
    }

    rawIndex = reverse
      ? doc.lastIndexOf(text, rawIndex - 1)
      : doc.indexOf(text, rawIndex + 1);

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

  const index = inclusive ? rawIndex : reverse ? rawIndex + 1 : rawIndex - 1;

  const newSelection = select
    ? EditorSelection.range(selection.anchor, index)
    : EditorSelection.range(selection.head, index);

  view.dispatch({
    effects: resetEffect,
    selection: newSelection,
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

export function surround(view: EditorView, char: string, proxy: ViewProxy) {
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

export function replaceWithChar(_: EditorView, char: string, view: ViewLike) {
  const selection = view.state.selection.main;
  const selected = view.state.doc.slice(selection.from, selection.to);

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: selected.toString().replace(/[^\n]/g, char),
    },
    effects: MODE_EFF.NORMAL,
  });
}

export function changeCase(view: ViewLike, upper?: boolean) {
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

// TODO: fix selection ranges
export function helixSelection(range: SelectionRange, doc: Text) {
  const to = Math.min(range.to + 1, doc.length);

  const forward = range.head >= range.anchor;

  const anchor = forward ? range.anchor : to;
  const head = forward ? to : range.head;

  return EditorSelection.range(anchor, head);
}

export function cmdCount(mode: NonInsertMode) {
  return mode.count ?? 1;
}

export function resetCount(mode: NonInsertMode) {
  const { count: _count, ...rest } = mode;

  return modeEffect.of(rest);
}

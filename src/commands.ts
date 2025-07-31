import { Command, EditorView } from "@codemirror/view";
import { MinorMode, ModeType, NonInsertMode, NormalLikeMode } from "./entities";
import {
  EditorSelection,
  EditorState,
  SelectionRange,
  Text,
  findClusterBreak,
} from "@codemirror/state";
import { modeEffect, modeField, yankEffect } from "./state";
import { matchBrackets, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { cursorLineStart, selectLineStart } from "@codemirror/commands";
import { SearchQuery } from "@codemirror/search";

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
  SELECT: modeEffect.of({
    type: ModeType.Select,
    minor: MinorMode.Normal,
  }),
  INSERT: modeEffect.of({ type: ModeType.Insert }),
};

function moveByChar(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const select = mode.type === ModeType.Select;

  const next = select
    ? selectByChar(view, mode, forward)
    : cursorByChar(view, mode, forward);

  if (view.state.selection.eq(next)) {
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
    selection: mapSel(view.state.selection, (range) =>
      cmSelToInternal(range, view.state.doc)
    ),
  });

  const result = command(view);

  view.dispatch({
    selection: mapSel(view.state.selection, (range) =>
      internalSelToCM(range, view.state.doc)
    ),
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

export function removeText(
  view: ViewLike,
  { yank, edit }: { yank?: boolean; edit?: boolean } = {}
) {
  const effects = [];

  yank ??= true;

  if (yank) {
    effects.push(
      yankEffect.of([
        `"`,
        view.state.selection.ranges.map((range) =>
          view.state.doc.slice(range.from, range.to)
        ),
      ])
    );
  }

  if (edit) {
    effects.push(MODE_EFF.INSERT);
  }

  view.dispatch({
    effects,
    changes: view.state.selection.ranges.map((range) => ({
      from: range.from,
      to: range.to,
      insert: "",
    })),
  });

  if (!edit && view.state.selection.ranges.some((range) => range.empty)) {
    view.dispatch({
      selection: mapSel(view.state.selection, (range) =>
        internalSelToCM(range, view.state.doc)
      ),
    });
  }
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

function cursorToLineEndRange(
  range: SelectionRange,
  view: EditorView,
  select: boolean
) {
  const selection = cmSelToInternal(range, view.state.doc);

  const line = view.state.doc.lineAt(selection.head);

  if (line.length === 0) {
    return selection;
  }

  const goal = nextClusterBreak(view.state.doc, line.to, false);

  return select
    ? EditorSelection.range(selection.anchor, goal, selection.goalColumn)
    : EditorSelection.cursor(goal, undefined, undefined, selection.goalColumn);
}

export function cursorToLineEnd(view: EditorView, mode: NonInsertMode) {
  const select = mode.type === ModeType.Select;

  view.dispatch({
    selection: mapSel(view.state.selection, (range) =>
      internalSelToCM(cursorToLineEndRange(range, view, select), view.state.doc)
    ),
    effects: select ? MODE_EFF.SELECT : MODE_EFF.NORMAL,
  });

  return true;
}

function cursorByChar(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);

  return mapSel(view.state.selection, (range) => {
    let counter = count;

    const by =
      count > 1
        ? () => () => {
            counter--;

            return counter > 0;
          }
        : undefined;

    const cursor = cmSelToInternal(range, doc).head;

    const moved = view.moveByChar(EditorSelection.cursor(cursor), forward, by);

    return internalSelToCM(EditorSelection.cursor(moved.head), doc);
  });
}

function selectByChar(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);

  return mapSel(view.state.selection, (range) => {
    const initial = cmSelToInternal(range, doc);

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

    return internalSelToCM(
      EditorSelection.range(initial.anchor, next.head),
      doc
    );
  });
}

function selectByLine(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);

  return mapSel(view.state.selection, (range) => {
    const initial = cmSelToInternal(range, doc);
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
      EditorSelection.range(
        initial.anchor,
        selection.head,
        selection.goalColumn
      ),
      doc
    );
  });
}

function cursorByLine(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const doc = view.state.doc;
  const count = cmdCount(mode);

  return mapSel(view.state.selection, (range) => {
    const selection = cmSelToInternal(range, doc);
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
  });
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

  if (next.eq(view.state.selection)) {
    return false;
  }

  view.dispatch({
    selection: next,
    scrollIntoView: true,
  });
}

function cursorByHalfPage(view: EditorView, forward: boolean) {
  return mapSel(view.state.selection, (range) => {
    const doc = view.state.doc;
    const selection = cmSelToInternal(range, doc);

    const lineBlock = view.lineBlockAt(doc.lineAt(selection.head).from);
    const end = view.lineBlockAt(forward ? doc.length : 0);

    const height = Math.min(
      view.scrollDOM.clientHeight / 2,
      Math.abs(lineBlock.top - end.top)
    );

    if (height < 1) {
      return range;
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
  });
}

function selectByHalfPage(view: EditorView, forward: boolean) {
  return mapSel(view.state.selection, (range) => {
    const doc = view.state.doc;
    const selection = cmSelToInternal(range, doc);

    const lineBlock = view.lineBlockAt(doc.lineAt(selection.head).from);
    const end = view.lineBlockAt(forward ? doc.length : 0);

    const height = Math.min(
      view.scrollDOM.clientHeight / 2,
      Math.abs(lineBlock.top - end.top)
    );

    if (height < 1) {
      return range;
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
  });
}

function moveByLine(view: EditorView, mode: NonInsertMode, forward: boolean) {
  const select = mode.type === ModeType.Select;

  const next = select
    ? selectByLine(view, mode, forward)
    : cursorByLine(view, mode, forward);

  if (view.state.selection.eq(next)) {
    return false;
  }

  view.dispatch({
    selection: next,
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
  const select = mode.type === ModeType.Select;
  const resetEffect = select ? MODE_EFF.SELECT : MODE_EFF.NORMAL;
  const count = mode.type === ModeType.Insert ? 1 : cmdCount(mode);

  const newSelection = mapSel(view.state.selection, (range) => {
    const selection = cmSelToInternal(range, view.state.doc);
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

    if (rawIndex === -1) {
      return range;
    }

    const index = inclusive ? rawIndex : forward ? rawIndex - 1 : rawIndex + 1;

    const next = select
      ? EditorSelection.range(selection.anchor, index)
      : EditorSelection.range(selection.head, index);

    return internalSelToCM(next, doc);
  });

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
  return view.state.selection.ranges.map((range) => {
    const internal = cmSelToInternal(range, view.state.doc);
    const collapsed = internalSelToCM(
      EditorSelection.range(internal.head, internal.head),
      view.state.doc
    );

    const char = view.state.doc.sliceString(collapsed.from, collapsed.to);

    if (!MATCHEABLE.has(char)) {
      // TODO: find surrounding pair

      return null;
    }

    const open = PAIRS[char]?.[2] ?? false;
    const match = matchBrackets(
      view.state,
      collapsed.head + (open ? 0 : 1),
      open ? 1 : -1
    );

    if (match) {
      return match.end;
    }
  });
}

export function surround(view: EditorView, char: string) {
  const pair = PAIRS[char];

  const open = pair?.[0] ?? char;
  const close = pair?.[1] ?? char;
  const offset = open.length + close.length;

  const tr = view.state.changeByRange((range) => {
    const [anchor, head] =
      rangeForward(range) || range.empty
        ? [range.anchor, range.head + offset]
        : [range.anchor + offset, range.head];

    return {
      range: EditorSelection.range(anchor, head),
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
    };
  });

  view.dispatch(tr, { effects: MODE_EFF.NORMAL });
}

export function extendToDelimiters(
  view: EditorView,
  char: string,
  inclusive: boolean
) {
  const mode = view.state.field(modeField);
  const pair = PAIRS[char];

  const open = pair?.[0] ?? char;
  const close = pair?.[1] ?? char;

  const query = new SearchQuery({
    search: `${escape(open)}|${escape(close)}`,
    regexp: true,
  });

  const ranges = view.state.selection.ranges.map((range) => {
    const cursor = query.getCursor(view.state, range.head);

    let dir: 1 | -1 = 1;
    let next = cursor.next();

    if (next.done) {
      return range;
    }

    if (
      open !== close &&
      view.state.sliceDoc(next.value.from, next.value.to) === open
    ) {
      const cursor = query.getCursor(view.state, 0, range.head);

      let nextOpen: ReturnType<typeof cursor["next"]> | undefined;

      while (true) {
        const next = cursor.next();

        if (next.done) {
          break;
        }

        nextOpen = {
          done: false,
          value: next.value,
        };
      }

      if (
        !nextOpen ||
        nextOpen?.done ||
        view.state.sliceDoc(nextOpen.value.from, nextOpen.value.to) === close
      ) {
        return range;
      }

      dir = -1;
      next = nextOpen;
    }

    // FIXME: does not handle quotes, etc. b/c relies on syntax
    const match = matchBrackets(
      view.state,
      dir > 0 ? next.value.to : next.value.from,
      -dir as 1 | -1
    );

    if (!match?.end) {
      return range;
    }

    let [start, end] =
      dir > 0 ? [match.end, next.value] : [next.value, match.end];

    if (!inclusive) {
      const startTo = nextClusterBreak(view.state.doc, start.to, true);
      start = { from: start.to, to: startTo };

      const endFrom = nextClusterBreak(view.state.doc, end.from, false);
      end = { from: endFrom, to: end.from };
    }

    const [anchor, head] =
      rangeForward(range) || atomicRange(range, view.state.doc)
        ? [start.from, end.to]
        : [end.to, start.from];

    return EditorSelection.range(anchor, head);
  });

  view.dispatch({
    selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
    effects: mode.type === ModeType.Normal ? MODE_EFF.NORMAL : MODE_EFF.SELECT,
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
  view.dispatch(
    view.state.changeByRange((range) => {
      const selected = view.state.doc.sliceString(range.from, range.to);

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

      return {
        range,
        changes: {
          from: range.from,
          to: range.to,
          insert,
        },
      };
    })
  );
}

export function yanksForSelection(
  selection: EditorSelection,
  yank: Array<string | Text>
) {
  if (selection.ranges.length === yank.length) {
    return yank;
  }

  if (selection.ranges.length < yank.length) {
    return yank.slice(0, selection.ranges.length);
  }

  const last = yank.at(-1) ?? "";

  const copy = [...yank];

  for (let i = yank.length; i < selection.ranges.length; i++) {
    copy[i] = last;
  }

  return copy;
}
export function yank(view: EditorView, mode: NonInsertMode, register?: string) {
  const { selection } = view.state;

  register ??= mode.register ?? `"`;

  view.dispatch({
    effects: [
      yankEffect.of([
        register,
        selection.ranges.map((range) =>
          view.state.doc.slice(range.from, range.to)
        ),
      ]),
      MODE_EFF.NORMAL,
    ],
  });

  const total = selection.ranges.length;

  return `yanked ${
    total === 1 ? "1 selection" : `${total} selections`
  } to register ${register}`;
}

export function paste(
  view: ViewLike,
  yanked: Array<string | Text> | undefined,
  before: boolean,
  count: number,
  { reset = true, select = true } = {}
) {
  const { selection } = view.state;

  yanked ??= [""];

  const yanks = yanksForSelection(selection, yanked);

  const specs = yanks.map((yank, i) => ({
    from: before ? selection.ranges[i].from : selection.ranges[i].to,
    insert: yank.toString().repeat(count),
  }));

  const { ranges } = yanks.reduce(
    (acc, yank, i) => {
      let length = yank.length;
      let range = selection.ranges[i];
      const anchor = (before ? range.from : range.to) + acc.offset;

      acc.ranges.push(
        select
          ? EditorSelection.range(anchor, anchor + length)
          : EditorSelection.cursor(anchor + length)
      );
      acc.offset += length;

      return acc;
    },
    {
      ranges: [] as SelectionRange[],
      offset: 0,
    }
  );

  const change = view.state.changes(specs);

  view.dispatch(
    { changes: change },
    {
      selection: EditorSelection.create(ranges, selection.mainIndex),
      sequential: true,
    },
    reset ? { effects: MODE_EFF.NORMAL } : {}
  );
}

export function changeNumber(view: ViewLike, increase: boolean) {
  const re = /-?\d+/;

  view.dispatch(
    view.state.changeByRange((range) => {
      const str = view.state.doc.sliceString(range.from, range.to);

      if (!re.test(str)) {
        return {
          range,
        };
      }

      const parsed = Number(str);
      const insert = String(parsed + (increase ? 1 : -1));

      return {
        range:
          insert.length === str.length
            ? range
            : EditorSelection.range(range.from, range.from + insert.length),
        changes: {
          from: range.from,
          to: range.to,
          insert,
        },
      };
    })
  );
}

export function openLine(view: ViewLike, below: boolean) {
  let from: number;
  let cursor: number;

  // FIXME: consider multiple selections
  const selection = cmSelToInternal(view.state.selection.main, view.state.doc);

  if (below) {
    const line = view.state.doc.lineAt(selection.to);

    from = line.to;
    cursor = from + view.state.lineBreak.length;
  } else {
    const line = view.state.doc.lineAt(selection.from);

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

export const countCommands = Object.fromEntries(
  Array.from({ length: 10 }, (_, count) => [
    String(count),
    (view: EditorView, mode: NonInsertMode) => {
      const next = mode.count != null ? mode.count * 10 + count : count;

      if (next === 0) {
        return;
      }

      view.dispatch({
        effects: modeEffect.of({ ...mode, count: next }),
      });
    },
  ])
);

export function insertLine(view: ViewLike, below: boolean) {
  const mode = view.state.field(modeField);

  const count = mode.type === ModeType.Insert ? 1 : cmdCount(mode);
  const select = mode.type === ModeType.Select;

  // FIXME: handle multiple selections
  const selection = view.state.selection.main;

  const line = view.state.doc.lineAt(below ? selection.to : selection.from);

  const changes = {
    from: below ? line.to : line.from,
    insert: view.state.lineBreak.repeat(count),
  };

  const resetEffect = select ? MODE_EFF.SELECT : MODE_EFF.NORMAL;

  view.dispatch({ changes, effects: resetEffect });
}

export function rotateSelection(view: EditorView, forward: boolean) {
  const { selection } = view.state;

  if (selection.ranges.length === 1) {
    return true;
  }

  const mainIndex =
    (selection.mainIndex + (forward ? 1 : -1)) % selection.ranges.length;

  view.dispatch({
    selection: EditorSelection.create(
      selection.ranges,
      mainIndex + (mainIndex < 0 ? selection.ranges.length : 0)
    ),
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

export function fixAtomicRange(range: SelectionRange, doc: Text) {
  if (rangeForward(range) || !atomicRange(range, doc)) {
    return range;
  }

  return cloneRange(range, {
    anchor: range.head,
    head: range.anchor,
  });
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

export function mapSel(
  selection: EditorSelection,
  mapper: (range: SelectionRange) => SelectionRange
) {
  if (selection.ranges.length === 1) {
    const mapped = mapper(selection.main);

    return EditorSelection.single(mapped.anchor, mapped.head);
  }

  return EditorSelection.create(
    selection.ranges.map(mapper),
    selection.mainIndex
  );
}

function escape(source: string) {
  return (RegExp as any).escape(source) as string;
}

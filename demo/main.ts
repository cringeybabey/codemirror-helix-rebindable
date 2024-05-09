import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, lineNumbers } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { helix } from "../src/lib";
import { historyField, modeField, registerField } from "../src/state";
import { getSearchQuery } from "@codemirror/search";
import { MinorMode, ModeState, ModeType } from "../src/entities";

const modeElement = document.querySelector("#mode")!;
const searchElement = document.querySelector("#search")!;
const rangeElement = document.querySelector("#range")!;
const registerElement = document.querySelector("#register")!;
const historyElement = document.querySelector("#history")!;

const source =
  process.env.NODE_ENV === "development"
    ? // @ts-ignore
      import("../src/lib.ts?raw")
    : // @ts-ignore
      import("./main.ts?raw");

const debugPlugin = ViewPlugin.define((view) => ({
  update(_viewUpdate) {
    modeElement.textContent = `${modeToString(
      view.state.field(modeField) as any
    )}`;

    registerElement.textContent = JSON.stringify(
      view.state.field(registerField)
    ).replace(/^"|"$/g, "");

    const selection = view.state.selection.main;
    rangeElement.textContent = `${selection.from} ${
      selection.anchor <= selection.head ? "➡️" : "⬅️"
    } ${selection.to}`;

    searchElement.textContent = getSearchQuery(view.state).search;

    const history = view.state.field(historyField);
    historyElement.textContent = `history: ${
      history.checkpoints.length
    } cursor: ${
      history.cursor
    } head: ${!!history.head} pending: ${!!history.pending}`;
  },
}));

const view = new EditorView({
  state: EditorState.create({
    doc: (await source).default,
    extensions: [
      helix(),
      debugPlugin.extension,
      syntaxHighlighting(defaultHighlightStyle),
      javascript({
        typescript: true,
      }),
      lineNumbers(),
    ],
  }),
  extensions: [],
  parent: document.querySelector("#editor")!,
});

view.focus();

(window as any).view = view;

document.querySelector<HTMLElement>("#debug")!.style.display = "block";

function modeToString(mode: ModeState) {
  switch (mode.type) {
    case ModeType.Select:
    case ModeType.Normal: {
      const modeStr = mode.type === ModeType.Normal ? "NOR" : "SEL";

      switch (mode.minor) {
        case MinorMode.Normal: {
          return modeStr;
        }
        case MinorMode.Goto: {
          return `${modeStr} (go)`;
        }
        case MinorMode.Match: {
          return `${modeStr} (match)`;
        }
      }
      break;
    }
    case ModeType.Insert: {
      return "INS";
    }
  }

  throw new Error("Invalid mode");
}

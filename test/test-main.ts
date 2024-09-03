import { EditorView } from "@codemirror/view";
import { helix } from "../";
import { EditorState } from "@codemirror/state";

declare global {
  interface Window {
    view?: EditorView;
    initEditor(doc: string): void;
  }
}

let view: EditorView | null = null;

function initEditor(doc: string) {
  view = new EditorView({
    doc,
    parent: document.querySelector("#editor")!,
    extensions: [helix()],
  });

  view.focus();

  window.view = view;
}

window.initEditor = initEditor;

window.onerror = (_event, _source, _lineno, _colno, error) => {
  view?.setState(
    EditorState.create({
      doc: JSON.stringify(
        {
          message: error?.message,
          stack: error?.stack,
          nonce: Math.random(),
        },
        null,
        2
      ),
    })
  );
};

const ready = document.createElement("span");
ready.classList.add("ready");

document.body.append(ready);

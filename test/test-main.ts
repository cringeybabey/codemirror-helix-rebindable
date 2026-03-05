import { EditorView } from "@codemirror/view";
import { helix } from "../";
import { EditorState, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";

declare global {
  interface Window {
    view?: EditorView;
    initEditor(doc: string, lang: string | null): void;
  }
}

const languages: Record<string, () => Extension> = {
  js: javascript,
};

let view: EditorView | null = null;

function initEditor(doc: string, lang: string | null) {
  const language = lang != null ? languages[lang] : null;

  view = new EditorView({
    doc,
    parent: document.querySelector("#editor")!,
    extensions: [helix(), ...(language ? [language()] : [])],
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

# codemirror-helix

A [Codemirror](https://codemirror.net/) plugin for [Helix](https://helix-editor.com/) keybindings and general UX.

## Installation

```
npm install codemirror-helix
```

## How to

```typescript
import { EditorView } from "@codemirror/view";
import { helix, commandFacet } from "codemirror-helix";

const customCommands = commandFacet.of([
  {
    name: "save",
    aliases: ["s", "sv"],
    help: "Save the document to the cloud",
    handler(view, args) {
      saveDocumentToCloud(view.state.doc.toString());
    },
  },
]);

const view = new EditorView({
  doc: "",
  extensions: [helix(), customCommands],
  parent: document.querySelector("#editor"),
});
```

## License

[Mozilla Public License 2.0](LICENSE)

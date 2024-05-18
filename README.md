# codemirror-helix

A [Codemirror](https://codemirror.net/) plugin for [Helix](https://helix-editor.com/) keybindings and general UX.

## Installation

```
npm install codemirror-helix
```

## How to

```typescript
import { EditorView } from "@codemirror/view";
import { helix } from "codemirror-helix";

const view = new EditorView({
  doc: "",
  extensions: [helix()],
  parent: document.querySelector("#editor"),
});
```

## License

[Mozilla Public License 2.0](LICENSE)

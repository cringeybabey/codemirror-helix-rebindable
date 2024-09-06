import type { EditorView } from "@codemirror/view";
import type SlTabPanel from "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel";
import type SlTabGroup from "@shoelace-style/shoelace/dist/components/tab-group/tab-group.component";

import { Picker } from "./components/picker";
import { Debug } from "./components/debug";

// @ts-ignore
import fileNames from "folder:..?names";

const filePickerOptions = fileNames.map((value: string) => ({ value }));

window.customElements.define("hx-picker", Picker);
window.customElements.define("hx-debug", Debug);

let codemirror: typeof import("./codemirror");

{
  document.querySelector(
    "#debug"
  )!.outerHTML = `<hx-debug style="display: none"></hx-debug>`;
}

const debugEl = document.querySelector("hx-debug")!;
let tabGroup: SlTabGroup;

function initShoelace() {
  document.querySelector(
    "#editor"
  )!.outerHTML = `<sl-tab-group activation="manual"></sl-tab-group>`;

  tabGroup = document.querySelector("sl-tab-group")!;

  tabGroup.addEventListener("sl-tab-show", (e) => {
    const old = state.active;
    const panels = [...tabGroup.querySelectorAll("sl-tab-panel")];
    const changed = panels.length > 1;

    if (changed) {
      state.active = panels.indexOf(
        tabGroup.querySelector(
          `sl-tab-panel[name="${(e as any).detail.name}"]`
        )!
      );
    }

    const view = state.editors.get(state.tabs[state.active])!.view;

    updateDebug(debugEl, view);
    setTimeout(() => view.focus());

    (window as any).view = view;

    if (changed) {
      const prevView = state.editors.get(state.tabs[old])!.view;

      view.dispatch(...codemirror.globalStateSync(prevView.state), {
        effects: codemirror.resetMode,
      });
    }

    const callback = state.callback;
    state.callback = () => {};

    callback();
  });
}

const debugPlugin = () =>
  codemirror.ViewPlugin.define((view) => {
    return {
      update(_viewUpdate) {
        updateDebug(debugEl, view);
      },
    };
  });

const state = {
  editors: new Map<string, { view: EditorView; panel: SlTabPanel }>(),
  tabs: [] as string[],
  set(file: string, view: EditorView, panel: SlTabPanel) {
    state.tabs.push(file);
    state.editors.set(file, { view, panel });
  },
  active: 0,
  callback: () => {},
};

{
  const loaded = Promise.all([
    import("./codemirror").then((mod) => {
      codemirror = mod;
    }),
    import("./shoelace").then(() => initShoelace()),
    // @ts-ignore
    import("folder:.."),
  ]);

  if (process.env.NODE_ENV === "development") {
    main("src/lib.ts");
  } else {
    const picker = createPicker(undefined, async (file) => {
      await main(file);
    });

    picker.initOptions(filePickerOptions);
  }

  async function main(file: string) {
    await loaded;
    const view = await createViewPanel(file);
    (window as any).view = view;

    view.focus();
    debugEl.style.display = "";
  }
}

async function createViewPanel(file: string) {
  const name = file.split("/").at(-1)!;

  {
    const tab = document.createElement("sl-tab");
    tab.panel = file;
    tab.textContent = name;
    tab.slot = "nav";

    tabGroup.append(tab);
  }

  const tabPanel = document.createElement("sl-tab-panel");
  tabPanel.name = file;
  tabGroup.append(tabPanel);

  const view = createView(
    file,
    getPersistedFile(file) ?? (await getFiles())[file],
    tabPanel
  );

  state.set(file, view, tabPanel);

  // seems like we need a tick for `show()` to take effect
  await Promise.resolve();
  tabGroup.show(file);

  return view;
}

function createView(file: string, doc: string, parent: HTMLElement) {
  const view = new codemirror.EditorView({
    state: codemirror.EditorState.create({
      doc,
      extensions: [
        codemirror.externalCommands.of({
          buffer_picker() {
            const picker = createPicker(view, (value) => {
              tabGroup.show(value);
            });

            picker.initOptions(
              state.tabs.map((value) => {
                const active = state.tabs[state.active] === value;

                return { value, label: active ? `⁎ ${value}` : `  ${value}` };
              })
            );
          },
          file_picker() {
            const picker = createPicker(view, (value) => {
              const editor = state.editors.get(value);

              if (editor) {
                tabGroup.show(value);

                return;
              }

              createViewPanel(value);
            });

            picker.initOptions(filePickerOptions);
          },
          ":buffer-next"() {
            const index = state.active!;

            const next = (index + 1) % state.editors.size;

            const editor = state.editors.get(state.tabs[next])!;

            tabGroup.show(editor.panel.name);
          },
          ":buffer-previous"() {
            const index = state.active!;

            const next = (index - 1 + state.editors.size) % state.editors.size;

            const editor = state.editors.get(state.tabs[next])!;

            tabGroup.show(editor.panel.name);
          },
          ":buffer-close"() {
            if (state.editors.size <= 1) {
              return { message: "Unable to close last buffer", error: true };
            }

            const index = state.active;
            const file = state.tabs[index];
            const last = index === state.editors.size - 1;
            const next = last ? index - 1 : index + 1;

            state.callback = () => {
              const editor = state.editors.get(file)!;
              state.editors.delete(file);

              state.tabs.splice(index, 1);

              state.active = last ? state.tabs.length - 1 : state.active - 1;

              editor.panel.remove();
              tabGroup.querySelector(`sl-tab[panel="${file}"]`)?.remove();

              view.destroy();
            };

            tabGroup.show(state.tabs[next]);
          },
          global_search() {
            return { message: "global search is not implemented", error: true };
          },
        }),
        codemirror.helix(),
        debugPlugin().extension,
        codemirror.syntaxHighlighting(codemirror.defaultHighlightStyle),
        codemirror.javascript({
          typescript: true,
        }),
        codemirror.lineNumbers(),
        codemirror.commands.of([
          {
            name: "write",
            aliases: ["w"],
            help: "Writes the current document to local storage",
            handler(view) {
              const doc = view.state.doc.toString();
              setPersistedFile(file, doc);
            },
          },
          {
            name: "reset",
            help: "Resets all stored documents",
            handler() {
              localStorage.clear();
              window.location.reload();
            },
          },
        ]),
      ],
    }),
    extensions: [],
    parent,
    root: document,
  });

  return view;
}

function getPersistedFile(file: string) {
  return localStorage.getItem(`cm-hx-doc/${file}`);
}

function setPersistedFile(file: string, contents: string) {
  localStorage.setItem(`cm-hx-doc/${file}`, contents);
}

function createPicker(
  view: EditorView | undefined,
  onSelect: (value: string) => void
) {
  const picker = document.createElement("hx-picker");

  document.body.append(picker);

  picker.focus();

  picker.addEventListener(
    "picker-cancel",
    () => {
      view?.focus();
      picker.remove();
    },
    { once: true }
  );

  picker.addEventListener(
    "picker-select",
    (e) => {
      picker.remove();

      onSelect(e.value);
    },
    { once: true }
  );

  return picker;
}

async function getFiles(): Promise<Record<string, string>> {
  // @ts-ignore
  const mod = await import("folder:..");
  return mod.default;
}

function updateDebug(el: Debug, view: EditorView) {
  el.registers = view.state.field(codemirror.registersField);
  el.selection = view.state.selection.main;
  el.history = view.state.field(codemirror.historyField);
}

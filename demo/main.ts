import type { EditorView } from "@codemirror/view";
import type SlTabPanel from "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel";
import type SlTabGroup from "@shoelace-style/shoelace/dist/components/tab-group/tab-group.component";

import { Picker } from "./components/picker";
import { Debug } from "./components/debug";

// @ts-ignore
import fileNames from "folder:..?names";
import SlTab from "@shoelace-style/shoelace/dist/components/tab/tab.component";

const filePickerOptions = fileNames.map((value: string) => ({ value }));

window.customElements.define("hx-picker", Picker);
window.customElements.define("hx-debug", Debug);

let codemirror: typeof import("./codemirror");

const currentTheme = localStorage.getItem("cm-hx-theme");

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
  editors: new Map<
    string,
    { view: EditorView; panel: SlTabPanel; tab: SlTab }
  >(),
  tabs: [] as string[],
  set(file: string, view: EditorView, panel: SlTabPanel, tab: SlTab) {
    state.tabs.push(file);
    state.editors.set(file, { view, panel, tab });
  },
  active: 0,
  callback: () => {},
};

if (import.meta.env.DEV) {
  Object.defineProperty(window, "state", {
    get() {
      return state;
    },
  });
}

const themes = [
  {
    name: "default",
    extension: (cm: typeof codemirror) => [
      cm.syntaxHighlighting(cm.defaultHighlightStyle),
    ],
  },
  {
    name: "one-dark",
    extension: (cm: typeof codemirror) => cm.oneDark,
    dark: true,
  },
];

themes.sort((themeA, themeB) =>
  themeA.name === currentTheme ? -1 : themeB.name === currentTheme ? 1 : 0
);

const darkTheme =
  currentTheme != null &&
  themes.find((theme) => theme.name === currentTheme)?.dark;

{
  if (darkTheme) {
    document.documentElement.style.colorScheme = "dark";
  }

  const loaded = Promise.all([
    import("./codemirror").then((mod) => {
      codemirror = mod;

      if (import.meta.env.DEV) {
        (window as any).codemirror = codemirror;
      }
    }),
    import("./shoelace").then(() => initShoelace()),
    // @ts-ignore
    import("folder:.."),
  ]);

  if (import.meta.env.DEV) {
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
    document.body.classList.add("hud-active");
  }
}

async function createViewPanel(file: string) {
  const name = file.split("/").at(-1)!;

  const tab = document.createElement("sl-tab");
  tab.panel = file;
  tab.textContent = name;
  tab.slot = "nav";

  tabGroup.append(tab);

  const tabPanel = document.createElement("sl-tab-panel");
  tabPanel.name = file;
  tabGroup.append(tabPanel);

  const view = await createView(
    file,
    getPersistedFile(file) ?? (await getFiles())[file],
    tabPanel
  );

  state.set(file, view, tabPanel, tab);

  // seems like we need a tick for `show()` to take effect
  await Promise.resolve();
  tabGroup.show(file);

  return view;
}

async function createView(file: string, doc: string, parent: HTMLElement) {
  const view = new codemirror.EditorView({
    state: codemirror.EditorState.create({
      doc,
      extensions: [
        codemirror.pathRegister.of(file),
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
          ":buffer-close": {
            handler(buffers) {
              const nonexistent = buffers?.filter(
                (name) => !state.tabs.includes(name)
              );

              const nonexistentError = nonexistent?.length
                ? `cannot close non-existent buffers: ${nonexistent.join(", ")}`
                : undefined;
              const errorMessage = {
                message: nonexistentError ?? "Unable to close last buffer",
                error: true,
              };

              if (state.editors.size <= 1) {
                return errorMessage;
              }

              const toClose = buffers?.length
                ? buffers.flatMap((name) => {
                    const index = state.tabs.indexOf(name);
                    return index >= 0
                      ? [[index, state.tabs[index]] as const]
                      : [];
                  })
                : [[state.active, state.tabs[state.active]] as const];

              toClose.sort(([indexA], [indexB]) =>
                indexA < indexB ? -1 : indexA > indexB ? 1 : 0
              );

              let closeError = false;

              if (toClose.length >= state.editors.size) {
                closeError = true;

                toClose.length = state.editors.size - 1;
              }

              if (toClose.length === 0) {
                return errorMessage;
              }

              let next = -1;

              const toCloseSet = new Set(toClose.map(([index]) => index));

              {
                for (let i = 0; i < state.tabs.length; i++) {
                  if (toCloseSet.has(i)) {
                    continue;
                  }

                  if (i > state.active) {
                    if (next === -1) {
                      next = i;
                    }

                    break;
                  } else {
                    next = i;
                  }
                }
              }

              const nextFile = state.tabs[next];

              const callback = () => {
                for (const [, file] of toClose) {
                  const editor = state.editors.get(file)!;
                  state.editors.delete(file);

                  state.tabs.splice(state.tabs.indexOf(file), 1);

                  editor.panel.remove();
                  editor.tab.remove();

                  editor.view.destroy();
                }

                state.active = state.tabs.indexOf(nextFile);
              };

              if (next !== state.active) {
                state.callback = callback;
                tabGroup.show(state.tabs[next]);
              } else {
                callback();
              }

              if (closeError) {
                return errorMessage;
              }
            },
            autocomplete(args) {
              const last = args.at(-1)!;

              return state.tabs.filter((name) => name.startsWith(last));
            },
          },
          global_search() {
            return { message: "global search is not implemented", error: true };
          },
        }),
        codemirror.helix({
          themes: themes.map((theme) => ({
            ...theme,
            extension: theme.extension(codemirror),
          })),
          config: configFromInput(),
        }),
        codemirror.themeListener.of((theme) => {
          localStorage.setItem("cm-hx-theme", theme.name);

          if (darkTheme !== Boolean(theme.dark)) {
            window.location.reload();
          }
        }),
        debugPlugin().extension,
        ...(await chooseSyntax(file)),
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
            help: "Resets all stored documents and settings",
            handler() {
              let index = 0;

              while (true) {
                const key = localStorage.key(index);

                if (key == null) {
                  break;
                }

                if (!key.startsWith("cm-hx-")) {
                  index++;
                  continue;
                }

                localStorage.removeItem(key);
              }

              window.location.reload();
            },
          },
          ...Array.from({ length: import.meta.env.DEV ? 20 : 0 }, (_, i) => {
            return {
              name: `test-${i}`,
              help: `Test command #${i}`,
              handler() {
                return { message: "handled" };
              },
            };
          }),
        ]),
      ],
    }),
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

const optionsEl = document.querySelector("#options")! as HTMLElement;

{
  const currentConfig = configFromStorage();

  if (currentConfig != null) {
    for (const [key, value] of Object.entries(currentConfig)) {
      const el = optionsEl.querySelector(`[name="${key}"]`);

      if (!el) {
        continue;
      }

      if (el instanceof HTMLSelectElement) {
        el.value = value as string;
      }
    }
  }

  for (const control of optionsEl.querySelectorAll("[data-option]")) {
    if (control instanceof HTMLSelectElement) {
      control.onchange = () => {
        const config = configFromInput();
        localStorage.setItem("cm-hx-config", JSON.stringify(config));
        window.location.reload();
      };
    }
  }
}

function configFromInput() {
  const config: Record<string, string> = {};
  const controls = optionsEl.querySelectorAll("[data-option]");

  for (const control of controls) {
    if (control instanceof HTMLSelectElement) {
      config[control.name] = (
        [...control.children] as HTMLOptionElement[]
      ).find((opt) => opt.selected)!.value;
    }
  }

  return config;
}

function configFromStorage() {
  const config = localStorage.getItem("cm-hx-config");

  return config && JSON.parse(config);
}

function updateDebug(el: Debug, view: EditorView) {
  el.registers = view.state.field(codemirror.registersField);
  el.selection = view.state.selection;
  el.history = view.state.field(codemirror.historyField);
}

async function chooseSyntax(file: string) {
  const ext = file.split(".").at(-1);

  switch (ext) {
    case "ts": {
      return [
        codemirror.javascript({
          typescript: true,
        }),
      ];
    }
    case "html": {
      return import("@codemirror/lang-html").then(({ html }) => [html()]);
    }
    case "md": {
      return import("@codemirror/lang-markdown").then(({ markdown }) => [
        markdown(),
      ]);
    }
    case "css": {
      return import("@codemirror/lang-css").then(({ css }) => [css()]);
    }
    case "yml": {
      return import("@codemirror/lang-yaml").then(({ yaml }) => [yaml()]);
    }
    case "json": {
      return import("@codemirror/lang-json").then(({ json }) => [json()]);
    }
  }

  return [];
}

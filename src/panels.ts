import { EditorView, Panel } from "@codemirror/view";
import {
  EditorSelection,
  type FacetReader,
  type Text,
} from "@codemirror/state";
import type { TypableCommand } from "./lib";
import {
  modeStatus,
  readRegister,
  registersHistoryField,
  yankEffect,
} from "./state";
import { ModeState, SearchMode } from "./entities";

const MOUNT_EVENT = "cm-hx-input-mounted";

export const panelStyles = EditorView.theme({
  ".cm-hx-status-panel": {
    display: "flex",
    "justify-content": "space-between",
    "font-family": "monospace",
  },
  ".cm-hx-command-panel": {
    fontFamily: "monospace",
    minHeight: "18px",
    background: "inherit",
  },
  ".cm-hx-command-panel-flex": {
    display: "flex",
    justifyContent: "space-between",
    background: "inherit",
  },
  ".cm-hx-command-input": {
    "flex-grow": 100,
    fontFamily: "monospace",
    fontSize: "inherit",
    border: "none",
    outline: "none",
    padding: "0",
    margin: "0",
    background: "inherit",
    color: "inherit",
  },
  ".cm-hx-command-autocomplete": {
    display: "grid",
    "grid-template-columns": "repeat(auto-fill, minmax(10em, 1fr))",
    gap: "1px 0px",
  },
  ".cm-hx-command-popup-wrapper": {
    width: "100%",
    background: "inherit",
    position: "relative",
  },
  ".cm-hx-command-popup": {
    position: "absolute",
    background: "inherit",
    width: "inherit",
  },
  ".cm-hx-command-help": {
    border: "1px solid #777",
    "line-height": "1.5",
    background: "inherit",
    padding: "4px 8px",
    whiteSpace: "preserve",
  },
});

export const panelTheme = {
  light: EditorView.theme({
    ".cm-hx-selected-option": {
      background: "#ccc",
    },
  }),
  dark: EditorView.theme({
    ".cm-hx-selected-option": {
      background: "#777",
    },
  }),
};

export type CommandPanelMessage = {
  message: string;
  error?: boolean;
};

export class CommandPanel implements Panel {
  dom: HTMLDivElement;

  private minorCommand: HTMLElement;
  private inputContainer: HTMLElement;
  private label: HTMLElement;
  private message = false;
  private commandPopup: HTMLElement;
  private autocomplete: HTMLElement;
  private help: HTMLElement;
  private popupRequest?: number;

  constructor(
    private view: EditorView,
    private commandFacet: FacetReader<TypableCommand[]>,
    private startSearch: (mode: SearchMode) => {
      onInput(input: string): void;
      onClose(accept: boolean): CommandPanelMessage | void;
      init: string;
    }
  ) {
    this.dom = $el("div") as any;

    const popupWrapper = $el("div");
    popupWrapper.classList.add("cm-hx-command-popup-wrapper");

    const flex = $el("div");
    flex.classList.add("cm-hx-command-panel-flex");

    this.minorCommand = $el("span");
    this.inputContainer = $el("span");
    this.commandPopup = $el("div");

    popupWrapper.append(this.commandPopup);
    flex.append(this.inputContainer);
    flex.append(this.minorCommand);

    this.dom.append(flex);
    this.dom.append(popupWrapper);

    this.dom.classList.add("cm-hx-command-panel");

    $style(this.inputContainer, {
      visibility: "hidden",
      flexGrow: "1",
      display: "flex",
    });
    this.label = $el("span");
    this.inputContainer.append(this.label);

    this.commandPopup.classList.add("cm-hx-command-popup");

    this.help = $el("div");
    this.autocomplete = $el("div");

    this.help.hidden = true;
    this.help.classList.add("cm-hx-command-help");
    this.autocomplete.classList.add("cm-hx-command-autocomplete");

    this.commandPopup.append(this.help);
    this.commandPopup.append(this.autocomplete);

    $style(this.minorCommand, { minWidth: "8em", textAlign: "center " });
  }

  showSearchInput(mode = SearchMode.Normal) {
    const input = this.searchInput(mode);

    this.showInput(
      input,
      mode === SearchMode.Global ? "global-search:" : "search:"
    );
  }

  showCommandInput() {
    const input = this.commandInput();

    this.showInput(input, ":");
  }

  showMinor(command: ModeState) {
    this.minorCommand.textContent = modeStatus(command);
  }

  private showInput(input: HTMLElement, label: string) {
    this.label.textContent = label;
    $style(this.label, { color: "" });

    this.inputContainer.append(input);
    $style(this.inputContainer, { visibility: "" });

    input.dispatchEvent(new Event(MOUNT_EVENT));
    input.focus();
  }

  private createInput({
    onInput,
    onClose,
    placeholder,
    onKeyDown,
    getPopup,
    getHistory,
    accept,
  }: {
    onInput: (value: string) => void;
    onClose: (commit: boolean, value: string) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    getPopup: (value: string) => { help?: string; options: string[] };
    getHistory: () => Array<string | Text> | undefined;
    placeholder?: string;
    accept?: (value: string) => string | undefined;
  }) {
    const input = $el("input") as HTMLInputElement;

    let currentPopup: ReturnType<typeof getPopup> | undefined;
    let selected: number | undefined;
    let historyEntry: number = -1;

    if (onKeyDown) {
      input.addEventListener("keydown", onKeyDown);
    }

    input.addEventListener(MOUNT_EVENT, () => {
      currentPopup = getPopup(input.value);

      this.showPopup(currentPopup.options, currentPopup.help, undefined);
    });

    if (placeholder) {
      input.placeholder = placeholder;
    }

    input.classList.add("cm-hx-command-input");
    input.type = "text";

    let open = true;

    input.addEventListener("blur", () => {
      if (open) {
        this.hidePopup();
        selected = undefined;
        onClose(false, input.value);
      }
    });

    input.addEventListener("input", () => {
      selected = undefined;

      currentPopup = getPopup(input.value);

      this.showPopup(currentPopup.options, currentPopup.help, undefined);

      onInput(input.value);
    });

    input.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }

      const isEnter = event.key === "Enter";

      if (isEnter || event.key === "Escape") {
        open = false;

        this.hidePopup();
        selected = undefined;
        onClose(isEnter, input.value);
      } else if (event.key === "Tab" && currentPopup?.options.length) {
        event.preventDefault();

        const forward = !event.shiftKey;

        const prev = selected;

        if (selected != null) {
          selected =
            (selected + (forward ? 1 : -1) + currentPopup.options.length) %
            currentPopup.options.length;
        } else {
          selected = forward ? 0 : currentPopup.options.length - 1;
        }

        if (prev !== selected) {
          const selectedOption = currentPopup.options[selected];
          const nextPopup = getPopup(selectedOption);
          currentPopup = { ...nextPopup, options: currentPopup.options };

          this.showPopup(currentPopup.options, currentPopup.help, selected);

          input.value = accept?.(selectedOption) ?? selectedOption;
        }
        onInput(input.value);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const history = getHistory() ?? [];

        const next = historyEntry + (event.key === "ArrowUp" ? 1 : -1);

        if (next >= 0 && next < history.length) {
          historyEntry = next;

          const value = history[history.length - 1 - historyEntry].toString();

          currentPopup = getPopup(value);

          this.showPopup(currentPopup.options, currentPopup.help, selected);

          input.value = value;
          input.selectionStart = value.length;
        }
      }
    });

    return input;
  }

  private commandInput() {
    const { view } = this;

    const initialSelection = view.state.selection;
    const initialScroll = view.scrollSnapshot();

    const isNumber = (cmd: string) => /^\d+$/.test(cmd);

    // FIXME: autocomplete
    let readingRegister = false;

    const input = this.createInput({
      placeholder: readRegister(view.state, ":")?.at(0)?.toString(),
      getHistory: () => this.view.state.field(registersHistoryField)[":"],
      onKeyDown(e) {
        if (e.isComposing) {
          return;
        }

        if (e.key === "r" && e.ctrlKey) {
          readingRegister = true;
        } else if (readingRegister && e.key === "Escape") {
          readingRegister = false;
          // FIXME: length=1 is sort of fake
        } else if (readingRegister && e.key.length === 1) {
          readingRegister = false;

          input.value +=
            readRegister(view.state, e.key)?.at(0)?.toString() ?? "";
        } else if (!readingRegister) {
          return;
        }

        e.stopPropagation();
        e.preventDefault();
      },
      onClose: (commit, value) => {
        if (commit && value) {
          view.dispatch({
            effects: yankEffect.of([":", [value]]),
          });
        } else if (commit) {
          value = readRegister(view.state, ":")?.at(0)?.toString() ?? "";
        }

        const [cmd, ...args] = value.trimEnd().split(/ +/);

        if (commit && cmd) {
          const commands = view.state.facet(this.commandFacet);

          const command = commands.find(
            (command) =>
              command.name === cmd ||
              command.aliases?.some((alias) => alias === cmd)
          );

          const result = command
            ? command.handler(view, args)
            : {
                message: `no such command: '${cmd}'`,
                error: true,
              };

          if (result) {
            this.showMessageAndCloseInput(result);

            return;
          }
        } else if (!commit && isNumber(cmd)) {
          view.dispatch({
            selection: initialSelection,
          });

          setTimeout(() => {
            view.dispatch({
              effects: initialScroll,
            });
          });
        }

        this.closeInput();
      },
      onInput: (value) => {
        const args = value.split(/ +/);

        const cmd = args.at(0);

        if (!cmd) {
          return;
        }

        if (isNumber(cmd)) {
          const lineNo = Number(cmd);

          if (lineNo >= 1 && lineNo <= view.state.doc.lines) {
            const line = view.state.doc.line(lineNo);

            view.dispatch({
              selection: EditorSelection.cursor(line.from),
              effects: EditorView.scrollIntoView(line.from, { y: "center" }),
            });
          }

          return;
        }
      },
      getPopup: (value) => {
        // FIXME: no quoting whatsoever
        const args = value.split(/ +/);

        const cmd = args.at(0);

        if (cmd == null) {
          return { options: [] };
        }

        const commands = view.state.facet(this.commandFacet);
        const possibleCommands = commands.filter(
          (command) =>
            command.name.startsWith(cmd) ||
            command.aliases?.some((alias) => alias.startsWith(cmd))
        );
        const command = possibleCommands.find(
          (command) => command.name === cmd || command.aliases?.includes(cmd)
        );

        function commandToHelp(command: TypableCommand) {
          let help = "";

          if (command) {
            help = `${command.help}`;

            if (command.aliases && command.aliases.length > 0) {
              help += `\nAliases: ${command.aliases.join(", ")}`;
            }
          }

          return help;
        }

        const help = command != null ? commandToHelp(command) : undefined;

        if (args[1] != null && command && command.autocomplete) {
          const options = command.autocomplete(args.slice(1));
          return { options, help };
        } else {
          return {
            options: possibleCommands.map((command) => command.name),
            help,
          };
        }
      },
      accept(value) {
        const last = input.value.split(/ +/).at(-1);

        if (last == null) {
          return undefined;
        }

        return (
          input.value.slice(0, input.value.length - last.length) + `${value}`
        );
      },
    });

    return input;
  }

  showError(message: string) {
    this.showMessage({ message, error: true });
  }

  showMessage(messageOrResult?: void | string | CommandPanelMessage) {
    if (messageOrResult == null) {
      return;
    }

    const [message, error] =
      typeof messageOrResult === "string"
        ? [messageOrResult, false]
        : [messageOrResult.message, messageOrResult.error];
    $style(this.inputContainer, { visibility: "" });
    this.message = true;
    $style(this.label, { color: error ? "red" : "" });
    this.label.textContent = message;
  }

  private showMessageAndCloseInput(result?: void | CommandPanelMessage) {
    this.showMessage(result);
    this.closeInput(!result);
  }

  hasMessage() {
    return this.message;
  }

  clearMessage() {
    if (this.message) {
      this.message = false;
      this.label.textContent = "";
      $style(this.inputContainer, { visibility: "hidden" });
    }
  }

  private showPopup(options: string[], help?: string, selected?: number) {
    if (options.length === 0) {
      this.hidePopup();

      return;
    }

    this.commandPopup.hidden = false;

    this.help.hidden = !help;

    this.help.textContent = help ?? "";

    while (options.length > this.autocomplete.childNodes.length) {
      const entry = $el("span");
      $style(entry, { marginRight: "1em" });

      this.autocomplete.append(entry);
    }

    for (const [i, child] of this.autocomplete.childNodes.entries()) {
      const option = options[i];

      if (option) {
        child.textContent = option;
        (child as HTMLElement).style.order = "";
      } else {
        break;
      }
    }

    while (this.autocomplete.childNodes.length > options.length) {
      this.autocomplete.lastChild?.remove();
    }

    const current = this.autocomplete.querySelector(".cm-hx-selected-option");
    current?.classList.remove("cm-hx-selected-option");

    if (selected != null) {
      this.autocomplete.children[selected].classList.add(
        "cm-hx-selected-option"
      );
    }

    if (this.popupRequest == null) {
      this.popupRequest = requestAnimationFrame(() => this.positionPopup());
    }
  }

  private hidePopup() {
    this.commandPopup.hidden = true;
  }

  private positionPopup() {
    this.popupRequest = undefined;

    if (this.commandPopup.hidden) {
      return;
    }

    const inputBox = this.inputContainer.getBoundingClientRect();
    const wrapperBox = this.commandPopup.parentElement!.getBoundingClientRect();

    $style(this.commandPopup, {
      bottom: `${wrapperBox.top - inputBox.top}px`,
      left: "0px",
    });

    let i = -1;

    const base = this.autocomplete.children.item(0)!.getBoundingClientRect().x;

    for (let index = 1; index < this.autocomplete.children.length; index++) {
      const child = this.autocomplete.children.item(index)!;

      if (child.getBoundingClientRect().x === base) {
        i = index;
        break;
      }
    }

    const width = i < 0 ? 1 : i;

    let order = 0;

    for (let i = 0; i < width; i++) {
      for (let j = i; j < this.autocomplete.children.length; j += width) {
        (this.autocomplete.children.item(order) as HTMLElement).style.order =
          String(j);
        order++;
      }
    }
  }

  private searchInput(mode: SearchMode) {
    const search = this.startSearch(mode);

    return this.createInput({
      placeholder: search.init,
      getHistory: () => this.view.state.field(registersHistoryField)["/"],
      onClose: (commit) => {
        this.showMessageAndCloseInput(search.onClose(commit));
      },

      onInput: (value) => {
        search.onInput(value);
      },

      getPopup: (value) => {
        const history = this.view.state.field(registersHistoryField)["/"] ?? [];

        const options = history.flatMap((entry) => {
          const text = entry.toString();
          return text.startsWith(value) ? [text] : [];
        });

        options.sort();

        return { options };
      },
    });
  }

  private closeInput(hide = true) {
    this.inputContainer.removeChild(this.inputContainer.lastChild!);

    if (hide) {
      $style(this.inputContainer, { visibility: "hidden" });
    }

    requestAnimationFrame(() => {
      this.view.focus();
    });
  }
}

export function statusPanel(view: EditorView) {
  const dom = $el("div");

  dom.classList.add("cm-hx-status-panel");

  const mode = $el("span");

  mode.textContent = "NOR";
  dom.append(mode);

  const register = $el("span");
  dom.append(register);

  const pos = $el("span");

  dom.append(pos);

  function setLineCol() {
    const { line, column } = lineCol(view);

    pos.textContent = `${line}:${column}`;
  }

  setLineCol();

  return {
    dom,
    setMode(modeStr: string, activeRegister?: string) {
      mode.textContent = modeStr;

      register.textContent = activeRegister ? `reg=${activeRegister}` : "";
    },
    setLineCol,
  };
}

function lineCol(view: EditorView) {
  const head = view.state.selection.main.head;
  const lineDesc = view.state.doc.lineAt(head);
  const line = lineDesc.number;
  const column = head - lineDesc.from + 1;

  return { line, column };
}

function $el(tag: string) {
  return document.createElement(tag);
}

function $style(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

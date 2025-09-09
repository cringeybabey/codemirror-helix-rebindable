import { EditorView, Panel } from "@codemirror/view";
import { EditorSelection, FacetReader } from "@codemirror/state";
import type { TypableCommand } from "./lib";
import { modeStatus, readRegister, yankEffect } from "./state";
import { ModeState, SearchMode } from "./entities";

export const panelStyles = EditorView.theme({
  ".cm-hx-status-panel": {
    display: "flex",
    "justify-content": "space-between",
    "font-family": "monospace",
  },
  ".cm-hx-command-panel": {
    display: "flex",
    justifyContent: "space-between",
    fontFamily: "monospace",
    minHeight: "18px",
    background: "inherit",
  },
  ".cm-hx-command-input": {
    fontFamily: "monospace",
    fontSize: "inherit",
    border: "none",
    outline: "none",
    padding: "0",
    margin: "0",
    background: "inherit",
    color: "inherit",
  },
  ".cm-hx-command-popup": {
    position: "fixed",
    background: "inherit",
  },
  ".cm-hx-command-help": {
    border: "1px solid #777",
    "line-height": "1.5",
    background: "inherit",
    padding: "4px 8px",
    whiteSpace: "preserve",
  },
});

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

    this.minorCommand = $el("span");
    this.inputContainer = $el("span");
    this.commandPopup = $el("div");

    this.dom.append(this.inputContainer);
    this.dom.append(this.minorCommand);
    this.dom.append(this.commandPopup);

    this.dom.classList.add("cm-hx-command-panel");

    $style(this.inputContainer, { visibility: "hidden" });
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

    input.focus();
  }

  private createInput({
    onInput,
    onClose,
    placeholder,
    onKeyDown,
  }: {
    onInput: (value: string) => void;
    onClose: (commit: boolean, value: string) => void;
    onKeyDown?: (event: KeyboardEvent) => void;
    placeholder?: string;
  }) {
    const input = $el("input") as HTMLInputElement;

    if (onKeyDown) {
      input.addEventListener("keydown", onKeyDown);
    }

    if (placeholder) {
      input.placeholder = placeholder;
    }

    input.classList.add("cm-hx-command-input");
    input.type = "text";

    let open = true;

    input.addEventListener("blur", () => {
      if (open) {
        onClose(false, input.value);
      }
    });

    input.addEventListener("input", () => {
      onInput(input.value);
    });

    input.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }

      const isEnter = event.key === "Enter";

      if (isEnter || event.key === "Escape") {
        open = false;

        onClose(isEnter, input.value);
      }
    });

    return input;
  }

  private commandInput() {
    const { view } = this;

    const initialSelection = view.state.selection;
    const initialScroll = view.scrollSnapshot();

    const isNumber = (cmd: string) => /^\d+$/.test(cmd);

    let readingRegister = false;

    // FIXME: tab completion
    const input = this.createInput({
      placeholder: readRegister(view.state, ":")?.at(0)?.toString(),
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
        this.hidePopup();

        if (commit && value) {
          view.dispatch({
            effects: yankEffect.of([":", [value]]),
          });
        } else if (commit) {
          value = readRegister(view.state, ":")?.at(0)?.toString() ?? "";
        }

        const [cmd, ...args] = value.split(/ +/);

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
          this.hidePopup();
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

        const commands = view.state.facet(this.commandFacet);
        const possibleCommands = commands.filter(
          (command) =>
            command.name.startsWith(cmd) ||
            command.aliases?.some((alias) => alias.startsWith(cmd))
        );
        const command = possibleCommands.find(
          (command) => command.name === cmd || command.aliases?.includes(cmd)
        );

        if (args[1] != null && command && command.autocomplete) {
          const options = command.autocomplete(args.slice(1));
          if (options.length === 0) {
            this.hidePopup();

            return;
          }

          this.showCommandPopup(options, command);
        } else {
          if (possibleCommands.length === 0) {
            this.hidePopup();

            return;
          }

          this.showCommandPopup(
            possibleCommands.map((command) => command.name),
            command
          );
        }
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

  private showCommandPopup(options: string[], match?: TypableCommand) {
    let help = "";

    if (match) {
      help = `${match.help}`;

      if (match.aliases && match.aliases.length > 0) {
        help += `\nAliases: ${match.aliases.join(",")}`;
      }
    }

    this.showPopup(options, help);
  }

  private showPopup(options: string[], help?: string) {
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
      } else {
        break;
      }
    }

    while (this.autocomplete.childNodes.length > options.length) {
      this.autocomplete.lastChild?.remove();
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

    const box = this.inputContainer.getBoundingClientRect();

    $style(this.commandPopup, {
      bottom: `${window.innerHeight - box.top}px`,
      left: `${box.left}px`,
    });
  }

  private searchInput(mode: SearchMode) {
    const search = this.startSearch(mode);

    return this.createInput({
      placeholder: search.init,
      onClose: (commit) => {
        this.showMessageAndCloseInput(search.onClose(commit));
      },

      onInput: (value) => {
        search.onInput(value);
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

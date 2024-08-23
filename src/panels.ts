import { EditorView, Panel } from "@codemirror/view";
import { EditorSelection, FacetReader } from "@codemirror/state";
import type { TypableCommand } from "./lib";
import { modeStatus } from "./state";
import { ModeState } from "./entities";

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
  },
  ".cm-hx-command-input": {
    border: "none",
    outline: "none",
    padding: "0",
    margin: "0",
    background: "inherit",
  },
  ".cm-hx-command-popup": {
    position: "fixed",
    background: "#ccc",
  },
  ".cm-hx-command-help": {
    border: "1px solid #777",
    background: "#ddd",
    padding: "2px",
    whiteSpace: "preserve",
  },
});

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
    private startSearch: () => {
      onInput(input: string): void;
      onClose(accept: boolean): void;
    }
  ) {
    this.dom = el("div") as any;

    this.minorCommand = el("span");
    this.inputContainer = el("span");
    this.commandPopup = el("div");

    $append(this.dom, this.inputContainer);
    $append(this.dom, this.minorCommand);
    $append(this.dom, this.commandPopup);

    this.dom.classList.add("cm-hx-command-panel");

    $style(this.inputContainer, { visibility: "hidden" });
    this.label = el("span");
    $append(this.inputContainer, this.label);

    this.commandPopup.classList.add("cm-hx-command-popup");

    this.help = el("div");
    this.autocomplete = el("div");

    this.help.hidden = true;
    this.help.classList.add("cm-hx-command-help");
    this.autocomplete.classList.add("cm-hx-command-autocomplete");

    $append(this.commandPopup, this.help);
    $append(this.commandPopup, this.autocomplete);

    $style(this.minorCommand, { minWidth: "8em", textAlign: "center " });
  }

  showSearchInput() {
    const input = this.searchInput();

    this.showInput(input, "search:");
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

    $append(this.inputContainer, input);
    $style(this.inputContainer, { visibility: "" });

    input.focus();
  }

  private createInput({
    onInput,
    onClose,
  }: {
    onInput: (value: string) => void;
    onClose: (commit: boolean, value: string) => void;
  }) {
    const input = el("input") as HTMLInputElement;

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

    // FIXME: tab completion
    return this.createInput({
      onClose: (commit, value) => {
        this.hidePopup();

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
            this.showMessageAndCloseInput(result.message, result.error);

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
        const cmd = value.split(/ +/).at(0);

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

        const options = commands.filter(
          (command) =>
            command.name.startsWith(cmd) ||
            command.aliases?.some((alias) => alias.startsWith(cmd))
        );

        if (options.length === 0) {
          this.hidePopup();

          return;
        }

        const match = options.find(
          (command) =>
            command.name === cmd ||
            command.aliases?.some((alias) => alias === cmd)
        );

        this.showPopup(options, match);
      },
    });
  }

  showMessage(message: string, error?: boolean) {
    $style(this.inputContainer, { visibility: "" });
    this.message = true;
    $style(this.label, { color: error ? "red" : "" });
    this.label.textContent = message;
  }

  private showMessageAndCloseInput(message: string, error?: boolean) {
    this.showMessage(message, error);
    this.closeInput(false);
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

  private showPopup(commands: TypableCommand[], match?: TypableCommand) {
    this.commandPopup.hidden = false;

    this.help.hidden = !match;

    if (match) {
      this.help.textContent = `${match.help}`;

      if (match.aliases && match.aliases.length > 0) {
        this.help.textContent += `\nAliases: ${match.aliases.join(",")}`;
      }
    } else {
      this.help.textContent = "";
    }

    while (commands.length > this.autocomplete.childNodes.length) {
      const entry = el("span");
      $style(entry, { marginRight: "1em" });

      $append(this.autocomplete, entry);
    }

    for (const [i, child] of this.autocomplete.childNodes.entries()) {
      const command = commands[i];

      if (command) {
        child.textContent = command.name;
      } else {
        break;
      }
    }

    while (this.autocomplete.childNodes.length > commands.length) {
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

  private searchInput() {
    const search = this.startSearch();

    return this.createInput({
      onClose: (commit) => {
        search.onClose(commit);
        this.closeInput();
        // this.closeSearchInput(commit);
      },

      onInput: (value) => {
        search.onInput(value);
        // const query = new SearchQuery({
        //   search: value,
        //   regexp: true,
        //   caseSensitive: false,
        // });

        // const effect = setSearchQuery.of(query);

        // view.dispatch({ effects: effect });

        // this.startSearch(view, query);
      },
    });
  }

  // private closeSearchInput(accept: boolean) {
  //   const empty = new SearchQuery({ search: "" });

  //   if (!accept) {
  //     this.startSearch(this.view, empty);
  //   }

  //   this.view.dispatch({
  //     effects: [
  //       searchEffect.of({
  //         type: SearchEffKind.Exit,
  //         query: accept ? getSearchQuery(this.view.state) : undefined,
  //       }),
  //       setSearchQuery.of(empty),
  //     ],
  //   });

  //   this.closeInput();
  // }

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
  const dom = el("div");

  dom.classList.add("cm-hx-status-panel");

  const mode = el("span");

  mode.textContent = "NOR";
  $append(dom, mode);

  const pos = el("span");

  $append(dom, pos);

  function setLineCol() {
    const { line, column } = lineCol(view);

    pos.textContent = `${line}:${column}`;
  }

  setLineCol();

  return {
    dom,
    setMode(modeStr: string) {
      mode.textContent = modeStr;
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

function el(tag: string) {
  return document.createElement(tag);
}

function $append(el: HTMLElement, child: HTMLElement) {
  el.insertBefore(child, null);
}

function $style(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

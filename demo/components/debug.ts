import { EditorSelection } from "@codemirror/state";

declare global {
  interface HTMLElementTagNameMap {
    "hx-debug": Debug;
  }
}
export class Debug extends HTMLElement {
  #register: HTMLDivElement;
  #history: HTMLDivElement;
  #selection: HTMLDivElement;
  #theme: HTMLDivElement;

  connectedCallback() {
    if (this.#register) {
      return;
    }

    this.innerHTML = `
      <div> <abbr title="Change it using the :theme command">theme</abbr>: <code id="theme"></code></div>
      <div>regs: <code id="register"></code></div>
      <div>range: &emsp;<code id="selection"></code></div>
      <div>history: &emsp;<code id="history"></code></div>
    `;

    this.#theme = this.querySelector("#theme")!;
    this.#register = this.querySelector("#register")!;
    this.#history = this.querySelector("#history")!;
    this.#selection = this.querySelector("#selection")!;
  }

  set registers(registers: any) {
    this.#register.textContent = Object.entries(registers)
      .map(([reg, value]) => `<${reg}> => ${value as any}`)
      .join("\n");
  }

  set selection(selection: EditorSelection) {
    const main = selection.main;

    this.#selection.textContent = `${main.from} ${
      main.anchor <= main.head ? "➡️" : "⬅️"
    } ${main.to}${
      selection.ranges.length > 1
        ? ` at #${selection.mainIndex} (plus ${
            selection.ranges.length - 1
          } more)`
        : ""
    }`;
  }

  set history(history: any) {
    this.#history.textContent = `history: ${
      history.checkpoints.length
    } cursor: ${
      history.cursor
    } head: ${!!history.head} pending: ${!!history.pending}`;
  }

  set theme(theme: any) {
    this.#theme.textContent = theme;
  }
}

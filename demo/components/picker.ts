declare global {
  interface HTMLElementTagNameMap {
    "hx-picker": Picker;
  }

  interface HTMLElementEventMap {
    "picker-select": SelectEvent;
  }
}

const SENTINEL = [];

export class Picker extends HTMLElement {
  #input: HTMLInputElement;
  #ul: HTMLUListElement;
  #options: Array<{ value: string; label?: string | undefined }> = SENTINEL;
  #selected = 0;
  #visible: number[] = [];
  #frame: number | undefined;

  focus() {
    this.#input?.focus();
  }

  constructor() {
    super();
  }

  disconnnectedCallback() {
    window.removeEventListener("keydown", this.#onKeyDown);
  }

  connectedCallback() {
    window.addEventListener("keydown", this.#onKeyDown);

    if (this.#input) {
      return;
    }

    this.#input = el("input");
    this.#input.type = "text";

    this.append(this.#input);

    this.append(el("hr"));

    this.#ul = el("ul");
    this.#initList();
    this.append(this.#ul);

    this.#input.addEventListener("input", () => {
      this.#onInput();
    });

    this.addEventListener("click", (e) => {
      this.#onClick(e);
    });

    this.addEventListener("dblclick", () => {
      this.dispatchEvent(
        new SelectEvent(this.#options[this.#visible[this.#selected]].value)
      );
    });
  }

  #onClick(e: MouseEvent) {
    if (e.target instanceof HTMLLIElement) {
      const index = [...this.#visible]
        .map((i) => this.#ul.children[i])
        .indexOf(e.target);

      const prev = this.#selected;
      this.#selected = index;
      this.#setSelected(prev);
    }
  }

  initOptions(options: Array<{ value: string; label?: string }>) {
    if (this.#options !== SENTINEL) {
      return;
    }

    this.#options = options.slice();

    this.#initList();

    this.#visible = Array.from({ length: options.length }, (_, i) => i);
  }

  #initList() {
    if (!this.#ul) {
      return;
    }

    for (const option of this.#options) {
      const li = el("li");

      li.textContent = option.label ?? option.value;

      this.#ul.append(li);
    }

    this.#ul.children[0]?.classList.add("selected");
  }

  #highlight() {
    if (this.#frame != null) {
      this.#frame = undefined;
    }

    const input = this.#input.value.toLowerCase();

    for (const i of this.#visible) {
      const li = this.#ul.children[i] as HTMLLIElement;
      const label = this.#options[i].label ?? this.#options[i].value;

      if (!input) {
        li.textContent = label;
        continue;
      }

      const index = label.toLowerCase().indexOf(input);

      if (index === -1) {
        continue;
      }

      const span = el("span");
      span.classList.add("match");
      span.textContent = label.slice(index, index + input.length);

      li.replaceChildren(
        label.slice(0, index),
        span,
        label.slice(index + input.length)
      );
    }
  }

  #onKeyDown = (e: KeyboardEvent) => {
    const prevSelected = this.#visible[this.#selected];

    const step = e.key === "PageDown" || e.key === "PageUp" ? 10 : 1;

    switch (e.key) {
      case "PageDown":
      case "ArrowDown": {
        if (this.#visible.length > 0) {
          this.#selected = (this.#selected + step) % this.#visible.length;
          this.#setSelected(prevSelected);
        }
        break;
      }

      case "PageUp":
      case "ArrowUp": {
        if (this.#visible.length > 0) {
          this.#selected =
            (this.#selected - step + this.#visible.length) %
            this.#visible.length;
          this.#setSelected(prevSelected);
        }
        break;
      }

      case "Escape": {
        this.dispatchEvent(new Event("picker-cancel"));
        break;
      }

      case "Enter": {
        if (this.#visible.length > 0) {
          this.dispatchEvent(
            new SelectEvent(this.#options[this.#visible[this.#selected]].value)
          );
        }
        break;
      }

      default: {
        return;
      }
    }

    e.preventDefault();
  };

  #onInput() {
    const value = this.#input.value.toLowerCase();
    const visibleOptions: number[] = [];

    const prevSelected = this.#visible[this.#selected];

    for (const [i, option] of this.#options.entries()) {
      const li = this.#ul.children[i] as HTMLLIElement;

      const visible = option.value.toLowerCase().includes(value);

      li.style.display = visible ? "" : "none";

      if (visible) {
        visibleOptions.push(i);
      }
    }

    this.#selected = Math.min(
      this.#selected,
      Math.max(0, visibleOptions.length - 1)
    );
    this.#visible = visibleOptions;

    this.#setSelected(prevSelected);

    if (this.#frame != null) {
      cancelAnimationFrame(this.#frame);
    }

    this.#frame = requestAnimationFrame(() => this.#highlight());
  }

  #setSelected(old: number) {
    if (old != null) {
      this.#ul.children[old].classList.remove("selected");
    }

    if (this.#visible.length > 0) {
      this.#ul.children[this.#visible[this.#selected]].classList.add(
        "selected"
      );
    }
  }
}

class SelectEvent extends Event {
  constructor(public value: string) {
    super("picker-select");
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K
): HTMLElementTagNameMap[K] {
  return document.createElement(tagName);
}

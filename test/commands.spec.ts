import { expect, browser } from "@wdio/globals";
import { Key } from "webdriverio";

type Assertion =
  | string
  | {
      selection: [anchor: number, head: number];
    };

const slow = false;

const cases: Array<[string, string | string[], string[], Assertion]> = [
  ["deletes a line", ["foo", "bar"], ["x", "d"], "bar"],
  ["selects lines", ["foo", "bar", "baz"], ["x", "x"], { selection: [0, 7] }],
  ["reverse selection", "foo", ["x", "Alt-;"], { selection: [3, 0] }],
  ["surrounds with parens", "foo", ["x", "m", "s", "<"], "<foo>"],
  [
    "surrounds moves selection",
    "foo",
    ["x", "m", "s", "<"],
    { selection: [0, 5] },
  ],
  [
    "surrounds respects selection dir",
    "foo",
    ["x", "Alt-;", "m", "s", "<"],
    "<foo>",
  ],
  ["cancels surrounds", "foo", ["x", "m", "s", "Escape", "a", "i"], "fooi"],
];

describe("codemirror-helix", () => {
  for (const [title, text, commands, expected] of cases) {
    const keys = toKeys(commands);

    it(title, async () => {
      await browser.url("http://localhost:45183");

      await initEditor(text);

      for (const key of keys) {
        await browser.keys(key);
        await (slow ? wait(1000) : undefined);
      }

      if (typeof expected === "string") {
        const doc = await getDoc();

        expect(doc).toBe(expected);
      } else {
        const selection = await getSelection();

        expect(selection).toEqual({
          anchor: expected.selection[0],
          head: expected.selection[1],
        });
      }
    });
  }
});

async function wait(timeout: number) {
  await new Promise<void>((res) => setTimeout(() => res(), timeout));
}

function initEditor(text: string | string[]) {
  return browser.execute(
    `initEditor(${JSON.stringify(
      Array.isArray(text) ? text.join("\n") : text
    )})`
  );
}

function getDoc() {
  return browser.execute("return view.state.doc.toString()");
}

function getSelection() {
  return browser.execute("return view.state.selection.main.toJSON()");
}
function toKeys(commands: string[]) {
  const keys: Array<string | string[]> = [];

  for (let command of commands) {
    if (command.startsWith("Alt-")) {
      command = command.replace("Alt-", "");
      keys.push([Key.Alt, command]);
      continue;
    }

    keys.push(command);
  }

  return keys;
}

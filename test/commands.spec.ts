import { expect, browser } from "@wdio/globals";
import { Key } from "webdriverio";

type Assertion =
  | string
  | {
      selection: [anchor: number, head: number];
      text?: string;
    };

const slow = false;

const cases: Array<[string, string | string[], string[], Assertion]> = [
  ["moves to line end", ["foo", "bar"], ["g", "l"], { selection: [3, 2] }],
  [
    "moves to line end, back from linebreak",
    ["foo", "bar"],
    ["g", "l", "l", "g", "l"],
    { selection: [3, 2] },
  ],
  ["deletes a line", ["foo", "bar"], ["x", "d"], "bar"],
  ["selects lines", ["foo", "bar", "baz"], ["x", "x"], { selection: [0, 8] }],
  ["reverse selection", "foo", ["x", "Alt-;"], { selection: [3, 0] }],
  ["surrounds with parens", "foo", ["x", "m", "s", "<"], "<foo>"],
  [
    "selects a line on linebreak",
    ["foo", "bar"],
    ["g", "l", "l", "x"],
    { selection: [0, 4] },
  ],
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
  ["find characters", "hello world", ["f", "w"], { selection: [0, 7] }],
  [
    "find characters, repeat",
    "hello world",
    ["f", "o", "f", "o"],
    { selection: [4, 8] },
  ],
  [
    "find characters, turn around",
    "hello world",
    ["f", "w", "F", "e"],
    { selection: [7, 1] },
  ],
  [
    "find characters, select & repeat",
    "hello world hello world",
    ["v", "f", "o", "f", "o", "f", "e", "F", "d"],
    { selection: [0, 11] },
  ],
  [
    "search cancellation",
    Array.from({ length: 200 }, (_, count) =>
      String(count + 1).padStart(3, "0")
    ),
    ["/", "0", "5", "0", "Enter", "/", "1", "3", "0", "Escape"],
    { selection: [196, 199] },
  ],
  ["delete repeatedly", "hello world", ["5", "l", "d", "d", "d"], "hellorld"],
  [
    "join lines",
    "hello world\nhelix rocks\nplugins when",
    ["5", "l", "v", "j", "J"],
    {
      selection: [5, 18],
      text: "hello world helix rocks\nplugins when",
    },
  ],
  [
    "join lines, trimming",
    "hello world\n   helix rocks\nplugins when",
    ["7", "l", "v", "j", "J"],
    {
      selection: [7, 17],
      text: "hello world helix rocks\nplugins when",
    },
  ],
  [
    "join lines, trimming partially",
    "hello world\n   helix rocks\nplugins when",
    ["l", "v", "j", "J"],
    {
      selection: [1, 12],
      text: "hello world helix rocks\nplugins when",
    },
  ],
];

describe("codemirror-helix", () => {
  for (const [title, text, commands, expected] of cases) {
    const keys = toKeys(commands);

    it(title, async () => {
      await browser.url("http://localhost:45183");

      await initEditor(text);

      for (const key of keys) {
        await (slow ? wait(1000) : undefined);
        await browser.keys(key);
      }

      await (slow ? wait(1000) : undefined);

      const expectedSelection =
        typeof expected === "string" ? null : expected.selection;
      const expectedText =
        typeof expected === "string" ? expected : expected.text;

      if (expectedSelection != null) {
        const selection = await getSelection();

        expect(selection).toEqual({
          anchor: expectedSelection[0],
          head: expectedSelection[1],
        });
      }

      if (expectedText != null) {
        const doc = await getDoc();

        expect(doc).toBe(expectedText);
      }
    });
  }
});

async function wait(timeout: number) {
  await new Promise<void>((res) => setTimeout(() => res(), timeout));
}

async function initEditor(text: string | string[]) {
  await expect($(".ready")).toBePresent();

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

    if (command.startsWith("Ctrl-")) {
      command = command.replace("Ctrl-", "");
      keys.push([Key.Ctrl, command]);
      continue;
    }

    keys.push(command);
  }

  return keys;
}

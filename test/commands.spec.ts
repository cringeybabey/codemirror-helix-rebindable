import { expect, browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";

type Assertion =
  | string
  | {
      selection:
        | [anchor: number, head: number]
        | Array<[anchor: number, head: number]>;
      text?: string;
    };

const slow = false;

type Case =
  | [string, string | string[], string[], Assertion]
  | [boolean, string, string | string[], string[], Assertion];

const cases: Case[] = [
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
  [
    "insert line and edit, at line break",
    "hello world\nhelix rocks",
    ["g", "l", "l", "o", "Escape"],
    {
      selection: [13, 12],
      text: "hello world\n\nhelix rocks",
    },
  ],
  [
    "yank and paste after",
    "hello\nworld",
    ["v", "g", "l", "y", "g", "h", "j", "l", "p"],
    "hello\nwohellorld",
  ],
  [
    "yank and paste before",
    "hello\nworld",
    ["x", "_", "y", "Alt-;", ";", "j", "l", "P"],
    "hello\nwhelloorld",
  ],
  [
    "surround add multiple selections",
    "xxxeyyy\nxxxxeyyy",
    ["%", "s", "e", "Enter", "v", "l", "l", "m", "s", ")"],
    {
      text: "xxx(eyy)y\nxxxx(eyy)y",
      selection: [
        [3, 8],
        [14, 19],
      ],
    },
  ],
  [
    "select inside",
    "abc(xyz)abc",
    ["x", "s", "y", "Enter", "m", "i", "("],
    {
      selection: [4, 7],
    },
  ],
  [
    "select around",
    "abc(xy(z)w)abc",
    ["x", "s", "y", "Enter", "v", "h", "m", "a", "("],
    {
      selection: [11, 3],
    },
  ],
  [
    "select inside, no surrunding parens",
    "(ab)cd(ef)gh",
    ["4", "l", "m", "i", "("],
    {
      selection: [5, 4],
    },
  ],
  [
    "insert at line end",
    "abc\nxyz",
    ["A", "Escape"],
    {
      selection: [4, 3],
    },
  ],
  [
    "insert at line end, on line end",
    "abc\nxyz",
    ["A", "Escape", "A", "Escape"],
    {
      selection: [4, 3],
    },
  ],
  [
    "insert at line end, document end",
    "abc\nxyz",
    ["A", "Escape"],
    {
      selection: [4, 3],
    },
  ],
  [
    "go to last line",
    "abc\nxyz",
    ["g", "e"],
    {
      selection: [5, 4],
    },
  ],
  [
    "go to last line, select mode",
    "abc\nxyz",
    ["v", "g", "e"],
    {
      selection: [0, 5],
    },
  ],
  [
    "go to last line, final empty line",
    "abc\nxyz\n",
    ["g", "e"],
    {
      selection: [5, 4],
    },
  ],
  [
    "go to last line, extra empty line",
    "abc\nxyz\n\n",
    ["g", "e"],
    {
      selection: [9, 8],
    },
  ],
];

describe("codemirror-helix", () => {
  const skipping = cases.some((case_) => case_.length === 5);

  const caseNames = new Set();

  for (const case_ of cases) {
    let only = !skipping;
    let title: string;
    let text: string;
    let commands: string[];
    let expected: Assertion;

    if (case_.length === 5) {
      [only, title, text, commands, expected] = case_ as any;
    } else {
      [title, text, commands, expected] = case_ as any;
    }

    if (caseNames.has(title)) {
      throw new Error("Repeated case name");
    }

    caseNames.add(title);

    const keys = toKeys(commands);

    const itFn = only ? it.only : it;

    itFn(title, async () => {
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

        const expectation = (
          Array.isArray(expectedSelection[0])
            ? (expectedSelection as Array<[number, number]>)
            : [expectedSelection as [number, number]]
        ).map(([anchor, head]) => ({ anchor, head }));

        expect((selection as any).ranges).toEqual(expectation);
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
  return browser.execute("return view.state.selection.toJSON()");
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

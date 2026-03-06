import { expect, browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";

// An expectation is either:
// - The final contents of the the document, or
// - A { selection, text } object.
//
// A selection is described as an [anchor, head], or an array of such (for multi-selections).
type Expectation =
  | Text
  | {
      selection: [anchor: number, head: number] | Array<[anchor: number, head: number]>;
      text?: Text;
    };

// set this to `true` to make tests go real slow and help debugging
const SLOW = false;

// Represents text as a string or optionally as an array of lines
type Text = string | string[];

type Source = Text | { lang: string; source: Text };

// How to write a test case
//
// A test case is just an array with:
// [ initialEditorText, pressedKeys, expectation ]
//
// Optionally, the array can have one more element, a boolean as the first field
// to single out focused tests (a la `it.only()`).
type Case = [Source, string[], Expectation] | [boolean, Source, string[], Expectation];

const cases: Record<string, Case> = {
  "moves to line end": [["foo", "bar"], ["g", "l"], { selection: [3, 2] }],
  "moves to line end, back from linebreak": [
    ["foo", "bar"],
    ["g", "l", "l", "g", "l"],
    { selection: [3, 2] },
  ],
  "moves to first non-whitespace": ["  foo", ["g", "s"], { selection: [3, 2] }],
  "deletes a line": [["foo", "bar"], ["x", "d"], "bar"],
  "selects lines": [["foo", "bar", "baz"], ["x", "x"], { selection: [0, 8] }],
  "reverse selection": ["foo", ["x", "Alt-;"], { selection: [3, 0] }],
  "surrounds with parens": ["foo", ["x", "m", "s", "<"], "<foo>"],
  "selects a line on linebreak": [
    ["foo", "bar"],
    ["g", "l", "l", "x"],
    { selection: [0, 4] },
  ],
  "surrounds moves selection": ["foo", ["x", "m", "s", "<"], { selection: [0, 5] }],
  "surrounds respects selection dir": ["foo", ["x", "Alt-;", "m", "s", "<"], "<foo>"],
  "cancels surrounds": ["foo", ["x", "m", "s", "Escape", "a", "i"], "fooi"],
  "find characters": ["hello world", ["f", "w"], { selection: [0, 7] }],
  "find characters, repeat": ["hello world", ["f", "o", "f", "o"], { selection: [4, 8] }],
  "find characters, turn around": [
    "hello world",
    ["f", "w", "F", "e"],
    { selection: [7, 1] },
  ],
  "find characters, select & repeat": [
    "hello world hello world",
    ["v", "f", "o", "f", "o", "f", "e", "F", "d"],
    { selection: [0, 11] },
  ],
  "search cancellation": [
    Array.from({ length: 200 }, (_, count) => String(count + 1).padStart(3, "0")),
    ["/", "0", "5", "0", "Enter", "/", "1", "3", "0", "Escape"],
    { selection: [196, 199] },
  ],
  "delete repeatedly": ["hello world", ["5", "l", "d", "d", "d"], "hellorld"],
  "join lines": [
    ["hello world", "helix rocks", "plugins when"],
    ["5", "l", "v", "j", "J"],
    {
      selection: [5, 18],
      text: ["hello world helix rocks", "plugins when"],
    },
  ],
  "join lines, trimming": [
    ["hello world", "   helix rocks", "plugins when"],
    ["7", "l", "v", "j", "J"],
    {
      selection: [7, 17],
      text: ["hello world helix rocks", "plugins when"],
    },
  ],
  "join lines, trimming partially": [
    ["hello world", "   helix rocks", "plugins when"],
    ["l", "v", "j", "J"],
    {
      selection: [1, 12],
      text: ["hello world helix rocks", "plugins when"],
    },
  ],
  "insert line and edit, at line break": [
    ["hello world", "helix rocks"],
    ["g", "l", "l", "o", "Escape"],
    {
      selection: [13, 12],
      text: ["hello world", "", "helix rocks"],
    },
  ],
  "yank and paste after": [
    ["hello", "world"],
    ["v", "g", "l", "y", "g", "h", "j", "l", "p"],
    ["hello", "wohellorld"],
  ],
  "yank and paste before": [
    ["hello", "world"],
    ["x", "_", "y", "Alt-;", ";", "j", "l", "P"],
    ["hello", "whelloorld"],
  ],
  "surround add multiple selections": [
    ["xxxeyyy", "xxxxeyyy"],
    ["%", "s", "e", "Enter", "v", "l", "l", "m", "s", ")"],
    {
      text: ["xxx(eyy)y", "xxxx(eyy)y"],
      selection: [
        [3, 8],
        [14, 19],
      ],
    },
  ],
  "select inside": [
    "abc(xyz)abc",
    ["x", "s", "y", "Enter", "m", "i", "("],
    {
      selection: [4, 7],
    },
  ],
  "select around": [
    "abc(xy(z)w)abc",
    ["x", "s", "y", "Enter", "v", "h", "m", "a", "("],
    {
      selection: [11, 3],
    },
  ],
  "select inside, no surrunding parens": [
    "(ab)cd(ef)gh",
    ["4", "l", "m", "i", "("],
    {
      selection: [5, 4],
    },
  ],
  "insert at line end": [
    ["abc", "xyz"],
    ["A", "Escape"],
    {
      selection: [4, 3],
    },
  ],
  "insert at line end, editing": [
    ["abc", "xyz", ""],
    ["A", "u", "Escape"],
    {
      selection: [5, 4],
      text: ["abcu", "xyz", ""],
    },
  ],
  "insert at line end, on line end": [
    ["abc", "xyz"],
    ["A", "Escape", "A", "Escape"],
    {
      selection: [4, 3],
    },
  ],
  "insert at line end, document end": [
    ["abc", "xyz"],
    ["A", "Escape"],
    {
      selection: [4, 3],
    },
  ],
  "insert at start of the line": [
    ["abc", "  xyz", "uvw"],
    ["j", "I", "a", "Escape"],
    {
      selection: [8, 7],
      text: ["abc", "  axyz", "uvw"],
    },
  ],
  "go to last line": [
    ["abc", "xyz"],
    ["g", "e"],
    {
      selection: [5, 4],
    },
  ],
  "go to last line, select mode": [
    ["abc", "xyz"],
    ["v", "g", "e"],
    {
      selection: [0, 5],
    },
  ],
  "go to last line, final empty line": [
    ["abc", "xyz", ""],
    ["g", "e"],
    {
      selection: [5, 4],
    },
  ],
  "go to last line, extra empty line": [
    ["abc", "xyz", "", ""],
    ["g", "e"],
    {
      selection: [9, 8],
    },
  ],
  "duplicate cursor": [
    ["hello world", "helix rocks"],
    ["w", "C", "C", "d"],
    {
      selection: [
        [1, 0],
        [8, 7],
      ],
      text: [" world", " rocks"],
    },
  ],
  "expand selection": [
    { lang: "js", source: ["const hello = 'world';"] },
    ["f", "e", ";", "Alt-o"],
    {
      selection: [11, 6],
    },
  ],
};

describe("codemirror-helix", () => {
  const casesList = Object.entries(cases);
  const skipping = casesList.some(([, case_]) => case_.length === 4);

  for (const [title, case_] of casesList) {
    let only = !skipping;
    let source: Source;
    let commands: string[];
    let expected: Expectation;

    if (case_.length === 4) {
      [only, source, commands, expected] = case_ as any;
    } else {
      [source, commands, expected] = case_ as any;
    }

    const keys = toKeys(commands);

    const itFn = only ? it.only : it;

    itFn(title, async () => {
      await browser.url("http://localhost:45183");

      await initEditor(source);

      for (const key of keys) {
        await (SLOW ? wait(1000) : undefined);
        await browser.keys(key);
      }

      await (SLOW ? wait(1000) : undefined);

      const [expectedSelection, expectedText] =
        typeof expected === "string" || Array.isArray(expected)
          ? [null, textToString(expected)]
          : [expected.selection, expected.text && textToString(expected.text)];

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

async function initEditor(source: Source) {
  const [text, lang] =
    typeof source === "string" || Array.isArray(source)
      ? [source, null]
      : [source.source, source.lang];

  await expect($(".ready")).toBePresent();

  return browser.execute(
    `return initEditor(${JSON.stringify(textToString(text))}, ${JSON.stringify(lang)})`
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

function textToString(text: Text) {
  return typeof text === "string" ? text : text.join("\n");
}

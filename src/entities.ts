import type { EditorView } from "@codemirror/view";

export const enum ModeType {
  Normal = 0,
  Insert = 1,
  Select = 4,
}

export const enum MinorMode {
  Normal = 2,
  Goto = 3,
  Match = 5,
  Space = 6,
  LeftBracket = 7,
  RightBracket = 8,
}

export const enum SearchMode {
  Normal,
  Global,
  Selection,
}

type Expecting = {
  minor: string;
  callback(view: EditorView, char: string, metadata: any): void;
  metadata: any;
};

export type ModeState =
  | {
      type: ModeType.Insert;
      expecting?: Expecting;
    }
  | {
      type: ModeType.Normal | ModeType.Select;
      minor: MinorMode;
      count?: number;
      register?: string;
      expecting?: Expecting;
    };

export type NonInsertMode = Exclude<
  ModeState,
  {
    type: ModeType.Insert;
  }
>;

export type NormalLikeMode = NonInsertMode & { minor: MinorMode.Normal };

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
}

export type ModeState =
  | {
      type: ModeType.Insert;
    }
  | {
      type: ModeType.Normal | ModeType.Select;
      minor: MinorMode;
      expecting?: {
        callback(view: EditorView, char: string, metadata: any): void;
        metadata: any;
      };
    };

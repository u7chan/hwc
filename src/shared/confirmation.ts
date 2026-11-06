export type PaneInteraction =
  | {
      kind: "codex-folder-trust";
      id: string;
      directory: string;
      submitted: boolean;
    }
  | { kind: "terminal" };

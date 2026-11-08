import type { FolderTrustAgent } from "./agents";

export type FolderTrustInteraction = {
  kind: "folder-trust";
  id: string;
  agent: FolderTrustAgent;
  directory: string;
  submitted: boolean;
};

export type PaneInteraction = FolderTrustInteraction | { kind: "terminal" };

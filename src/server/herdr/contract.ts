import { isAbsolute } from "node:path";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type HerdrSnapshot = {
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces?: readonly HerdrWorkspace[];
  tabs?: readonly HerdrTab[];
  panes?: readonly HerdrPane[];
  agents?: readonly HerdrAgent[];
};

export type HerdrWorktree = {
  repo_name: string;
  repo_root?: string | null;
  checkout_path?: string | null;
  is_linked_worktree: boolean;
};

export type HerdrWorkspace = {
  workspace_id: string;
  label?: string | null;
  agent_status?: AgentStatus;
  focused?: boolean;
  worktree?: HerdrWorktree | null;
};

export type HerdrTab = {
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  agent_status?: AgentStatus;
  focused?: boolean;
};

export type HerdrAgentSession = {
  agent: string | null;
  source: string | null;
  kind: string | null;
  value: string | null;
};

export type HerdrPane = {
  pane_id: string;
  workspace_id: string;
  // ブランチを読む場所を決めるためだけに使う。
  cwd?: string | null;
  tab_id: string;
  label?: string | null;
  agent_status?: AgentStatus;
  focused?: boolean;
  agent_session?: HerdrAgentSession | null;
};

export type HerdrAgent = {
  pane_id?: string | null;
  workspace_id?: string | null;
  // ブランチを読む場所を決めるためだけに使う（表示はペインの cwd ではない）。
  cwd?: string | null;
  agent?: string | null;
  terminal_title_stripped?: string | null;
};

const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function expectId(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ペインのラベルは Herdr 側で未設定なら空文字が返る。空文字と null は「名前なし」に畳む。
function optionalLabel(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalStatus(value: unknown): AgentStatus {
  return AGENT_STATUSES.includes(value as AgentStatus) ? (value as AgentStatus) : "unknown";
}

function optionalFlag(value: unknown): boolean {
  return value === true;
}

// セッションは任意で、Herdr の版によっては形が違う。読めない値は null にして、
// スナップショット全体を落とさない（ペインの一覧はセッション無しでも表示できる）。
function optionalAgentSession(value: unknown): HerdrAgentSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    agent: optionalText(record.agent),
    source: optionalText(record.source),
    kind: optionalText(record.kind),
    value: optionalText(record.value),
  };
}

// git 管理下でないワークスペースは worktree を持たない。
function optionalWorktree(value: unknown, path: string): HerdrWorktree | null {
  if (value === undefined || value === null) return null;
  const record = expectRecord(value, path);
  return {
    repo_name: expectId(record.repo_name, `${path}.repo_name`),
    repo_root: optionalText(record.repo_root),
    checkout_path: optionalText(record.checkout_path),
    is_linked_worktree: optionalFlag(record.is_linked_worktree),
  };
}

export function parseSnapshot(value: unknown): HerdrSnapshot {
  const raw = expectRecord(value, "snapshot");

  const workspaces = expectArray(raw.workspaces, "snapshot.workspaces").map((item, index) => {
    const path = `snapshot.workspaces[${index}]`;
    const record = expectRecord(item, path);
    return {
      workspace_id: expectId(record.workspace_id, `${path}.workspace_id`),
      label: optionalText(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
      worktree: optionalWorktree(record.worktree, `${path}.worktree`),
    };
  });

  const tabs = expectArray(raw.tabs, "snapshot.tabs").map((item, index) => {
    const path = `snapshot.tabs[${index}]`;
    const record = expectRecord(item, path);
    return {
      tab_id: expectId(record.tab_id, `${path}.tab_id`),
      workspace_id: expectId(record.workspace_id, `${path}.workspace_id`),
      label: optionalText(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const panes = expectArray(raw.panes, "snapshot.panes").map((item, index) => {
    const path = `snapshot.panes[${index}]`;
    const record = expectRecord(item, path);
    return {
      pane_id: expectId(record.pane_id, `${path}.pane_id`),
      workspace_id: expectId(record.workspace_id, `${path}.workspace_id`),
      tab_id: expectId(record.tab_id, `${path}.tab_id`),
      cwd: optionalText(record.cwd),
      label: optionalLabel(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
      agent_session: optionalAgentSession(record.agent_session),
    };
  });

  const agents = expectArray(raw.agents, "snapshot.agents").map((item, index) => {
    const record = expectRecord(item, `snapshot.agents[${index}]`);
    return {
      pane_id: optionalText(record.pane_id),
      workspace_id: optionalText(record.workspace_id),
      cwd: optionalText(record.cwd),
      agent: optionalText(record.agent),
      terminal_title_stripped: optionalText(record.terminal_title_stripped),
    };
  });

  return {
    focused_workspace_id: optionalText(raw.focused_workspace_id),
    focused_tab_id: optionalText(raw.focused_tab_id),
    focused_pane_id: optionalText(raw.focused_pane_id),
    workspaces,
    tabs,
    panes,
    agents,
  };
}

export type PaneRead = {
  paneId: string;
  text: string;
  truncated: boolean;
  revision: number;
};

export type PaneLayoutCell = {
  paneId: string;
  width: number;
  height: number;
};

export type PaneLayout = { cells: PaneLayoutCell[] };

export function parsePaneRead(value: unknown, paneId: string): PaneRead {
  const record = expectRecord(value, "pane_read");
  if (record.type !== "pane_read") {
    throw new Error(`pane_read.type must be pane_read, got ${String(record.type)}`);
  }

  const raw = expectRecord(record.read, "pane_read.read");
  if (raw.pane_id !== paneId) throw new Error(`pane_read.read.pane_id must be ${paneId}`);
  if (typeof raw.text !== "string") throw new Error("pane_read.read.text must be a string");
  if (typeof raw.truncated !== "boolean") {
    throw new Error("pane_read.read.truncated must be a boolean");
  }
  const revision = raw.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("pane_read.read.revision must be a non-negative safe integer");
  }

  return { paneId, text: raw.text, truncated: raw.truncated, revision };
}

export function parsePaneLayout(value: unknown): PaneLayout {
  const record = expectRecord(value, "pane_layout");
  if (record.type !== "pane_layout") {
    throw new Error(`pane_layout.type must be pane_layout, got ${String(record.type)}`);
  }

  const layout = expectRecord(record.layout, "pane_layout.layout");
  const cells = expectArray(layout.panes, "pane_layout.layout.panes").map((item, index) => {
    const path = `pane_layout.layout.panes[${index}]`;
    const pane = expectRecord(item, path);
    const rect = expectRecord(pane.rect, `${path}.rect`);
    return {
      paneId: expectId(pane.pane_id, `${path}.pane_id`),
      width: expectNumber(rect.width, `${path}.rect.width`),
      height: expectNumber(rect.height, `${path}.rect.height`),
    };
  });
  return { cells };
}

// pane.split は作ったペインを pane_info で返す。ID だけを読む。
export function parsePaneSplit(value: unknown): { paneId: string } {
  const record = expectRecord(value, "pane_info");
  if (record.type !== "pane_info") {
    throw new Error(`pane_info.type must be pane_info, got ${String(record.type)}`);
  }

  const pane = expectRecord(record.pane, "pane_info.pane");
  return { paneId: expectId(pane.pane_id, "pane_info.pane.pane_id") };
}

export function parsePaneDirectory(value: unknown, paneId: string): string {
  const record = expectRecord(value, "pane_info");
  const pane = expectRecord(record.pane, "pane_info.pane");
  if (
    record.type !== "pane_info" ||
    pane.pane_id !== paneId ||
    typeof pane.cwd !== "string" ||
    !isAbsolute(pane.cwd)
  ) {
    throw new Error("pane_info must contain the requested pane and its absolute cwd");
  }
  return pane.cwd;
}

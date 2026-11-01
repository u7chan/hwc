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

export type HerdrPane = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status?: AgentStatus;
  focused?: boolean;
};

export type HerdrAgent = {
  pane_id?: string | null;
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

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalStatus(value: unknown): AgentStatus {
  return AGENT_STATUSES.includes(value as AgentStatus) ? (value as AgentStatus) : "unknown";
}

function optionalFlag(value: unknown): boolean {
  return value === true;
}

// git 管理下でないワークスペースは worktree を持たない。
function optionalWorktree(value: unknown, path: string): HerdrWorktree | null {
  if (value === undefined || value === null) return null;
  const record = expectRecord(value, path);
  return {
    repo_name: expectId(record.repo_name, `${path}.repo_name`),
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
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const agents = expectArray(raw.agents, "snapshot.agents").map((item, index) => {
    const record = expectRecord(item, `snapshot.agents[${index}]`);
    return {
      pane_id: optionalText(record.pane_id),
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

import type { AgentStatus } from "./state";

export type HerdrSnapshot = {
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces?: readonly HerdrWorkspace[];
  tabs?: readonly HerdrTab[];
  panes?: readonly HerdrPane[];
  agents?: readonly HerdrAgent[];
};

export type HerdrWorkspace = {
  workspace_id: string;
  label?: string | null;
  agent_status?: AgentStatus;
  focused?: boolean;
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

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`snapshot: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`snapshot: ${name} must be an array`);
  return value;
}

function expectId(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`snapshot: ${name} must be a non-empty string`);
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

export function parseSnapshot(value: unknown): HerdrSnapshot {
  const raw = expectRecord(value, "snapshot");

  const workspaces = expectArray(raw.workspaces, "workspaces").map((item) => {
    const record = expectRecord(item, "workspace");
    return {
      workspace_id: expectId(record.workspace_id, "workspace_id"),
      label: optionalText(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const tabs = expectArray(raw.tabs, "tabs").map((item) => {
    const record = expectRecord(item, "tab");
    return {
      tab_id: expectId(record.tab_id, "tab_id"),
      workspace_id: expectId(record.workspace_id, "tab.workspace_id"),
      label: optionalText(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const panes = expectArray(raw.panes, "panes").map((item) => {
    const record = expectRecord(item, "pane");
    return {
      pane_id: expectId(record.pane_id, "pane_id"),
      workspace_id: expectId(record.workspace_id, "pane.workspace_id"),
      tab_id: expectId(record.tab_id, "pane.tab_id"),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const agents = expectArray(raw.agents, "agents").map((item) => {
    const record = expectRecord(item, "agent");
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
  text: string;
  truncated: boolean;
  revision: number;
};

export function parsePaneRead(value: unknown): PaneRead {
  const raw = expectRecord(expectRecord(value, "pane_read").read, "pane_read.read");
  if (typeof raw.text !== "string") throw new Error("snapshot: pane_read.text must be a string");
  if (typeof raw.truncated !== "boolean") {
    throw new Error("snapshot: pane_read.truncated must be a boolean");
  }
  if (typeof raw.revision !== "number") {
    throw new Error("snapshot: pane_read.revision must be a number");
  }
  return { text: raw.text, truncated: raw.truncated, revision: raw.revision };
}

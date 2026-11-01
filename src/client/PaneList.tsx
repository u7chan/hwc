import type { ComponentChildren } from "preact";
import type { AppState } from "../server/herdr/state";
import { AgentIcon, ChevronRightIcon, PaneIcon, WorkspaceIcon } from "./icons";
import { countPanes, countWorkspacePanes } from "./select";
import { StatusLabel } from "./StatusLabel";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  expanded: Set<string>;
  onSelect: (paneId: string) => void;
  onToggle: (groupId: string) => void;
};

function WorkspaceRow(props: {
  label: string;
  count: number;
  status: ComponentChildren;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      class="hwc-group"
      aria-expanded={props.expanded}
      aria-controls={props.controlsId}
      onClick={props.onToggle}
    >
      <span class="hwc-group-icon">
        <WorkspaceIcon />
      </span>
      <span class="hwc-group-main">
        <span class="hwc-group-name">{props.label}</span>
        <span class="hwc-group-sub">{props.count} ペイン</span>
      </span>
      {props.status}
      <span class="hwc-chevron" data-open={props.expanded}>
        <ChevronRightIcon />
      </span>
    </button>
  );
}

// 高さを 0fr → 1fr で動かすため、閉じていても中身は描画したままにする。
function GroupChildren(props: { id: string; open: boolean; children: ComponentChildren }) {
  return (
    <div id={props.id} class="hwc-group-children" data-open={props.open}>
      <div class="hwc-children-inner">{props.children}</div>
    </div>
  );
}

export function PaneList(props: PaneListProps) {
  const { state, selectedPaneId, expanded, onSelect, onToggle } = props;

  if (countPanes(state) === 0) {
    return (
      <div class="hwc-empty">
        <div class="hwc-empty-mark">
          <PaneIcon size={32} />
        </div>
        <h2 class="hwc-empty-title">ペインがありません</h2>
        <p class="hwc-empty-text">Herdr でワークスペースとペインを開くと、ここに一覧が出ます。</p>
      </div>
    );
  }

  return (
    <div class="hwc-list-scroll">
      {state.workspaces.map((workspace) => {
        const open = expanded.has(workspace.id);
        const groupId = `hwc-group-${workspace.id}`;
        const panes = workspace.tabs.flatMap((tab) =>
          tab.panes.map((pane) => ({ pane, tabLabel: tab.label })),
        );
        return (
          <section class="hwc-group-block" key={workspace.id}>
            <WorkspaceRow
              label={workspace.label}
              count={countWorkspacePanes(workspace.id, state)}
              // 開いているときは各ペインの状態が見えるので、まとめの状態は出さない。
              status={open ? null : <StatusLabel status={workspace.agentStatus} />}
              expanded={open}
              controlsId={groupId}
              onToggle={() => onToggle(workspace.id)}
            />
            <GroupChildren id={groupId} open={open}>
              <ul class="hwc-panes">
                {panes.map(({ pane, tabLabel }) => (
                  <li key={pane.id}>
                    <button
                      type="button"
                      class="hwc-pane"
                      aria-current={pane.id === selectedPaneId ? "true" : undefined}
                      onClick={() => onSelect(pane.id)}
                    >
                      <span class="hwc-pane-icon">{pane.agent ? <AgentIcon /> : <PaneIcon />}</span>
                      <span class="hwc-pane-main">
                        <span class="hwc-pane-name">{pane.title ?? pane.agent ?? pane.id}</span>
                        <span class="hwc-pane-sub">
                          {tabLabel} · {pane.id}
                        </span>
                      </span>
                      <StatusLabel status={pane.agentStatus} />
                    </button>
                  </li>
                ))}
              </ul>
            </GroupChildren>
          </section>
        );
      })}
    </div>
  );
}

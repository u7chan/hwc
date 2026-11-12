import type { ComponentChildren } from "preact";
import type { PaneState, WorktreeState } from "../../server/herdr/state";
import { AgentIcon, PaneIcon, RepoIcon, WorkspaceIcon, WorktreeIcon } from "../icons";
import { agentPresence, countLabel } from "../scope";
import { StatusLabel } from "../StatusLabel";

// git 管理下でない / 通常のリポジトリ / linked worktree を形で見分ける。
export function WorkspaceGlyph({ worktree }: { worktree: WorktreeState | null }) {
  if (!worktree) return <WorkspaceIcon />;
  return worktree.isLinkedWorktree ? <WorktreeIcon /> : <RepoIcon />;
}

export function GroupChildren(props: { id: string; open: boolean; children: ComponentChildren }) {
  return (
    <div id={props.id} class="hwc-group-children" data-open={props.open}>
      <div class="hwc-children-inner">{props.children}</div>
    </div>
  );
}

// 折りたたみの状態は、開いている間は子の状態で分かるので、まとめは淡く消して場所だけ残す。
// エージェントの居ない束は状態の集約が意味を持たない（待機や不明はシェルだけでも出る）ので、
// 状態の代わりにシェルの記号を置き、エージェントの有無を右端でも読めるようにする。
export function GroupStatus(props: {
  status: PaneState["agentStatus"];
  agents: number;
  hidden: boolean;
}) {
  return (
    <span class="hwc-group-status" data-hidden={props.hidden}>
      {props.agents === 0 ? (
        <span class="hwc-group-shell" role="img" aria-label="シェルのみ" title="シェルのみ">
          <PaneIcon />
        </span>
      ) : (
        <StatusLabel status={props.status} />
      )}
    </span>
  );
}

// エージェントの数の札。副題が PR のタイトルに変わっても消えないよう、名前の行に置く。
// 数は status の件数ではなく、エージェントの居るペインの数。
export function GroupAgents(props: { agents: number }) {
  return (
    <span
      class="hwc-group-agents"
      role="img"
      aria-label={agentPresence(props.agents)}
      title={agentPresence(props.agents)}
    >
      <AgentIcon size={12} />
      <span aria-hidden="true">{countLabel(props.agents)}</span>
    </span>
  );
}

// 同じ場所を指すスペースを束ねていることを、名前の横の数で示す。畳んだ状態でも
// 1 行の裏に複数の実体があることを見落とさないための札。
export function GroupSpaces(props: { spaces: number }) {
  const label = `${props.spaces} スペース`;
  return (
    <span class="hwc-group-spaces" role="img" aria-label={label} title={label}>
      <WorkspaceIcon size={12} />
      <span aria-hidden="true">{countLabel(props.spaces)}</span>
    </span>
  );
}

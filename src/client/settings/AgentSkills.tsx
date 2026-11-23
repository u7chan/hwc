import { useEffect, useState } from "preact/hooks";
import type { ModelAgentKind } from "../../shared/agents";
import type { AgentSkill, AgentSkills as AgentSkillsView } from "../../shared/agent-skills";
import { readAgentSkills } from "../api";
import { ChevronRightIcon } from "../icons";
import { groupSkillsBySource } from "./skill-groups";

type LoadState = "loading" | "ready" | "failed";

const skillKey = (skill: AgentSkill) => `${skill.source}:${skill.name}`;

// description を持つ行だけが押せる。無い行は、押しても見せるものが無いので押せない。
function SkillRow(props: { skill: AgentSkill; expanded: boolean; onToggle: () => void }) {
  const { skill, expanded } = props;
  const name = (
    <span class="hwc-skill-name" data-state={skill.state}>
      {skill.name}
    </span>
  );
  const off = skill.state === "off" ? <span class="hwc-skill-off">無効</span> : null;

  if (skill.description === null) {
    return (
      <li class="hwc-skill-item">
        <div class="hwc-skill-line">
          <span class="hwc-skill-line-head">
            {name}
            {off}
          </span>
        </div>
      </li>
    );
  }
  return (
    <li class="hwc-skill-item">
      <button
        type="button"
        class="hwc-skill-line hwc-skill-toggle"
        aria-expanded={expanded}
        onClick={props.onToggle}
      >
        <span class="hwc-skill-line-head">
          {name}
          {off}
          <span class="hwc-skill-chevron" data-open={expanded}>
            <ChevronRightIcon size={16} />
          </span>
        </span>
        {expanded ? <span class="hwc-skill-description">{skill.description}</span> : null}
      </button>
    </li>
  );
}

// その CLI がグローバルに認識するスキルの一覧。読み取り専用で、保存はしない
// （docs/adr/agent-skills.md）。数が多いので既定では畳み、件数だけを見せる。
export function AgentSkills(props: { agent: ModelAgentKind }) {
  const [view, setView] = useState<AgentSkillsView | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState(false);
  // 説明を開いている行の識別子。同時に開くのは 1 行だけにする。
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    void readAgentSkills(props.agent, controller.signal).then((read) => {
      if (controller.signal.aborted) return;
      // 読めないまま「0 件」と出すと、スキルが無いのと取り違える。
      if (read === null) {
        setLoad("failed");
        return;
      }
      setView(read);
      setLoad("ready");
    });
    return () => controller.abort();
  }, [props.agent, reloadKey]);

  if (load === "failed" || (load === "ready" && view === null)) {
    return (
      <section>
        <div class="hwc-setting-failure">
          <p class="hwc-section-note" role="alert">
            グローバルスキルを読み込めませんでした。
          </p>
          <button
            type="button"
            class="hwc-setting-button"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            再試行
          </button>
        </div>
      </section>
    );
  }

  const count = view === null ? null : view.skills.length;
  const offCount = view === null ? 0 : view.skills.filter((skill) => skill.state === "off").length;

  return (
    <section>
      <div class="hwc-setting-group">
        <button
          type="button"
          class="hwc-setting-row hwc-skill-head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="hwc-setting-label">グローバルスキル</span>
          <span class="hwc-setting-value hwc-skill-summary">
            {count === null ? "読み込み中" : `${count} 件`}
            {offCount > 0 ? <span class="hwc-skill-off-count">· 無効 {offCount}</span> : null}
            <span class="hwc-skill-chevron" data-open={open}>
              <ChevronRightIcon size={16} />
            </span>
          </span>
        </button>
        {open && view !== null ? (
          <div class="hwc-skill-list">
            {view.skills.length === 0 ? (
              <p class="hwc-section-note hwc-skill-empty">スキルはありません。</p>
            ) : (
              groupSkillsBySource(view.skills).map((group) => (
                <div class="hwc-skill-group" key={group.source}>
                  <div class="hwc-skill-group-head">
                    <span class="hwc-skill-source">{group.source}</span>
                    <span>{group.skills.length}</span>
                  </div>
                  <ul class="hwc-skill-rows">
                    {group.skills.map((skill) => (
                      <SkillRow
                        key={skillKey(skill)}
                        skill={skill}
                        expanded={expanded === skillKey(skill)}
                        onToggle={() =>
                          setExpanded((current) =>
                            current === skillKey(skill) ? null : skillKey(skill),
                          )
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
      <p class="hwc-section-note">
        この CLI
        がホームディレクトリから読み込むスキルです。ペインのフォルダから読むスキルは含みません。
        {view?.truncated === true ? " 一覧が長いため、一部だけを表示しています。" : null}
      </p>
    </section>
  );
}

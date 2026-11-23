import { useEffect, useState } from "preact/hooks";
import type { ModelAgentKind } from "../../shared/agents";
import type { AgentSkills as AgentSkillsView } from "../../shared/agent-skills";
import { readAgentSkills } from "../api";
import { ChevronRightIcon } from "../icons";

type LoadState = "loading" | "ready" | "failed";

// その CLI がグローバルに認識するスキルの一覧。読み取り専用で、保存はしない
// （docs/adr/agent-skills.md）。数が多いので既定では畳み、件数だけを見せる。
export function AgentSkills(props: { agent: ModelAgentKind }) {
  const [view, setView] = useState<AgentSkillsView | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState(false);

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
              view.skills.map((skill) => (
                <div class="hwc-skill-row" key={`${skill.source}:${skill.name}`}>
                  <span class="hwc-skill-name">{skill.name}</span>
                  <span class="hwc-skill-source">{skill.source}</span>
                  {skill.state === "off" ? <span class="hwc-skill-off">無効</span> : null}
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

import { useEffect, useState } from "preact/hooks";
import { MAX_PROJECTS, type ProjectEntry } from "../shared/projects";
import { readProjects } from "./api";
import { DialogShell } from "./Dialog";
import { filterProjects } from "./projects";
import { Spinner } from "./Spinner";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; projects: ProjectEntry[]; truncated: boolean }
  | { kind: "failed" };

type ProjectDialogProps = {
  paneId: string;
  open: boolean;
  onClose: () => void;
  onExited: () => void;
  onPick: (path: string) => void;
};

// マニフェストのあるディレクトリを、ペインの cwd から下だけ選ばせる。
// 選んだパスは本文へ入れるだけで、送信の形は変えない。
export function ProjectDialog(props: ProjectDialogProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    void readProjects(props.paneId, controller.signal).then((result) => {
      if (!active) return;
      setLoad(result === null ? { kind: "failed" } : { kind: "ready", ...result });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [props.paneId, attempt]);

  const visible = load.kind === "ready" ? filterProjects(load.projects, query) : [];

  return (
    <DialogShell
      role="dialog"
      className="hwc-project-dialog"
      labelledBy="hwc-project-title"
      open={props.open}
      onClose={props.onClose}
      onExited={props.onExited}
    >
      <h2 class="hwc-dialog-title" id="hwc-project-title">
        プロジェクトを選ぶ
      </h2>
      <p class="hwc-dialog-text">
        package.json や pyproject.toml
        などがあるディレクトリから選びます。選ぶと相対パスを入力欄へ入れます。
      </p>
      <label class="hwc-project-search">
        <span class="hwc-visually-hidden">プロジェクト名で絞り込む</span>
        <input
          class="hwc-create-input"
          type="search"
          value={query}
          placeholder="名前で絞り込む"
          autocomplete="off"
          data-autofocus
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>

      {load.kind === "loading" ? (
        <p class="hwc-project-state" role="status">
          <Spinner size={16} />
          読み込み中…
        </p>
      ) : load.kind === "failed" ? (
        <div class="hwc-project-state">
          <span role="status">プロジェクトを取得できませんでした。</span>
          <button
            type="button"
            class="hwc-project-retry"
            onClick={() => setAttempt((current) => current + 1)}
          >
            再試行
          </button>
        </div>
      ) : load.projects.length === 0 ? (
        <p class="hwc-project-state">このディレクトリ配下に他のプロジェクトはありません。</p>
      ) : visible.length === 0 ? (
        <p class="hwc-project-state">一致するプロジェクトがありません。</p>
      ) : (
        <div class="hwc-project-list" role="group" aria-label="プロジェクト">
          {visible.map((project) => (
            <button
              type="button"
              class="hwc-project-row"
              key={project.path}
              aria-label={`${project.name}（${project.path}）`}
              onClick={() => props.onPick(project.path)}
            >
              <span class="hwc-project-name">{project.name}</span>
              <span class="hwc-project-path">{project.path}</span>
            </button>
          ))}
        </div>
      )}

      {load.kind === "ready" && load.truncated ? (
        <p class="hwc-project-note">
          候補が多いため、先頭 {MAX_PROJECTS}{" "}
          件までを表示しています。見つからないプロジェクトは、そのディレクトリに近いペインで開いてください。
        </p>
      ) : null}

      <div class="hwc-project-footer">
        <button type="button" class="hwc-dialog-button hwc-dialog-cancel" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </DialogShell>
  );
}

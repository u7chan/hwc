import { composeInputText } from "../../shared/attachments";
import { attachmentExists, attachmentFilePath } from "../attachments";
import { createPane, startAgentInPane } from "../create-pane";
import {
  exceedsTextLimit,
  parseInputBody,
  parseOutputQuery,
  parseSplitBody,
  parseStartBody,
  TEXT_TOO_LONG,
  TEXT_WITH_ATTACHMENTS_TOO_LONG,
} from "../herdr/panes";
import { findPane } from "../herdr/state";
import { MAX_PANES_PER_TAB } from "../../shared/panes";
import { supportsFolderTrust } from "../../shared/agents";
import { HerdrError } from "../herdr/socket";
import type { AppContext, IdContext } from "./context";

export function createPanesHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    models,
    attachmentsRoot,
    current,
    folderTrust,
    launchModels,
    paneFailure,
    requestClose,
    findPaneTab,
  } = ctx;

  return {
    output: async (c: IdContext) => {
      const query = parseOutputQuery(new URL(c.req.url).searchParams);
      if (!query.ok) return c.json({ error: query.error }, query.status);

      try {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);
        const paneId = c.req.param("id");
        const pane = findPane(state, paneId);
        if (!pane) return c.json({ error: "pane_not_found" }, 404);
        folderTrust.retain(
          state.workspaces.flatMap((workspace) =>
            workspace.tabs.flatMap((tab) => tab.panes.map((item) => item.id)),
          ),
        );
        const output = await panes.read({ paneId, ...query.value });
        const interaction = await folderTrust.inspect(pane);
        return c.json({ ...output, interaction });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    clearOutput: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

      try {
        await panes.clear({ paneId });
        // 状態は変わらない。表示はクライアントが次の read で置き換える。
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    confirmFolderTrust: async (c: IdContext) => {
      const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof body?.id !== "string" || body.id.length === 0 || body.id.length > 128) {
        return c.json({ error: "invalid_request" }, 400);
      }
      try {
        const state = await store.refresh();
        const pane = findPane(state, c.req.param("id"));
        if (!pane) return c.json({ error: "pane_not_found" }, 404);
        const result = await folderTrust.accept(pane, body.id);
        if (result === "changed") return c.json({ error: "confirmation_changed" }, 409);
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    input: async (c: IdContext) => {
      // body は JSON として読み切ってから text のバイト数で上限を見る。Content-Type の検証で
      // browser の cross-origin は preflight に落ちるが、LAN の非 browser client はここまで
      // 到達し得る。その場合の巨大 body は Bun の body 読み込みに任せる。
      const body = await c.req.json().catch(() => null);
      const input = parseInputBody(body);
      if (!input.ok) return c.json({ error: input.error }, input.status);

      const paneId = c.req.param("id");
      const paths: string[] = [];
      const state = await current();
      const pane = state === null ? null : findPane(state, paneId);
      if (pane !== null && supportsFolderTrust(pane.agent)) {
        try {
          if (await folderTrust.inspect(pane))
            return c.json({ error: "confirmation_pending" }, 409);
        } catch (error) {
          return paneFailure(c, error);
        }
      }
      // 添付が無いときは Herdr の pane_not_found に任せる。ペインの実在を状態から引くと、
      // 従来の経路に余分な往復が増える。
      if (input.value.attachments.length > 0) {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const pane = findPane(state, paneId);
        if (!pane) return c.json({ error: "pane_not_found" }, 404);
        if (!pane.chat) return c.json({ error: "no_chat" }, 404);

        // 書式は parseInputBody が見ている。ここではこのペインの保存先の実在を確かめる。
        for (const name of input.value.attachments) {
          const path = attachmentFilePath(attachmentsRoot, paneId, name);
          if (path === null || !(await attachmentExists(attachmentsRoot, paneId, name))) {
            return c.json({ error: "invalid_request" }, 400);
          }
          paths.push(path);
        }
      }

      // 上限は注記を組み立てた後の本文で測る。パスの分だけ書ける量が減る。
      const text = composeInputText(input.value.text, paths);
      if (exceedsTextLimit(text)) {
        return c.json(
          { error: paths.length === 0 ? TEXT_TOO_LONG : TEXT_WITH_ATTACHMENTS_TOO_LONG },
          413,
        );
      }

      try {
        await panes.send({ paneId, text, submit: input.value.submit });
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    process: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

      try {
        return c.json({ process: await panes.process({ paneId }) });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    stop: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // シェルは前景プロセスを C-c で止める。プロンプトへの C-c は入力中の行を消すだけなので、
      // 何か動いているときだけ送る。画面が古いだけの再クリックは成功として扱う。
      if (pane.agent === null) {
        try {
          if ((await panes.process({ paneId })).running) await panes.interrupt({ paneId });
          return c.json({ ok: true });
        } catch (error) {
          return paneFailure(c, error);
        }
      }

      // 止まっているペインに Esc を送ると、入力欄やダイアログを閉じてしまう。
      // 画面が古いだけの再クリックは成功として扱い、状態の反映はイベントに任せる。
      if (pane.agentStatus !== "working") return c.json({ ok: true });

      try {
        if (supportsFolderTrust(pane.agent) && (await folderTrust.inspect(pane))) {
          return c.json({ error: "confirmation_pending" }, 409);
        }
        await panes.stop({ paneId });
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    focus: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

      try {
        await panes.focus({ paneId });
        // 状態の取り直しは Herdr のイベント（pane.focused / pane.agent_status_changed）に任せる。
        // ここで refresh を待つと、成功した focus が再取得の失敗で 502 になる。
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    close: (c: IdContext) => requestClose(c, "close"),
    exit: (c: IdContext) => requestClose(c, "exit"),
    split: async (c: IdContext) => {
      // 追加の指定（名前・起動するエージェント）は body から読む。body 無しは不正。
      const body = await c.req.json().catch(() => null);
      const request = parseSplitBody(body);
      if (!request.ok) return c.json({ error: request.error }, request.status);

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const tab = findPaneTab(state, paneId);
      if (tab === null) return c.json({ error: "pane_not_found" }, 404);
      // 画面が古い・同時に押された場合の取りこぼしを、Herdr を呼ぶ前に止める。
      if (tab.panes.length >= MAX_PANES_PER_TAB) return c.json({ error: "pane_limit" }, 409);

      try {
        const result = await createPane(panes, paneId, request.value, models);
        // 名前の付け直しに失敗してもエージェントは起動している。起動できた場合だけ、
        // 選んだモデルを会話に載るまでの表示に使う。
        if ((result.ok || result.error === "pane_rename_failed") && request.value.model != null) {
          launchModels.remember(result.paneId, request.value.model, request.value.effort ?? null);
        }
        if (!result.ok) {
          if (result.error === "pane_limit") return c.json({ error: result.error }, 409);
          return c.json({ error: result.error, paneId: result.paneId }, 502);
        }

        // 取り直しは pane.created に任せる。
        return c.json({ paneId: result.paneId });
      } catch (error) {
        return paneFailure(c, error);
      }
    },
    agent: async (c: IdContext) => {
      // 既存のシェルペインで起動する。名前は付け直さないので body に含めない。
      const body = await c.req.json().catch(() => null);
      const request = parseStartBody(body);
      if (!request.ok) return c.json({ error: request.error }, request.status);

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (pane === null) return c.json({ error: "pane_not_found" }, 404);
      // 画面が古い・TUI から先に起動された場合の取りこぼしを、Herdr を呼ぶ前に止める。
      if (pane.agent !== null) return c.json({ error: "pane_not_shell" }, 409);

      try {
        const failure = await startAgentInPane(panes, paneId, request.value, models);
        if (failure !== null) return c.json({ error: failure }, 502);
        // 分割 API と同じく、最初のメッセージを送るまでのモデル表示に使う。
        if (request.value.model != null) {
          launchModels.remember(paneId, request.value.model, request.value.effort ?? null);
        }
        // 取り直しは pane.updated に任せる。
        return c.json({ ok: true });
      } catch (error) {
        // 前景でコマンドが動いている。クライアントの 3 秒ポーリングが古い場合に届く。
        if (error instanceof HerdrError && error.code === "agent_pane_busy") {
          return c.json({ error: "pane_busy" }, 409);
        }
        return paneFailure(c, error);
      }
    },
  };
}

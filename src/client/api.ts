import { hc } from "hono/client";
import type { AppType } from "../server/app";

// BFF 側の期限: Herdr ソケット 8 秒、エージェント起動 30 秒、worktree 60 秒、git 60 秒。
// クライアントの期限はこれを目安に置く。

// テストでは絶対 URL を渡して $url を確かめる。本番は同一 origin なので空でよい。
export function createApiClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

export const client = createApiClient("");

// hc は path param をエスケープしない。ペイン id を 1 セグメントに保つ。
export function paneParam(paneId: string) {
  return { param: { id: encodeURIComponent(paneId) } };
}

// スペースの id も同じく 1 セグメントに保つ。
export function workspaceParam(workspaceId: string) {
  return { param: { id: encodeURIComponent(workspaceId) } };
}

// hc は validator のない query / body を入力型に含めない。実行時はそのまま送れるので、
// 呼び出し側で形を決め、body は変数にしてから渡す。オブジェクト literal のままでは弾かれる。
export function withJson<T>(param: { param: { id: string } }, json: T) {
  return { ...param, json };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// hc の応答は Response ではなく ClientResponse。どの口も読むのは ok と、本文か status だけ。
export type BodyResponse = { ok: boolean; json: () => Promise<unknown> };
// 既知のコードだけを通す判定とは別物。本文の error を文言にそのまま使う（通知・再起動・
// 定型文・編集）。既定は呼び出し側で違う（null / "unknown" / "edit_failed"）ので引数で受ける。
export function toErrorText<F extends string | null>(value: unknown, fallback: F): string | F {
  const error = asRecord(value)?.error;
  return typeof error === "string" ? error : fallback;
}

export type CloseOutcome = "done" | "failed";

// ペインが無い（BFF の状態に無い / Herdr が pane_not_found）なら、閉じる目的は達している。
export function closeOutcome(status: number): CloseOutcome {
  return status === 404 || (status >= 200 && status < 300) ? "done" : "failed";
}

// 送信中はダイアログから出られないので、応答が返らない経路をここで切る。
// BFF に届いた場合は Herdr 側の期限で終わるが、届かないと fetch が返らない。
export const CLOSE_TIMEOUT_MS = 8_000;

// 既知の error コードだけを通し、それ以外は既定へ落とす。既知の一覧は応答ごとに違う。
export function toKnownError<F extends string>(value: unknown, known: readonly F[]): F | "failed" {
  const error = asRecord(value)?.error;
  return known.find((item) => item === error) ?? "failed";
}

export function toId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export type CreationFailure<F extends string> = {
  error: F | "timeout" | "failed";
  workspaceId: string | null;
  paneId: string | null;
};

// 作成の失敗は部分成功した id を伴う。ID の有無で、再送してよい失敗かを見分ける。返る id の
// 範囲は作る対象で違うので広い形で返し、各関数の戻り値の型で絞る。
export function toCreationFailure<F extends string>(
  value: unknown,
  known: readonly F[],
): CreationFailure<F> {
  const record = asRecord(value);
  return {
    error: toKnownError(value, known),
    workspaceId: toId(record?.workspaceId),
    paneId: toId(record?.paneId),
  };
}

// 作成の目的は新しいスペースの最初のペイン。どちらかの id が無いと開けないので失敗にする。
export function toCreatedSpace(value: unknown): { workspaceId: string; paneId: string } | null {
  const record = asRecord(value);
  const workspaceId = toId(record?.workspaceId);
  const paneId = toId(record?.paneId);
  return workspaceId === null || paneId === null ? null : { workspaceId, paneId };
}

// 作成系の骨格（要求 → 応答 → 成功 / 失敗 / catch）。スペースとペインの id を返す作成は
// 同じ形なので、エンドポイント・期限・失敗の読み方・要求の組み立てだけを呼び出し側が持つ。
export async function createWithIds<F extends string>(
  send: (signal: AbortSignal) => Promise<BodyResponse>,
  toFailure: (body: unknown) => CreationFailure<F>,
  timeoutMs: number,
): Promise<
  { ok: true; workspaceId: string; paneId: string } | ({ ok: false } & CreationFailure<F>)
> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await send(signal);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, ...toFailure(body) };
    const created = toCreatedSpace(body);
    return created === null
      ? { ok: false, error: "failed", workspaceId: null, paneId: null }
      : { ok: true, ...created };
  } catch {
    // 応答が返らない・途中で切れた場合は、BFF が作成を終えているか分からない。作成済みを
    // 残したまま再送すると 2 つ目を作るので、期限切れと同じ結果不明に倒す。
    return {
      ok: false,
      error: signal.aborted ? "timeout" : "failed",
      workspaceId: null,
      paneId: null,
    };
  }
}

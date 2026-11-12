// 再起動はシェル文字列ではなく実行ファイルのパスで受ける。文字列を受けると、設定画面が
// 任意のコマンドを組み立てる入口になり、クォートの解釈も BFF と端末で食い違う。

export type RestartSettings = {
  // 実行ファイルの絶対パス。cwd を決め打ちできないので相対パスは受けない。
  command: string | null;
  // プル成功後に同じコマンドを実行するか。対象のリポジトリを絞るのはコマンド側の責務。
  afterPull: boolean;
};

export const DEFAULT_RESTART_SETTINGS: RestartSettings = { command: null, afterPull: false };

// スマホから貼れる長さに収める。パスとして妥当な範囲だけを受ける。
const MAX_COMMAND_LENGTH = 512;

// 未設定は null、受け付けない値は undefined。設定ファイルの読み込みと API の入力検証で
// 同じ関数を使う。
export function normalizeRestartCommand(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return null;
  if (raw.length > MAX_COMMAND_LENGTH) return undefined;
  if (!raw.startsWith("/")) return undefined;
  // 空白を含むパスは受けるが、改行や制御文字は受けない。ログや応答で行が割れる値を混ぜない。
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return raw;
}

export function parseRestartSettings(raw: unknown): RestartSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_RESTART_SETTINGS };
  const record = raw as { command?: unknown; afterPull?: unknown };
  const command = normalizeRestartCommand(record.command ?? null);
  return {
    command: command ?? null,
    afterPull: record.afterPull === true,
  };
}

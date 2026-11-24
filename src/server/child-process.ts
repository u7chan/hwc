export type ChildEnvOptions = {
  omit?: readonly string[];
  set?: Record<string, string>;
};

// 呼び出し元のプロセスの HERDR_ を継ぐと、起動した CLI は呼び出し元の Herdr ペインの
// ものとして状態を報告する。調査や候補取得のプロセスはペインに結び付けたくない。
// 呼び出しのたびに process.env から作る。モジュール読み込み時に固めると、E2E が実行時に
// 差し替える PATH が効かず、偽の CLI を通らない。
export function childEnv(options: ChildEnvOptions = {}): Record<string, string | undefined> {
  const { omit = [], set = {} } = options;
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HERDR_") || omit.includes(key)) continue;
    env[key] = value;
  }
  return { ...env, ...set };
}

export type CappedOutputOptions = {
  maxBytes: number;
  // 上限を超えたときの例外の文言は、機能ごとの失敗の呼び名に合わせて呼び出し側が決める。
  tooLarge: string;
};

export async function readCappedStdout(
  stream: ReadableStream<Uint8Array>,
  options: CappedOutputOptions,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > options.maxBytes) throw new Error(options.tooLarge);
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// hwc の帯に出す生成中の速度だけを書く。hwc が渡す HWC_CLAUDE_LIVE_DIR が無ければ何もしない。
// phase や本文は transcript から導くので、ここでは速度に専念する（ADR 0102）。

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// 差分の文字数はトークンの代理。短い窓で割ると桁が壊れるので、観測できる長さと回数を待つ。
const MIN_SPAN_MS = 400;
const MIN_ARRIVALS = 8;
const WRITE_EVERY_MS = 500;

let liveDir = "";
let sessionId = "";

function estimateTokens(text) {
  let tokens = 0;
  for (const char of text) tokens += (char.codePointAt(0) ?? 0) > 0x7f ? 1 : 0.25;
  return tokens;
}

async function publish($, rate) {
  if (liveDir === "" || sessionId === "") return;
  const body = JSON.stringify({ v: 1, sessionId, at: Date.now(), tokPerSecond: rate });
  try {
    await $.fs.write(`${liveDir}/${sessionId}.json`, body);
  } catch {
    // 速度は表示のためだけ。書けなくてもターンを止めない。
  }
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    try {
      const dir = await $.env.get("HWC_CLAUDE_LIVE_DIR");
      const id = String(await $.session.id());
      if (typeof dir === "string" && SESSION_ID.test(id)) {
        liveDir = dir.replace(/\/+$/, "");
        sessionId = id;
      }
    } catch {
      liveDir = "";
      sessionId = "";
    }
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    // サブエージェントの速度は本流の帯に混ぜない（ADR 0100 の sidechain 除外と揃える）。
    if (liveDir === "" || e.agentId !== undefined) {
      yield* next(e);
      return;
    }
    // 前のステップの速度を、次の要求の待ち時間に見せない。
    await publish($, null);

    let firstAt = 0;
    let tokens = 0;
    let arrivals = 0;
    let lastWrite = 0;

    for await (const chunk of next(e)) {
      if (chunk.kind === "text" || chunk.kind === "thinking" || chunk.kind === "input") {
        const text = chunk.kind === "input" ? chunk.json : chunk.text;
        const delta = estimateTokens(typeof text === "string" ? text : "");
        if (delta > 0) {
          tokens += delta;
          arrivals += 1;
          if (firstAt === 0) firstAt = performance.now();
        }
        const now = performance.now();
        const spanMs = firstAt === 0 ? 0 : now - firstAt;
        if (
          spanMs >= MIN_SPAN_MS &&
          arrivals >= MIN_ARRIVALS &&
          now - lastWrite >= WRITE_EVERY_MS
        ) {
          const rate = tokens / (spanMs / 1000);
          if (Number.isFinite(rate) && rate >= 1) {
            lastWrite = now;
            await publish($, Math.round(rate * 10) / 10);
          }
        }
      } else if (chunk.kind === "stop") {
        await publish($, null);
      }
      yield chunk;
    }
  });

  // 中断では stop が来ないことがある。ターンの終わりに消す。
  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) await publish($, null);
    return next(e);
  });
}

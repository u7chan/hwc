// 会話を読めないのは一時的なことが多い（セッション未作成、エージェント未起動、API 停止）。
// 呼び出し側は端末出力へフォールバックする。
export class ChatUnavailableError extends Error {}

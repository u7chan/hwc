// mypi の ask_user と hwc が共有する制限値（docs/adr/pi-integration.md）。
// mypi 側の実装と揃える。片方だけ変えると、読めないファイルを無いものとして扱う分だけが
// 増え、質問も回答も届かなくなる。
export const ASK_QUESTION_MAX = 500;
export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 6;
export const ASK_OPTION_MAX = 120;
export const ASK_TEXT_MAX = 2_000;
export const ASK_PENDING_MAX_BYTES = 8 * 1024;
export const ASK_ANSWER_MAX_BYTES = 16 * 1024;

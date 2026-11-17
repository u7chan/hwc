export function normalizePreviewText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// 末尾の改行は最後の行を終えるだけなので、行番号を増やさない。
export function previewLineNumbers(text: string): string {
  if (text === "") return "";
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (index === text.length - 1) continue;
    count += 1;
  }
  const numbers: string[] = [];
  for (let number = 1; number <= count; number += 1) numbers.push(String(number));
  return numbers.join("\n");
}

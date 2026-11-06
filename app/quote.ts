/** Append a Markdown blockquote without replacing the user's unfinished draft. */
export function appendQuote(draft: string, markdown: string): string {
  if (!markdown.trim()) return draft;
  const quote = markdown.trim().replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
  return `${draft ? `${draft.trimEnd()}\n\n` : ""}${quote}\n\n`;
}

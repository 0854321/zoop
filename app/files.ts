/** A Markdown document (an agent's report) rather than an image: shown as a file card, opened in a reader. */
export const isDoc = (url: string) => /\.(md|markdown)(\?|$)/i.test(url);
/** An attachment's file name for display, without the storage timestamps ("1731-1732-report.md" → "report.md"). */
export const attachmentName = (url: string) => {
  const last = decodeURIComponent(url.replace(/[?#].*$/, "").split("/").pop() || "");
  return last.replace(/^(\d{10,}-)+/, "") || last;
};

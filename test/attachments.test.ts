import { expect, test } from "bun:test";
import { attachmentName, isDoc } from "../app/files";

test("markdown attachments are documents, images are not", () => {
  expect(isDoc("/media/1731-report.md")).toBe(true);
  expect(isDoc("/media/1731-notes.markdown?token=x")).toBe(true);
  expect(isDoc("/media/1731-shot.png")).toBe(false);
});

test("attachment names drop the storage timestamps", () => {
  expect(attachmentName("/media/1762650000000-1762650000123-push-notifications.md")).toBe("push-notifications.md");
  expect(attachmentName("https://hub.example/media/1762650000000-report.md?token=x")).toBe("report.md");
  expect(attachmentName("/media/plain.md")).toBe("plain.md");
});

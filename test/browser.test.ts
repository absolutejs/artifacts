import { expect, test } from "bun:test";
import { renderDocxPreview } from "../src/browser";
test("rejects empty and oversized previews before loading a browser renderer", async () => {
 await expect(renderDocxPreview(new ArrayBuffer(0))).rejects.toThrow("10 MB");
 await expect(renderDocxPreview(new ArrayBuffer(10 * 1024 * 1024 + 1))).rejects.toThrow("10 MB");
});

import { documentPreviewHref } from "../src/browser";
test("preview links accept only HTTPS or plain email without credentials or control characters", () => {
 expect(documentPreviewHref("https://absolutejs.com")).toBe("https://absolutejs.com/");
 expect(documentPreviewHref("mailto:alex@example.com")).toBe("mailto:alex@example.com");
 for (const href of [null, "javascript:alert(1)", "data:text/html,hello", "//example.com", "http://example.com", "https://user:pass@example.com", "https://exam\nple.com", "mailto:a@example.com?body=hello"]) expect(documentPreviewHref(href)).toBeNull();
});

import { expect, test } from "bun:test";
import { renderDocxPreview } from "../src/browser";
test("rejects empty and oversized previews before loading a browser renderer", async () => {
 await expect(renderDocxPreview(new ArrayBuffer(0))).rejects.toThrow("10 MB");
 await expect(renderDocxPreview(new ArrayBuffer(10 * 1024 * 1024 + 1))).rejects.toThrow("10 MB");
});

import { expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { renderFormattedDocx } from "./docx";
test("formatted exports preserve text, real bullets, headings, Unicode and clickable links", () => {
  const result = renderFormattedDocx({
    blocks: [
      { kind: "heading", runs: [{ text: "Alex & engineering" }] },
      {
        kind: "paragraph",
        runs: [
          { text: "Build <software>", bold: true },
          { text: " résumé →", href: "https://example.com/?a=1&b=2" },
        ],
      },
      { kind: "bullet", runs: [{ text: "Delivered\nSafely", italic: true }] },
    ],
  });
  const files = unzipSync(result.body as Uint8Array);
  const doc = strFromU8(files["word/document.xml"]!);
  expect(doc).toContain("Alex &amp; engineering");
  expect(doc).toContain("Build &lt;software&gt;");
  expect(doc).toContain("w:numPr");
  expect(doc).toContain("w:hyperlink");
  expect(doc).toContain("<w:br/>");
  expect(strFromU8(files["word/_rels/document.xml.rels"]!)).toContain(
    "https://example.com/?a=1&amp;b=2",
  );
  expect(strFromU8(files["word/styles.xml"]!)).toContain('w:sz w:val="23"');
  expect(result.filename).toBe("document.docx");
});
test("export rejects active links and oversized documents without fetching resources", () => {
  for (const href of [
    "javascript:alert(1)",
    "file:///secret",
    "https://user:password@example.com",
  ])
    expect(() =>
      renderFormattedDocx({
        blocks: [{ kind: "paragraph", runs: [{ text: "link", href }] }],
      }),
    ).toThrow();
  expect(() => renderFormattedDocx({ blocks: [] })).toThrow();
  expect(() =>
    renderFormattedDocx({
      blocks: [{ kind: "paragraph", runs: [{ text: "x".repeat(1048577) }] }],
    }),
  ).toThrow();
});
import { documentBlocksFromText } from "./docx";
test("text formatting keeps paragraphs and bullets distinct without interpreting HTML", () => {
  const blocks = documentBlocksFromText(
    "# Profile\n\nHello **team**.\n\n- Built [site](https://example.com)\n- Shipped <script>literal</script>",
  );
  expect(blocks.map((b) => b.kind)).toEqual([
    "heading",
    "paragraph",
    "bullet",
    "bullet",
  ]);
  expect(blocks[1]?.runs.some((r) => r.bold && r.text === "team")).toBe(true);
  expect(blocks[2]?.runs.find((r) => r.href)?.href).toBe(
    "https://example.com/",
  );
  expect(blocks[3]?.runs[0]?.text).toContain("<script>");
});

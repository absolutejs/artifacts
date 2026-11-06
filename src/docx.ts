import { zipSync, strToU8 } from "fflate";
import type { ArtifactRenderResult } from "./renderers";

export type DocumentRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  href?: string;
};
export type DocumentBlock = {
  kind: "heading" | "paragraph" | "bullet";
  runs: DocumentRun[];
  level?: 1 | 2;
};
export type FormattedDocument = {
  blocks: DocumentBlock[];
  filename?: string;
  pageSize?: "letter" | "a4";
};
const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const linkTarget = (href: string) => {
  if (/\s/.test(href)) throw new Error("Invalid document link");
  const url = new URL(href);
  if (
    !["https:", "mailto:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Unsupported document link");
  return url.href;
};
/** Produces a macro-free, editable Word document with real paragraphs, headings,
 * bullet numbering and external hyperlinks. It never fetches links or embeds HTML. */
export const renderFormattedDocx = (
  document: FormattedDocument,
): ArtifactRenderResult => {
  if (!document.blocks.length || document.blocks.length > 2000)
    throw new Error("Document requires 1–2000 blocks");
  if (new TextEncoder().encode(JSON.stringify(document)).length > 1024 * 1024)
    throw new Error("Document exceeds 1 MB");
  const relationships: string[] = [];
  const paragraphs = document.blocks
    .map((block) => {
      if (
        !["heading", "paragraph", "bullet"].includes(block.kind) ||
        !Array.isArray(block.runs)
      )
        throw new Error("Invalid document block");
      const style =
        block.kind === "heading"
          ? `<w:pStyle w:val="Heading${block.level === 2 ? 2 : 1}"/><w:keepNext/>`
          : "";
      const bullet =
        block.kind === "bullet"
          ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
          : "";
      const runs = block.runs
        .map((run) => {
          if (typeof run.text !== "string")
            throw new Error("Invalid document text");
          const properties = `${run.bold ? "<w:b/>" : ""}${run.italic ? "<w:i/>" : ""}${run.href ? '<w:color w:val="245A81"/><w:u w:val="single"/>' : ""}`;
          const text = run.text
            .split("\n")
            .map(
              (line, index) =>
                `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${xml(line)}</w:t>`,
            )
            .join("");
          const content = `<w:r><w:rPr>${properties}</w:rPr>${text}</w:r>`;
          if (!run.href) return content;
          const id = `link${relationships.length + 1}`;
          relationships.push(
            `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(linkTarget(run.href))}" TargetMode="External"/>`,
          );
          return `<w:hyperlink r:id="${id}">${content}</w:hyperlink>`;
        })
        .join("");
      return `<w:p><w:pPr>${style}${bullet}</w:pPr>${runs}</w:p>`;
    })
    .join("");
  const width = document.pageSize === "a4" ? 11906 : 12240;
  const height = document.pageSize === "a4" ? 16838 : 15840;
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const rels = "http://schemas.openxmlformats.org/package/2006/relationships";
  const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const files: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${rels}"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<w:document xmlns:w="${word}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"/><w:pgMar w:top="900" w:right="1000" w:bottom="900" w:left="1000" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="${rels}"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${relationships.join("")}</Relationships>`,
    "word/styles.xml": `<w:styles xmlns:w="${word}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="23"/><w:color w:val="202A35"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="264" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`,
    "word/numbering.xml": `<w:numbering xmlns:w="${word}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="300"/></w:tabs><w:ind w:left="300" w:hanging="220"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  };
  return {
    body: zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, value]) => [
          name,
          strToU8(header + value),
        ]),
      ),
    ),
    filename:
      (document.filename ?? "document")
        .replace(/[^a-zA-Z0-9 _.-]/g, "")
        .replace(/\.docx$/i, "")
        .slice(0, 120) + ".docx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
};

/** Deliberately small text format: blank-line paragraphs, #/## headings,
 * dash, star or dot bullets, **bold**, [label](https://...) links and bare HTTPS URLs.
 * Unsupported markup remains literal text; no HTML is interpreted. */
export const documentBlocksFromText = (text: string): DocumentBlock[] => {
  const inline = (text: string): DocumentRun[] => {
    const runs: DocumentRun[] = [];
    const pattern =
      /\[([^\]\n]+)\]\((https:\/\/[^\s)]+|mailto:[^\s)]+)\)|\*\*([^*\n]+)\*\*|https:\/\/[^\s<>]+/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor)
        runs.push({ text: text.slice(cursor, match.index) });
      if (match[1] && match[2])
        runs.push({ text: match[1], href: linkTarget(match[2]) });
      else if (match[3]) runs.push({ text: match[3], bold: true });
      else {
        const href = match[0].replace(/[.,;!?]+$/, "");
        runs.push({ text: href, href: linkTarget(href) });
        if (href.length < match[0].length)
          runs.push({ text: match[0].slice(href.length) });
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) runs.push({ text: text.slice(cursor) });
    return runs;
  };
  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", runs: inline(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
    if (heading || bullet) {
      flush();
      blocks.push(
        heading
          ? {
              kind: "heading",
              level: heading[1]!.length as 1 | 2,
              runs: inline(heading[2]!),
            }
          : { kind: "bullet", runs: inline(bullet![1]!) },
      );
    } else paragraph.push(line);
  }
  flush();
  return blocks;
};

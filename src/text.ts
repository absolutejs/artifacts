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
export const documentLinkTarget = (href: string) => {
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
        runs.push({ text: match[1], href: documentLinkTarget(match[2]) });
      else if (match[3]) runs.push({ text: match[3], bold: true });
      else {
        const href = match[0].replace(/[.,;!?]+$/, "");
        runs.push({ text: href, href: documentLinkTarget(href) });
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

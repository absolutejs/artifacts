export {
  documentBlocksFromText,
  type DocumentBlock,
  type DocumentRun,
} from "./text";
export const documentPreviewHref = (value: string | null): string | null => {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (/^mailto:[^@?]+@[^@?]+\.[^@?]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** Browser-only DOCX rendering. Display the result in an iframe with sandbox="".
 * No document content or credentials are sent to a third-party viewer. */
export const renderDocxPreview = async (
  data: ArrayBuffer,
  options: { allowLinks?: boolean } = {},
): Promise<string> => {
  if (!data.byteLength || data.byteLength > 10 * 1024 * 1024)
    throw new Error("Document must be between 1 byte and 10 MB");
  const { renderAsync } = await import("docx-preview");
  const isolated =
    document.implementation.createHTMLDocument("Document preview");
  await renderAsync(data, isolated.body, isolated.head, {
    useBase64URL: true,
    renderAltChunks: false,
    renderComments: false,
    ignoreLastRenderedPageBreak: false,
    hideWrapperOnPrint: true,
  });
  // Remove active content and navigation before inserting into the sandbox.
  isolated
    .querySelectorAll("script, iframe, object, embed, form, link, meta, base")
    .forEach((node) => node.remove());
  isolated.querySelectorAll("*").forEach((node) => {
    const href =
      options.allowLinks && node.tagName === "A"
        ? documentPreviewHref(node.getAttribute("href"))
        : null;
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "href" ||
        name === "xlink:href" ||
        name === "srcdoc" ||
        (name === "src" && !/^data:image\//i.test(attribute.value))
      )
        node.removeAttribute(attribute.name);
    }
    if (href) {
      node.setAttribute("href", href);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
  });
  isolated.querySelectorAll<HTMLElement>("section.docx").forEach((page) => {
    const width = page.style.width;
    if (/^[0-9.]+(pt|px|in)$/.test(width))
      page.style.zoom = `min(1, calc((100vw - 48px) / ${width}))`;
  });
  isolated.querySelectorAll("style").forEach((style) => {
    style.textContent = (style.textContent ?? "").replace(
      /font-family: ([^;]+);/g,
      "font-family: $1, Arial, sans-serif;",
    );
  });
  const policy = isolated.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  isolated.head.prepend(policy);
  const style = isolated.createElement("style");
  style.textContent =
    "body{margin:0;background:#edf0f4}.docx-wrapper{padding:24px!important;background:#edf0f4!important;align-items:safe center!important}section.docx{box-shadow:0 2px 12px #18203314!important}";
  isolated.head.append(style);
  return "<!doctype html>" + isolated.documentElement.outerHTML;
};

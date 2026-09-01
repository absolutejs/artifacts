import { unzipSync } from "fflate";
import type {
  ArtifactGenerationResult,
  ArtifactGenerationValidationIssue,
} from "./generators";

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

const issue = (
  code: string,
  message: string,
  path?: string,
): ArtifactGenerationValidationIssue => ({
  code,
  message,
  ...(path ? { path } : {}),
});

const parseCsvRows = (value: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((cell) => cell.length > 0));
};

const validateCsv = (data: Uint8Array, path: string) => {
  const rows = parseCsvRows(decode(data));
  if (rows.length === 0) return [issue("csv_empty", "CSV has no rows", path)];
  const columns = rows[0]!.length;
  const inconsistent = rows.findIndex((row) => row.length !== columns);

  return inconsistent < 0
    ? []
    : [
        issue(
          "csv_column_mismatch",
          `CSV row ${inconsistent + 1} has ${rows[inconsistent]!.length} columns; expected ${columns}`,
          path,
        ),
      ];
};

const validateEmail = (data: Uint8Array, path: string) => {
  const value = decode(data).replace(/\r\n?/g, "\n");
  const separator = value.indexOf("\n\n");
  if (separator < 0) {
    return [
      issue(
        "email_missing_body_separator",
        "Email must contain headers followed by a blank line and body",
        path,
      ),
    ];
  }
  const headers = value.slice(0, separator);
  const required = ["to", "subject"].filter(
    (name) => !new RegExp(`^${name}:\\s*\\S+`, "imu").test(headers),
  );

  return required.map((name) =>
    issue(
      "email_missing_header",
      `Email is missing a non-empty ${name} header`,
      path,
    ),
  );
};

const validateXml = (value: string) => {
  const stack: string[] = [];
  const withoutOpaqueSections = value
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "")
    .replace(/<\?[\s\S]*?\?>/gu, "");
  for (const match of withoutOpaqueSections.matchAll(
    /<\s*(\/?)\s*([\w:.-]+)([^>]*)>/gu,
  )) {
    const closing = match[1] === "/";
    const name = match[2]!;
    const suffix = match[3] ?? "";
    if (!closing && suffix.trimEnd().endsWith("/")) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    const expected = stack.pop();
    if (expected !== name) {
      throw new Error(
        expected
          ? `expected closing tag for <${expected}> but found </${name}>`
          : `unexpected closing tag </${name}>`,
      );
    }
  }
  if (stack.length > 0) throw new Error(`unclosed tag <${stack.at(-1)}>`);
};

const validateZip = (
  data: Uint8Array,
  path: string,
  officePresentation: boolean,
) => {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch (error) {
    return [
      issue(
        "zip_invalid",
        `ZIP archive could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ),
    ];
  }
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  if (names.length === 0) {
    return [issue("zip_empty", "ZIP archive has no files", path)];
  }
  if (!officePresentation) return [];
  const required = ["[Content_Types].xml", "ppt/presentation.xml"];
  const missing = required.filter((name) => !entries[name]);
  if (!names.some((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))) {
    missing.push("ppt/slides/slide*.xml");
  }
  const issues = missing.map((name) =>
    issue(
      "presentation_entry_missing",
      `Presentation is missing ${name}`,
      path,
    ),
  );
  for (const name of names.filter(
    (candidate) => candidate.endsWith(".xml") || candidate.endsWith(".rels"),
  )) {
    try {
      validateXml(decode(entries[name]!));
    } catch (error) {
      issues.push(
        issue(
          "presentation_xml_invalid",
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
          path,
        ),
      );
    }
  }

  return issues;
};

/** Validate common generated download formats before an artifact is committed. */
export const validateGeneratedArtifactFormats = (
  result: ArtifactGenerationResult,
): ArtifactGenerationValidationIssue[] =>
  (result.assets ?? []).flatMap((asset, index) => {
    const mediaType = asset.mediaType.toLowerCase();
    const path = `assets[${index}](${asset.name})`;
    try {
      if (mediaType.includes("csv")) return validateCsv(asset.data, path);
      if (mediaType === "message/rfc822")
        return validateEmail(asset.data, path);
      if (mediaType.includes("presentationml.presentation")) {
        return validateZip(asset.data, path, true);
      }
      if (mediaType.includes("zip"))
        return validateZip(asset.data, path, false);
      return [];
    } catch (error) {
      return [
        issue(
          "format_invalid",
          error instanceof Error ? error.message : String(error),
          path,
        ),
      ];
    }
  });

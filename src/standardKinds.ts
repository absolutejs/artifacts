import { Type } from "@sinclair/typebox";
import type { ArtifactKindDefinitions } from "./registry";

const FileArtifactContentSchema = Type.Object({
  description: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});

const capabilities = [
  "attach",
  "archive",
  "edit",
  "export",
  "preview",
  "refine",
] as const;

const fileKind = (
  label: string,
  acceptedMediaTypes: string[],
  maxCount = 1,
) => ({
  assets: { acceptedMediaTypes, maxCount },
  capabilities: [...capabilities],
  content: FileArtifactContentSchema,
  label,
  schemaVersion: 1,
});

export const standardArtifactDefinitions = {
  archive: fileKind(
    "Archive",
    [
      "application/gzip",
      "application/vnd.rar",
      "application/x-7z-compressed",
      "application/x-bzip2",
      "application/x-tar",
      "application/zip",
    ],
    20,
  ),
  audio: fileKind("Audio", ["audio/*"]),
  code: fileKind(
    "Code",
    ["application/json", "application/xml", "text/*"],
    100,
  ),
  dataset: fileKind(
    "Dataset",
    [
      "application/json",
      "application/x-ndjson",
      "application/xml",
      "text/csv",
      "text/tab-separated-values",
      "text/plain",
      "text/yaml",
    ],
    20,
  ),
  document: fileKind(
    "Document",
    [
      "application/epub+zip",
      "application/msword",
      "application/pdf",
      "application/rtf",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/*",
    ],
    20,
  ),
  email: fileKind(
    "Email",
    ["application/mbox", "application/vnd.ms-outlook", "message/*", "text/*"],
    100,
  ),
  file: fileKind("File", ["*/*"], 100),
  image: fileKind("Image", ["image/*"], 20),
  presentation: fileKind(
    "Presentation",
    [
      "application/pdf",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    20,
  ),
  spreadsheet: fileKind(
    "Spreadsheet",
    [
      "application/vnd.ms-excel",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "text/tab-separated-values",
    ],
    20,
  ),
  video: fileKind("Video", ["video/*"]),
} satisfies ArtifactKindDefinitions;

export const STANDARD_ARTIFACT_KIND_NAMES = Object.keys(
  standardArtifactDefinitions,
) as Array<keyof typeof standardArtifactDefinitions>;

export const ARTIFACT_STATUSES = ["draft", "published", "archived"] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export type ArtifactCapability =
  | "archive"
  | "edit"
  | "export"
  | "preview"
  | "publish"
  | "refine";

export type ArtifactProvenance = {
  model?: string;
  sourceIds?: string[];
  tool?: string;
  traceId?: string;
};

export type ArtifactPublication = {
  id: string;
  publishedAt: string;
  url: string;
};

export type ArtifactRecord<TContent = unknown> = {
  capabilities: ArtifactCapability[];
  content: TContent;
  createdAt: string;
  createdBy: string;
  id: string;
  kind: string;
  metadata: Record<string, unknown>;
  ownerId: string;
  provenance?: ArtifactProvenance;
  publication?: ArtifactPublication;
  revision: number;
  schemaVersion: number;
  status: ArtifactStatus;
  title: string;
  updatedAt: string;
};

export type ArtifactListQuery = {
  kind?: string;
  limit?: number;
  status?: ArtifactStatus;
};

export type ArtifactCreateInput = {
  content: unknown;
  createdBy: string;
  kind: string;
  metadata?: Record<string, unknown>;
  provenance?: ArtifactProvenance;
  title: string;
};

export type ArtifactUpdateInput = {
  content?: unknown;
  expectedRevision?: number;
  metadata?: Record<string, unknown>;
  title?: string;
};

export type ArtifactErrorCode =
  | "conflict"
  | "invalid_content"
  | "not_found"
  | "publisher_unavailable"
  | "renderer_unavailable"
  | "unsupported_capability"
  | "unknown_kind";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

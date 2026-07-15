export const ARTIFACT_STATUSES = ["draft", "published", "archived"] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export type ArtifactCapability =
  | "attach"
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

export type ArtifactAssetRole = "attachment" | "primary" | "preview" | "source";

export type ArtifactAssetReference = {
  checksum?: {
    algorithm: "sha256";
    value: string;
  };
  id: string;
  mediaType: string;
  metadata?: Record<string, unknown>;
  name: string;
  role: ArtifactAssetRole;
  size: number;
  /** Opaque host storage locator. It is not required to be publicly fetchable. */
  uri: string;
};

export type ArtifactAssetWriteInput = {
  data: Uint8Array;
  mediaType: string;
  metadata?: Record<string, unknown>;
  name: string;
  role?: ArtifactAssetRole;
};

export type ArtifactRecord<TContent = unknown> = {
  assets: ArtifactAssetReference[];
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

/** An immutable point-in-time copy of an artifact record. */
export type ArtifactRevision<TContent = unknown> = Readonly<
  ArtifactRecord<TContent>
>;

export type ArtifactListQuery = {
  kind?: string;
  limit?: number;
  status?: ArtifactStatus;
};

export type ArtifactCreateInput = {
  assets?: ArtifactAssetReference[];
  content: unknown;
  createdBy: string;
  kind: string;
  metadata?: Record<string, unknown>;
  provenance?: ArtifactProvenance;
  title: string;
};

export type ArtifactUpdateInput = {
  assets?: ArtifactAssetReference[];
  content?: unknown;
  expectedRevision?: number;
  metadata?: Record<string, unknown>;
  title?: string;
};

export type ArtifactErrorCode =
  | "asset_store_unavailable"
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

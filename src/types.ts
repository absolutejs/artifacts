export const ARTIFACT_STATUSES = ["draft", "published", "archived"] as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;

  return Object.values(value).every(isJsonValue);
}

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
  lineage?: ArtifactLineageReference[];
  model?: string;
  sourceIds?: string[];
  tool?: string;
  traceId?: string;
};

export type ArtifactLineageRelation =
  | "derived_from"
  | "generated_from"
  | "references"
  | "replaces";

export type ArtifactLineageReference = {
  artifactId?: string;
  relation: ArtifactLineageRelation;
  revision?: number;
  sourceId?: string;
};

export type ArtifactPublication = {
  id: string;
  mode: "live" | "pinned";
  publishedAt: string;
  revision: number;
  url: string;
};

export type ArtifactAssetRole = "attachment" | "primary" | "preview" | "source";

export type ArtifactAssetReference = {
  checksum?: {
    algorithm: "sha256";
    value: string;
  };
  id: string;
  createdAt: string;
  mediaType: string;
  metadata?: JsonObject;
  name: string;
  role: ArtifactAssetRole;
  size: number;
  /** Opaque host storage locator. It is not required to be publicly fetchable. */
  uri: string;
};

export type ArtifactAssetWriteInput = {
  data: Uint8Array;
  mediaType: string;
  metadata?: JsonObject;
  name: string;
  role?: ArtifactAssetRole;
};

export type ArtifactRecord<TContent = JsonValue> = {
  assets: ArtifactAssetReference[];
  capabilities: ArtifactCapability[];
  content: TContent;
  createdAt: string;
  createdBy: string;
  id: string;
  kind: string;
  metadata: JsonObject;
  ownerId: string;
  provenance?: ArtifactProvenance;
  publication?: ArtifactPublication;
  revision: number;
  schemaVersion: number;
  status: ArtifactStatus;
  title: string;
  updatedAt: string;
};

export const ARTIFACT_EVENT_TYPES = [
  "artifact.archived",
  "artifact.asset_attached",
  "artifact.asset_detached",
  "artifact.created",
  "artifact.generated",
  "artifact.indexing_changed",
  "artifact.published",
  "artifact.restored",
  "artifact.revised",
  "artifact.unpublished",
] as const;

export type ArtifactEventType = (typeof ARTIFACT_EVENT_TYPES)[number];

export type ArtifactEvent = {
  artifactId: string;
  createdAt: string;
  id: string;
  ownerId: string;
  payload?: JsonObject;
  processedAt?: string;
  revision: number;
  type: ArtifactEventType;
};

export type ArtifactEventQuery = {
  limit?: number;
  processed?: boolean;
  type?: ArtifactEventType;
};

export type ArtifactIndexingStatus = "failed" | "indexed" | "pending" | "stale";

export type ArtifactIndexingState = {
  artifactId: string;
  documentIds: string[];
  error?: string;
  indexedAt?: string;
  revision: number;
  status: ArtifactIndexingStatus;
  updatedAt: string;
};

/** An immutable point-in-time copy of an artifact record. */
export type ArtifactRevision<TContent = JsonValue> = Readonly<
  ArtifactRecord<TContent>
>;

export type ArtifactListQuery = {
  kind?: string;
  limit?: number;
  status?: ArtifactStatus;
};

export type ArtifactCreateInput = {
  assets?: ArtifactAssetReference[];
  content: JsonValue;
  createdBy: string;
  kind: string;
  metadata?: JsonObject;
  provenance?: ArtifactProvenance;
  title: string;
};

export type ArtifactUpdateInput = {
  assets?: ArtifactAssetReference[];
  content?: JsonValue;
  expectedRevision?: number;
  metadata?: JsonObject;
  title?: string;
};

export type ArtifactBundleCreateInput = Omit<ArtifactCreateInput, "assets"> & {
  assets?: ArtifactAssetWriteInput[];
};

export type ArtifactPublishInput = {
  mode?: "live" | "pinned";
};

export type ArtifactRetentionCandidate = {
  createdAt: string;
  reference: ArtifactAssetReference;
};

export type ArtifactGarbageCollectionResult = {
  deleted: ArtifactAssetReference[];
  retained: ArtifactAssetReference[];
};

export type ArtifactErrorCode =
  | "asset_store_unavailable"
  | "asset_transaction_unavailable"
  | "conflict"
  | "generator_unavailable"
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

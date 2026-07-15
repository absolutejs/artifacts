/**
 * `@absolutejs/artifacts` — the typed lifecycle for things an AI makes.
 *
 * Hosts define artifact kinds with structured content schemas, then compose a
 * storage adapter, optional publisher, renderers, and agent tools. The package
 * owns validation, revisions, lifecycle semantics, and contracts; the host
 * retains authorization, persistence, URLs, UI, and delivery policy.
 */

export {
  defineArtifactRegistry,
  type ArtifactContent,
  type ArtifactKindDefinition,
  type ArtifactKindDefinitions,
  type ArtifactRegistry,
} from "./registry";
export {
  createArtifactGeneratorRegistry,
  type ArtifactBundleCreator,
  type ArtifactGenerationContext,
  type ArtifactGenerationInput,
  type ArtifactGenerationResult,
  type ArtifactGenerator,
  type ArtifactGeneratorRegistry,
} from "./generators";
export {
  STANDARD_ARTIFACT_KIND_NAMES,
  standardArtifactDefinitions,
} from "./standardKinds";
export {
  createArtifactRendererRegistry,
  type ArtifactRenderer,
  type ArtifactRendererRegistry,
  type ArtifactRenderResult,
} from "./renderers";
export {
  createArtifactService,
  type ArtifactPublisher,
  type ArtifactService,
  type ArtifactServiceOptions,
} from "./service";
export {
  createMemoryArtifactStore,
  createMemoryArtifactAssetStore,
  type ArtifactAssetStore,
  type ArtifactAssetTransaction,
  type ArtifactStore,
} from "./store";
export {
  createArtifactTools,
  type ArtifactToolDefinition,
  type ArtifactToolMap,
  type ArtifactToolOptions,
} from "./tools";
export {
  ARTIFACT_STATUSES,
  ARTIFACT_EVENT_TYPES,
  ArtifactError,
  type ArtifactAssetReference,
  type ArtifactAssetRole,
  type ArtifactAssetWriteInput,
  type ArtifactBundleCreateInput,
  type ArtifactCapability,
  type ArtifactCreateInput,
  type ArtifactErrorCode,
  type ArtifactEvent,
  type ArtifactEventQuery,
  type ArtifactEventType,
  type ArtifactGarbageCollectionResult,
  type ArtifactIndexingState,
  type ArtifactIndexingStatus,
  type ArtifactListQuery,
  type ArtifactLineageReference,
  type ArtifactLineageRelation,
  type ArtifactProvenance,
  type ArtifactPublication,
  type ArtifactPublishInput,
  type ArtifactRecord,
  type ArtifactRevision,
  type ArtifactRetentionCandidate,
  type ArtifactStatus,
  type ArtifactUpdateInput,
} from "./types";

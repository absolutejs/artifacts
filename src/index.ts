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
export { createMemoryArtifactStore, type ArtifactStore } from "./store";
export {
  createArtifactTools,
  type ArtifactToolDefinition,
  type ArtifactToolMap,
  type ArtifactToolOptions,
} from "./tools";
export {
  ARTIFACT_STATUSES,
  ArtifactError,
  type ArtifactCapability,
  type ArtifactCreateInput,
  type ArtifactErrorCode,
  type ArtifactListQuery,
  type ArtifactProvenance,
  type ArtifactPublication,
  type ArtifactRecord,
  type ArtifactStatus,
  type ArtifactUpdateInput,
} from "./types";

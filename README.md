# @absolutejs/artifacts

The typed lifecycle for things an AI makes.

An AI-generated page, report, plan, email, deck, or image should not disappear
into a chat transcript or become an unvalidated blob. It should have a kind,
structured content, ownership, provenance, revisions, capabilities, renderers,
and an explicit publication lifecycle.

`@absolutejs/artifacts` provides those contracts without owning your database,
routes, authorization, UI, or hosting.

## What it owns

- Structured artifact-kind schemas and runtime validation
- Draft, published, and archived lifecycle states
- Immutable revision history, restoration, and optimistic updates
- Structured content plus opaque references to generated or source files
- Artifact, asset, renderer, and publisher storage interfaces
- In-memory artifact and asset stores for development and tests
- Owner-bound lifecycle tools structurally compatible with AI tool maps
- Provenance fields for model, tool, trace, and source entities
- Standard file-backed kinds for documents, presentations, spreadsheets,
  datasets, code, images, audio, video, email, archives, and generic files
- An optional bridge to `@absolutejs/rag` ingestion
- Provider-neutral generation registries with atomic multi-file bundles
- Revision-pinned or explicitly live publications
- Durable lifecycle events designed for transactional outboxes
- Per-revision RAG indexing state and an indexing coordinator
- Artifact/source lineage and history-aware asset garbage collection

Your application retains authorization, durable persistence, public tokens,
URLs, notifications, analytics, submissions, and product-specific rendering.

## Define kinds once

```ts
import { Type } from "@sinclair/typebox";
import {
  createArtifactService,
  createMemoryArtifactAssetStore,
  createMemoryArtifactStore,
  defineArtifactRegistry,
} from "@absolutejs/artifacts";

const registry = defineArtifactRegistry({
  page: {
    capabilities: ["archive", "edit", "preview", "publish"],
    content: Type.Object({
      blocks: Type.Array(
        Type.Union([
          Type.Object({ heading: Type.String(), type: Type.Literal("hero") }),
          Type.Object({ body: Type.String(), type: Type.Literal("text") }),
        ]),
      ),
      theme: Type.Union([Type.Literal("dark"), Type.Literal("light")]),
    }),
    label: "Page",
    schemaVersion: 1,
  },
});

const artifacts = createArtifactService({
  assetStore: createMemoryArtifactAssetStore(),
  registry,
  store: createMemoryArtifactStore(),
});

const page = await artifacts.create("owner-123", {
  content: {
    blocks: [{ heading: "A real page", type: "hero" }],
    theme: "light",
  },
  createdBy: "agent",
  kind: "page",
  provenance: { model: "your-model", tool: "create_page" },
  title: "Launch page",
});
```

Every successful create or lifecycle mutation appends an immutable snapshot.
Restoring history creates a new private draft instead of rewriting or
republishing an old revision:

```ts
const history = await artifacts.listRevisions("owner-123", page.id);
const restored = await artifacts.restore("owner-123", page.id, 1);
```

## File-backed artifact kinds

Use the bundled definitions directly or compose them with application-specific
kinds:

```ts
import {
  defineArtifactRegistry,
  standardArtifactDefinitions,
} from "@absolutejs/artifacts";

const registry = defineArtifactRegistry({
  ...standardArtifactDefinitions,
  page: myPageDefinition,
});
```

File bytes stay in host storage. Artifact records retain opaque references with
name, media type, size, checksum, role, and storage URI. The URI is not treated
as a public URL and the package reads it only through the configured asset
store. Detaching a file does not delete its bytes because older immutable
revisions may still reference it.

```ts
const report = await artifacts.create("owner-123", {
  content: { summary: "Quarterly results" },
  createdBy: "agent",
  kind: "document",
  title: "Q3 report",
});

await artifacts.attach("owner-123", report.id, {
  data: pdfBytes,
  mediaType: "application/pdf",
  name: "q3-report.pdf",
  role: "primary",
});
```

Multiple generated files should use one staged transaction and therefore one
artifact revision:

```ts
const report = await artifacts.createBundle("owner-123", {
  assets: [pdfOutput, docxOutput, thumbnailOutput],
  content: { summary: "Quarterly results" },
  createdBy: "agent",
  kind: "document",
  provenance: {
    lineage: [{ relation: "generated_from", sourceId: "rag-document-123" }],
    tool: "quarterly_report_generator",
  },
  title: "Q3 report",
});
```

## Generation

Generators are provider-neutral. They return validated structured content and
zero or more file writes; the registry commits those outputs through the same
artifact bundle lifecycle:

```ts
const generators = createArtifactGeneratorRegistry([
  {
    kind: "presentation",
    name: "company-deck",
    generate: async ({ prompt }) => buildPresentation(prompt),
  },
]);

const deck = await generators.generate(artifacts, {
  createdBy: "agent",
  kind: "presentation",
  ownerId: member.id,
  prompt: "Build the partner launch deck",
});
```

## RAG ingestion

The optional `@absolutejs/artifacts/rag` entry point resolves one current or
historical artifact record into the upload contract already accepted by
`@absolutejs/rag`. Structured content is included as JSON and every attached
file is included without exposing its storage URI:

```ts
import { artifactToRAGUploads } from "@absolutejs/artifacts/rag";
import { buildRAGUpsertInputFromUploads } from "@absolutejs/rag";

const revision = await artifacts.getRevision("owner-123", report.id, 2);
const uploads = await artifactToRAGUploads(revision, assetStore);
const upsert = await buildRAGUpsertInputFromUploads({ uploads });
```

`createArtifactRAGIndexCoordinator` wraps that conversion with durable
`pending`, `indexed`, and `failed` state. It removes document IDs from the
previous indexed revision after the replacement succeeds.

## Events and retention

Every lifecycle mutation supplies its event to the artifact store in the same
call that writes the current record and immutable revision. Durable adapters
should commit those rows in one database transaction, then workers can consume
unprocessed events for RAG indexing, previews, notifications, scanning, or
conversion.

Asset collection compares storage candidates with references across every
retained revision. `collectAssetGarbage({ dryRun: true })` previews deletion;
only unreferenced objects older than the configured minimum age are eligible.

## Compose publishing and rendering

Publishing is an adapter because public access is a host policy:

```ts
const artifacts = createArtifactService({
  publisher: {
    publish: async (artifact, { idempotencyKey }) =>
      mintPublicTokenAndUrl(artifact, idempotencyKey),
    unpublish: async (artifact, { idempotencyKey }) =>
      revokePublicAccess(artifact, idempotencyKey),
  },
  registry,
  store: postgresArtifactStore,
});
```

Publishing defaults to `pinned`: the public record names the exact immutable
revision. `mode: "live"` is an explicit alternative whose revision advances
with later edits.

Renderers are independently registered by artifact kind and output format:

```ts
const renderers = createArtifactRendererRegistry([
  {
    format: "html",
    kind: "page",
    render: async (artifact) => ({
      body: renderSafePage(artifact.content),
      mediaType: "text/html; charset=utf-8",
    }),
  },
]);
```

The package never treats generated HTML or JavaScript as trusted executable
content. Applications should define structured content schemas and render them
through controlled adapters.

## AI tools

`createArtifactTools` binds create, list, get, update, publish, and unpublish
operations to one owner. The returned definitions use TypeBox inputs and the
same `{ description, input, handler }` shape used by `@absolutejs/ai`.

```ts
const tools = createArtifactTools({
  createdBy: "agent",
  ownerId: member.id,
  service: artifacts,
});
```

Only expose the publication tool where the user explicitly controls public
access.

## License

Business Source License 1.1 — free for your own products, applications, and
internal use; you may not offer it as a competing hosted AI artifact-generation,
editing, rendering, publishing, or artifact-management service. Converts to
Apache 2.0 on July 14, 2030. See [LICENSE](./LICENSE).

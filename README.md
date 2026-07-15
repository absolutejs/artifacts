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
- Optimistic revisions that prevent lost edits
- Storage, renderer, and publisher interfaces
- An in-memory store for development and tests
- Owner-bound lifecycle tools structurally compatible with AI tool maps
- Provenance fields for model, tool, trace, and source entities

Your application retains authorization, durable persistence, public tokens,
URLs, notifications, analytics, submissions, and product-specific rendering.

## Define kinds once

```ts
import { Type } from "@sinclair/typebox";
import {
  createArtifactService,
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

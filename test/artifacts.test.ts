import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  ArtifactError,
  createArtifactRendererRegistry,
  createArtifactService,
  createArtifactTools,
  createMemoryArtifactStore,
  defineArtifactRegistry,
  standardArtifactDefinitions,
} from "../src";
import { artifactToRAGUploads } from "../src/rag";

const registry = defineArtifactRegistry({
  page: {
    capabilities: ["archive", "edit", "preview", "publish"],
    content: Type.Object({
      blocks: Type.Array(Type.Object({ text: Type.String() })),
      theme: Type.Union([Type.Literal("dark"), Type.Literal("light")]),
    }),
    label: "Page",
  },
});

const createFixture = () => {
  let id = 0;
  let publication = 0;
  const store = createMemoryArtifactStore();
  const service = createArtifactService({
    clock: () => new Date("2026-07-14T12:00:00.000Z"),
    idFactory: () => `artifact-${++id}`,
    publisher: {
      publish: async (artifact) => ({
        id: `publication-${++publication}`,
        url: `https://example.test/p/${artifact.id}`,
      }),
      unpublish: async () => undefined,
    },
    registry,
    store,
  });

  return { service, store };
};

describe("artifact lifecycle", () => {
  test("validates content and records immutable lifecycle fields", async () => {
    const { service } = createFixture();
    const artifact = await service.create("owner-1", {
      content: { blocks: [{ text: "Hello" }], theme: "light" },
      createdBy: "agent",
      kind: "page",
      title: "Launch page",
    });

    expect(artifact.id).toBe("artifact-1");
    expect(artifact.revision).toBe(1);
    expect(artifact.status).toBe("draft");
    expect(artifact.schemaVersion).toBe(1);
  });

  test("rejects invalid structured content", async () => {
    const { service } = createFixture();

    expect(
      service.create("owner-1", {
        content: { blocks: [], theme: "blue" },
        createdBy: "agent",
        kind: "page",
        title: "Invalid page",
      }),
    ).rejects.toMatchObject({ code: "invalid_content" });
  });

  test("uses optimistic revisions to prevent lost edits", async () => {
    const { service } = createFixture();
    const artifact = await service.create("owner-1", {
      content: { blocks: [], theme: "dark" },
      createdBy: "agent",
      kind: "page",
      title: "Page",
    });
    await service.update("owner-1", artifact.id, {
      expectedRevision: 1,
      title: "Page v2",
    });

    await expect(
      service.update("owner-1", artifact.id, {
        expectedRevision: 1,
        title: "Stale edit",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("keeps immutable revision history and restores as a new draft", async () => {
    const { service } = createFixture();
    const artifact = await service.create("owner-1", {
      content: { blocks: [], theme: "dark" },
      createdBy: "agent",
      kind: "page",
      title: "Original",
    });
    await service.update("owner-1", artifact.id, { title: "Second" });
    await service.publish("owner-1", artifact.id);
    const revisions = await service.listRevisions("owner-1", artifact.id);
    const restored = await service.restore("owner-1", artifact.id, 1);

    expect(revisions.map((revision) => revision.revision)).toEqual([3, 2, 1]);
    expect((await service.getRevision("owner-1", artifact.id, 1)).title).toBe(
      "Original",
    );
    expect(restored.revision).toBe(4);
    expect(restored.status).toBe("draft");
    expect(restored.publication).toBeUndefined();
    expect(restored.title).toBe("Original");
  });

  test("attaches file assets and resolves a revision into RAG uploads", async () => {
    const bytes = new Map<string, Uint8Array>();
    const assetStore = {
      read: async (reference: { id: string }) => bytes.get(reference.id)!,
      write: async (input: {
        data: Uint8Array;
        mediaType: string;
        name: string;
        role?: "attachment" | "primary" | "preview" | "source";
      }) => {
        bytes.set("asset-1", input.data);

        return {
          id: "asset-1",
          mediaType: input.mediaType,
          name: input.name,
          role: input.role ?? ("primary" as const),
          size: input.data.byteLength,
          uri: "memory://asset-1",
        };
      },
    };
    const service = createArtifactService({
      assetStore,
      registry: defineArtifactRegistry(standardArtifactDefinitions),
      store: createMemoryArtifactStore(),
    });
    const artifact = await service.create("owner-1", {
      content: { summary: "Quarterly results" },
      createdBy: "agent",
      kind: "document",
      title: "Results",
    });
    const attached = await service.attach("owner-1", artifact.id, {
      data: new TextEncoder().encode("Revenue grew."),
      mediaType: "text/markdown",
      name: "results.md",
      role: "primary",
    });
    const uploads = await artifactToRAGUploads(attached, assetStore);

    expect(attached.assets).toHaveLength(1);
    expect(
      (await service.readAsset("owner-1", artifact.id, "asset-1")).data,
    ).toEqual(new TextEncoder().encode("Revenue grew."));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.contentType).toBe("application/json");
    expect(uploads[1]?.name).toBe("results.md");
    expect(uploads[1]?.encoding).toBe("base64");
  });

  test("publishes and unpublishes through the host adapter", async () => {
    const { service } = createFixture();
    const artifact = await service.create("owner-1", {
      content: { blocks: [], theme: "dark" },
      createdBy: "agent",
      kind: "page",
      title: "Page",
    });
    const published = await service.publish("owner-1", artifact.id);
    const draft = await service.unpublish("owner-1", artifact.id);

    expect(published.publication?.url).toBe(
      "https://example.test/p/artifact-1",
    );
    expect(published.status).toBe("published");
    expect(draft.status).toBe("draft");
    expect(draft.publication).toBeUndefined();
  });

  test("renders with registered host renderers", async () => {
    const { service } = createFixture();
    const artifact = await service.create("owner-1", {
      content: { blocks: [], theme: "light" },
      createdBy: "agent",
      kind: "page",
      title: "Page",
    });
    const renderers = createArtifactRendererRegistry([
      {
        format: "html",
        kind: "page",
        render: async () => ({
          body: "<main>Page</main>",
          mediaType: "text/html",
        }),
      },
    ]);

    expect((await renderers.render(artifact, "html")).mediaType).toBe(
      "text/html",
    );
    await expect(renderers.render(artifact, "pdf")).rejects.toBeInstanceOf(
      ArtifactError,
    );
  });

  test("provides AI-compatible lifecycle tools bound to an owner", async () => {
    const { service } = createFixture();
    const tools = createArtifactTools({
      createdBy: "agent",
      ownerId: "owner-1",
      service,
    });
    const created = await tools.artifact_create?.handler({
      content: { blocks: [], theme: "light" },
      kind: "page",
      title: "Tool page",
    });
    const listed = await tools.artifact_list?.handler({});

    expect(String(created)).toContain("artifact-1");
    expect(String(listed)).toContain("Tool page");
  });
});

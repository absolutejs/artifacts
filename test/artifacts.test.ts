import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  ArtifactError,
  createArtifactRendererRegistry,
  createArtifactService,
  createArtifactTools,
  createMemoryArtifactStore,
  defineArtifactRegistry,
} from "../src";

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

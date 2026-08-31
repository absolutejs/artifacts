import { describe, expect, test } from "bun:test";
import {
  createArtifactService,
  createMemoryArtifactAssetStore,
  createMemoryArtifactStore,
  defineArtifactRegistry,
  standardArtifactDefinitions,
  type ArtifactStore,
} from "../src";

const registry = defineArtifactRegistry(standardArtifactDefinitions);

const item = (key: string, summary = key) => ({
  artifact: {
    content: { summary },
    createdBy: "mission",
    kind: "document",
    title: `${key} output`,
  },
  evidence: [{ sourceId: `source-${key}`, sourceUrl: "https://example.test" }],
  key,
});

describe("multi-artifact batches", () => {
  test("validates every staged artifact before committing anything", async () => {
    const store = createMemoryArtifactStore();
    const service = createArtifactService({ registry, store });
    const staged = await service.stageBatch(
      "owner-1",
      { bundleId: "bundle-1", items: [item("worksheet"), item("report")] },
      {
        validators: [
          ({ items }) =>
            items.length === 2
              ? [
                  {
                    code: "missing_evidence",
                    itemKey: "report",
                    message: "No report citations",
                  },
                ]
              : [],
        ],
      },
    );

    expect(staged.validation).toEqual({
      issues: [
        {
          code: "missing_evidence",
          itemKey: "report",
          message: "No report citations",
        },
      ],
      valid: false,
    });
    expect((await staged.commit()).status).toBe("rolled_back");
    expect(await store.list("owner-1")).toHaveLength(0);
  });

  test("commits all artifacts atomically with evidence and a receipt", async () => {
    const store = createMemoryArtifactStore();
    const service = createArtifactService({
      batchIdFactory: () => "bundle-1",
      registry,
      store,
    });
    const staged = await service.stageBatch("owner-1", {
      evidence: [{ sourceId: "shared-source" }],
      items: [item("worksheet"), item("report")],
      provenance: { model: "test-model", traceId: "trace-1" },
    });
    const receipt = await staged.commit();
    const records = await store.list("owner-1");

    expect(receipt).toMatchObject({
      atomic: true,
      bundleId: "bundle-1",
      status: "committed",
      validation: { valid: true },
    });
    expect(receipt.items).toHaveLength(2);
    expect(records).toHaveLength(2);
    expect(records[0]?.provenance).toMatchObject({
      evidence: expect.arrayContaining([{ sourceId: "shared-source" }]),
      model: "test-model",
      traceId: "trace-1",
    });
    expect(records[0]?.metadata.artifactBatch).toMatchObject({
      bundleId: "bundle-1",
    });
  });

  test("rolls staged assets back when the atomic database commit fails", async () => {
    const base = createMemoryArtifactStore();
    const store: ArtifactStore = {
      ...base,
      createBatch: async () => {
        throw new Error("database unavailable");
      },
    };
    const assetStore = createMemoryArtifactAssetStore();
    const service = createArtifactService({ assetStore, registry, store });
    const staged = await service.stageBatch("owner-1", {
      items: [
        {
          ...item("report"),
          artifact: {
            ...item("report").artifact,
            assets: [
              {
                data: new TextEncoder().encode("# report"),
                mediaType: "text/markdown",
                name: "report.md",
              },
            ],
          },
        },
      ],
    });
    const receipt = await staged.commit();

    expect(receipt.status).toBe("rolled_back");
    expect(receipt.error).toBe("database unavailable");
    expect(await store.list("owner-1")).toHaveLength(0);
    expect(await assetStore.listCandidates()).toHaveLength(0);
  });

  test("archives committed records after a partial non-atomic failure", async () => {
    const base = createMemoryArtifactStore();
    let creates = 0;
    const { createBatch: _createBatch, ...withoutBatch } = base;
    const store: ArtifactStore = {
      ...withoutBatch,
      create: async (record, events) => {
        creates += 1;
        if (creates === 2) throw new Error("second insert failed");
        await base.create(record, events);
      },
    };
    const service = createArtifactService({ registry, store });
    const staged = await service.stageBatch("owner-1", {
      commitMode: "archive_on_failure",
      items: [item("worksheet"), item("report")],
    });
    const receipt = await staged.commit();
    const records = await store.list("owner-1");

    expect(receipt.status).toBe("rolled_back");
    expect(receipt.atomic).toBe(false);
    expect(receipt.archivedArtifactIds).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("archived");
  });
});

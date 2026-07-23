import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { drizzle } from "drizzle-orm/pglite";
import { createArtifactService, defineArtifactRegistry } from "../src";
import {
  ArtifactEventInsertSchema,
  ArtifactIndexingStateInsertSchema,
  ArtifactRecordInsertSchema,
  ArtifactRevisionInsertSchema,
  createDrizzleArtifactStore,
} from "../src/drizzle";

const createFixture = async () => {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE artifact_records (
      id text PRIMARY KEY,
      owner_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      revision integer NOT NULL,
      updated_at timestamptz NOT NULL,
      document jsonb NOT NULL
    );
    CREATE INDEX artifact_records_owner_updated_idx
      ON artifact_records (owner_id, updated_at DESC);
    CREATE INDEX artifact_records_owner_kind_idx
      ON artifact_records (owner_id, kind);
    CREATE TABLE artifact_revisions (
      artifact_id text NOT NULL REFERENCES artifact_records(id),
      owner_id text NOT NULL,
      revision integer NOT NULL,
      document jsonb NOT NULL,
      CONSTRAINT artifact_revisions_pkey PRIMARY KEY (artifact_id, revision)
    );
    CREATE TABLE artifact_events (
      id text PRIMARY KEY,
      artifact_id text NOT NULL REFERENCES artifact_records(id),
      owner_id text NOT NULL,
      type text NOT NULL,
      created_at timestamptz NOT NULL,
      processed_at timestamptz,
      document jsonb NOT NULL
    );
    CREATE TABLE artifact_indexing_states (
      artifact_id text PRIMARY KEY REFERENCES artifact_records(id),
      owner_id text NOT NULL,
      revision integer NOT NULL,
      status text NOT NULL,
      updated_at timestamptz NOT NULL,
      document jsonb NOT NULL
    );
  `);
  const store = createDrizzleArtifactStore({ db: drizzle({ client }) });
  let eventId = 0;
  const service = createArtifactService({
    clock: () => new Date("2026-07-23T12:00:00.000Z"),
    eventIdFactory: () => `event-${++eventId}`,
    idFactory: () => "artifact-1",
    registry: defineArtifactRegistry({
      page: {
        capabilities: ["archive", "edit", "preview", "publish"],
        content: Type.Object({ body: Type.String() }),
        label: "Page",
      },
    }),
    store,
  });

  return { client, service, store };
};

describe("createDrizzleArtifactStore", () => {
  test("exports database TypeBoxes generated from every Drizzle table", () => {
    expect(ArtifactRecordInsertSchema).toBeDefined();
    expect(ArtifactRevisionInsertSchema).toBeDefined();
    expect(ArtifactEventInsertSchema).toBeDefined();
    expect(ArtifactIndexingStateInsertSchema).toBeDefined();
    expect(
      Value.Check(ArtifactRecordInsertSchema, {
        document: {},
        id: "artifact-1",
        kind: "page",
        ownerId: "owner-1",
        revision: 1,
        status: "draft",
        updatedAt: "2026-07-23T12:00:00.000Z",
      }),
    ).toBe(true);
  });

  test("persists owner-fenced revisions and transactional outbox events", async () => {
    const { service, store } = await createFixture();
    const created = await service.create("owner-1", {
      content: { body: "First" },
      createdBy: "agent-1",
      kind: "page",
      title: "Landing page",
    });
    await service.update("owner-1", created.id, {
      content: { body: "Second" },
      expectedRevision: 1,
    });

    expect((await service.get("owner-1", created.id)).revision).toBe(2);
    await expect(service.get("owner-2", created.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await service.listRevisions("owner-1", created.id)).map(
        ({ revision }) => revision,
      ),
    ).toEqual([2, 1]);
    expect(await store.listEvents({ processed: false })).toHaveLength(2);
    expect(await store.listReferencedAssetIds()).toEqual([]);
  });

  test("enforces optimistic updates and durably advances outbox state", async () => {
    const { service, store } = await createFixture();
    const created = await service.create("owner-1", {
      content: { body: "First" },
      createdBy: "agent-1",
      kind: "page",
      title: "Landing page",
    });
    await service.update("owner-1", created.id, {
      expectedRevision: 1,
      title: "Second",
    });
    await expect(
      service.update("owner-1", created.id, {
        expectedRevision: 1,
        title: "Stale",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const [event] = await store.listEvents({ processed: false, limit: 1 });
    expect(event).toBeDefined();
    expect(
      await store.markEventProcessed(event!.id, "2026-07-23T13:00:00.000Z"),
    ).toBe(true);
    expect((await store.listEvents({ processed: true }))[0]?.processedAt).toBe(
      "2026-07-23T13:00:00.000Z",
    );
  });

  test("persists indexing state and its event in the same transaction", async () => {
    const { service, store } = await createFixture();
    const created = await service.create("owner-1", {
      content: { body: "Index me" },
      createdBy: "agent-1",
      kind: "page",
      title: "Landing page",
    });
    await service.markIndexing("owner-1", created.id, {
      documentIds: ["rag-document-1"],
      revision: 1,
      status: "indexed",
    });

    expect(await service.getIndexingState("owner-1", created.id)).toMatchObject(
      {
        documentIds: ["rag-document-1"],
        status: "indexed",
      },
    );
    expect(
      await store.listEvents({ type: "artifact.indexing_changed" }),
    ).toHaveLength(1);
  });

  test("rolls back mismatched outbox events instead of crossing owners", async () => {
    const { store } = await createFixture();
    const timestamp = "2026-07-23T12:00:00.000Z";
    await expect(
      store.create(
        {
          assets: [],
          capabilities: ["edit"],
          content: {},
          createdAt: timestamp,
          createdBy: "agent-1",
          id: "unsafe-artifact",
          kind: "page",
          metadata: {},
          ownerId: "owner-1",
          revision: 1,
          schemaVersion: 1,
          status: "draft",
          title: "Unsafe",
          updatedAt: timestamp,
        },
        [
          {
            artifactId: "unsafe-artifact",
            createdAt: timestamp,
            id: "unsafe-event",
            ownerId: "owner-2",
            revision: 1,
            type: "artifact.created",
          },
        ],
      ),
    ).rejects.toThrow("must belong");
    expect(await store.get("owner-1", "unsafe-artifact")).toBeNull();
  });
});

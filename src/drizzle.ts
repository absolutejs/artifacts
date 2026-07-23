import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import type { ArtifactStore } from "./store";
import type {
  ArtifactEvent,
  ArtifactIndexingState,
  ArtifactRecord,
  ArtifactRevision,
} from "./types";

const recordJsonb = customType<{
  data: ArtifactRecord;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string" ? JSON.parse(value) : value) as ArtifactRecord,
  toDriver: (value) => JSON.stringify(value),
});
const revisionJsonb = customType<{
  data: ArtifactRevision;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string" ? JSON.parse(value) : value) as ArtifactRevision,
  toDriver: (value) => JSON.stringify(value),
});
const eventJsonb = customType<{
  data: ArtifactEvent;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string" ? JSON.parse(value) : value) as ArtifactEvent,
  toDriver: (value) => JSON.stringify(value),
});
const indexingJsonb = customType<{
  data: ArtifactIndexingState;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string"
      ? JSON.parse(value)
      : value) as ArtifactIndexingState,
  toDriver: (value) => JSON.stringify(value),
});

export const artifactRecords = pgTable(
  "artifact_records",
  {
    document: recordJsonb().notNull(),
    id: text().primaryKey(),
    kind: text().notNull(),
    ownerId: text("owner_id").notNull(),
    revision: integer().notNull(),
    status: text().notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index("artifact_records_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt.desc(),
    ),
    index("artifact_records_owner_kind_idx").on(table.ownerId, table.kind),
  ],
);

export const artifactRevisions = pgTable(
  "artifact_revisions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifactRecords.id),
    document: revisionJsonb().notNull(),
    ownerId: text("owner_id").notNull(),
    revision: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.artifactId, table.revision],
      name: "artifact_revisions_pkey",
    }),
    index("artifact_revisions_owner_idx").on(
      table.ownerId,
      table.artifactId,
      table.revision.desc(),
    ),
  ],
);

export const artifactEvents = pgTable(
  "artifact_events",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifactRecords.id),
    createdAt: timestamp("created_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    document: eventJsonb().notNull(),
    id: text().primaryKey(),
    ownerId: text("owner_id").notNull(),
    processedAt: timestamp("processed_at", {
      mode: "string",
      withTimezone: true,
    }),
    type: text().notNull(),
  },
  (table) => [
    index("artifact_events_outbox_idx").on(table.processedAt, table.createdAt),
    index("artifact_events_artifact_idx").on(
      table.ownerId,
      table.artifactId,
      table.createdAt,
    ),
  ],
);

export const artifactIndexingStates = pgTable("artifact_indexing_states", {
  artifactId: text("artifact_id")
    .primaryKey()
    .references(() => artifactRecords.id),
  document: indexingJsonb().notNull(),
  ownerId: text("owner_id").notNull(),
  revision: integer().notNull(),
  status: text().notNull(),
  updatedAt: timestamp("updated_at", {
    mode: "string",
    withTimezone: true,
  }).notNull(),
});

export const artifactDrizzleSchema = {
  artifactEvents,
  artifactIndexingStates,
  artifactRecords,
  artifactRevisions,
};
export const ArtifactRecordInsertSchema = createInsertSchema(artifactRecords);
export const ArtifactRecordSelectSchema = createSelectSchema(artifactRecords);
export const ArtifactRevisionInsertSchema =
  createInsertSchema(artifactRevisions);
export const ArtifactRevisionSelectSchema =
  createSelectSchema(artifactRevisions);
export const ArtifactEventInsertSchema = createInsertSchema(artifactEvents);
export const ArtifactEventSelectSchema = createSelectSchema(artifactEvents);
export const ArtifactIndexingStateInsertSchema = createInsertSchema(
  artifactIndexingStates,
);
export const ArtifactIndexingStateSelectSchema = createSelectSchema(
  artifactIndexingStates,
);

type AnyPgDatabase = PgAsyncDatabase<any, any>;

const eventRows = (events: ArtifactEvent[]) =>
  events.map((event) => ({
    artifactId: event.artifactId,
    createdAt: event.createdAt,
    document: event,
    id: event.id,
    ownerId: event.ownerId,
    processedAt: event.processedAt,
    type: event.type,
  }));

const assertEventsBelongToArtifact = (
  record: Pick<ArtifactRecord, "id" | "ownerId">,
  events: ArtifactEvent[],
) => {
  if (
    events.some(
      (event) =>
        event.artifactId !== record.id || event.ownerId !== record.ownerId,
    )
  )
    throw new Error("Artifact events must belong to the persisted artifact");
};

const recordRow = (record: ArtifactRecord) => ({
  document: record,
  id: record.id,
  kind: record.kind,
  ownerId: record.ownerId,
  revision: record.revision,
  status: record.status,
  updatedAt: record.updatedAt,
});

const recordUpdate = (record: ArtifactRecord) => ({
  document: record,
  kind: record.kind,
  ownerId: record.ownerId,
  revision: record.revision,
  status: record.status,
  updatedAt: record.updatedAt,
});

const revisionRow = (record: ArtifactRecord) => ({
  artifactId: record.id,
  document: record,
  ownerId: record.ownerId,
  revision: record.revision,
});

export const createDrizzleArtifactStore = <DB extends AnyPgDatabase>(options: {
  db: DB;
}): ArtifactStore => ({
  create: (record, events = []) =>
    options.db.transaction(async (transaction) => {
      assertEventsBelongToArtifact(record, events);
      await transaction.insert(artifactRecords).values(recordRow(record));
      await transaction.insert(artifactRevisions).values(revisionRow(record));
      if (events.length > 0)
        await transaction.insert(artifactEvents).values(eventRows(events));
    }),
  get: async (ownerId, artifactId) => {
    const [row] = await options.db
      .select({ document: artifactRecords.document })
      .from(artifactRecords)
      .where(
        and(
          eq(artifactRecords.id, artifactId),
          eq(artifactRecords.ownerId, ownerId),
        ),
      )
      .limit(1);

    return row?.document ?? null;
  },
  getIndexingState: async (ownerId, artifactId) => {
    const [row] = await options.db
      .select({ document: artifactIndexingStates.document })
      .from(artifactIndexingStates)
      .where(
        and(
          eq(artifactIndexingStates.artifactId, artifactId),
          eq(artifactIndexingStates.ownerId, ownerId),
        ),
      )
      .limit(1);

    return row?.document ?? null;
  },
  getRevision: async (ownerId, artifactId, revision) => {
    const [row] = await options.db
      .select({ document: artifactRevisions.document })
      .from(artifactRevisions)
      .where(
        and(
          eq(artifactRevisions.artifactId, artifactId),
          eq(artifactRevisions.ownerId, ownerId),
          eq(artifactRevisions.revision, revision),
        ),
      )
      .limit(1);

    return row?.document ?? null;
  },
  list: async (ownerId, query = {}) => {
    const conditions = [eq(artifactRecords.ownerId, ownerId)];
    if (query.kind) conditions.push(eq(artifactRecords.kind, query.kind));
    if (query.status) conditions.push(eq(artifactRecords.status, query.status));
    const statement = options.db
      .select({ document: artifactRecords.document })
      .from(artifactRecords)
      .where(and(...conditions))
      .orderBy(desc(artifactRecords.updatedAt));
    const rows =
      query.limit === undefined
        ? await statement
        : await statement.limit(query.limit);

    return rows.map(({ document }) => document);
  },
  listEvents: async (query = {}) => {
    const conditions = [];
    if (query.processed !== undefined)
      conditions.push(
        query.processed
          ? isNotNull(artifactEvents.processedAt)
          : isNull(artifactEvents.processedAt),
      );
    if (query.type) conditions.push(eq(artifactEvents.type, query.type));
    const statement = options.db
      .select({
        document: artifactEvents.document,
        processedAt: artifactEvents.processedAt,
      })
      .from(artifactEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(artifactEvents.createdAt));
    const rows =
      query.limit === undefined
        ? await statement
        : await statement.limit(query.limit);

    return rows.map(({ document, processedAt }) => ({
      ...document,
      ...(processedAt
        ? { processedAt: new Date(processedAt).toISOString() }
        : {}),
    }));
  },
  listReferencedAssetIds: async () => {
    const rows = await options.db
      .select({ document: artifactRevisions.document })
      .from(artifactRevisions);

    return [
      ...new Set(
        rows.flatMap(({ document }) => document.assets.map(({ id }) => id)),
      ),
    ];
  },
  listRevisions: async (ownerId, artifactId) =>
    (
      await options.db
        .select({ document: artifactRevisions.document })
        .from(artifactRevisions)
        .where(
          and(
            eq(artifactRevisions.artifactId, artifactId),
            eq(artifactRevisions.ownerId, ownerId),
          ),
        )
        .orderBy(desc(artifactRevisions.revision))
    ).map(({ document }) => document),
  markEventProcessed: async (eventId, processedAt) =>
    (
      await options.db
        .update(artifactEvents)
        .set({ processedAt })
        .where(eq(artifactEvents.id, eventId))
        .returning({ id: artifactEvents.id })
    ).length === 1,
  putIndexingState: (ownerId, state, events = []) =>
    options.db.transaction(async (transaction) => {
      assertEventsBelongToArtifact({ id: state.artifactId, ownerId }, events);
      const [artifact] = await transaction
        .select({ id: artifactRecords.id })
        .from(artifactRecords)
        .where(
          and(
            eq(artifactRecords.id, state.artifactId),
            eq(artifactRecords.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!artifact) throw new Error("Artifact not found");
      await transaction
        .insert(artifactIndexingStates)
        .values({
          artifactId: state.artifactId,
          document: state,
          ownerId,
          revision: state.revision,
          status: state.status,
          updatedAt: state.updatedAt,
        })
        .onConflictDoUpdate({
          set: {
            document: state,
            ownerId,
            revision: state.revision,
            status: state.status,
            updatedAt: state.updatedAt,
          },
          target: artifactIndexingStates.artifactId,
        });
      if (events.length > 0)
        await transaction.insert(artifactEvents).values(eventRows(events));
    }),
  purgeOwner: (ownerId) =>
    options.db.transaction(async (transaction) => {
      await transaction
        .delete(artifactIndexingStates)
        .where(eq(artifactIndexingStates.ownerId, ownerId));
      await transaction
        .delete(artifactEvents)
        .where(eq(artifactEvents.ownerId, ownerId));
      await transaction
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.ownerId, ownerId));
      const deleted = await transaction
        .delete(artifactRecords)
        .where(eq(artifactRecords.ownerId, ownerId))
        .returning({ id: artifactRecords.id });

      return deleted.length;
    }),
  save: (record, expectedRevision, events = []) =>
    options.db.transaction(async (transaction) => {
      assertEventsBelongToArtifact(record, events);
      const updated = await transaction
        .update(artifactRecords)
        .set(recordUpdate(record))
        .where(
          and(
            eq(artifactRecords.id, record.id),
            eq(artifactRecords.ownerId, record.ownerId),
            eq(artifactRecords.revision, expectedRevision),
          ),
        )
        .returning({ id: artifactRecords.id });
      if (updated.length !== 1) return false;
      await transaction.insert(artifactRevisions).values(revisionRow(record));
      if (events.length > 0)
        await transaction.insert(artifactEvents).values(eventRows(events));

      return true;
    }),
});

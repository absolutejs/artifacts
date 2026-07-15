import { createHash } from "node:crypto";
import type {
  ArtifactAssetReference,
  ArtifactAssetWriteInput,
  ArtifactEvent,
  ArtifactEventQuery,
  ArtifactIndexingState,
  ArtifactListQuery,
  ArtifactRecord,
  ArtifactRevision,
  ArtifactRetentionCandidate,
} from "./types";

export type ArtifactAssetTransaction = {
  commit(): Promise<void>;
  references: ArtifactAssetReference[];
  rollback(): Promise<void>;
};

export type ArtifactAssetStore = {
  delete(reference: ArtifactAssetReference): Promise<void>;
  listCandidates(): Promise<ArtifactRetentionCandidate[]>;
  read(
    reference: ArtifactAssetReference,
    context: { artifact: ArtifactRecord },
  ): Promise<Uint8Array>;
  write(
    input: ArtifactAssetWriteInput,
    context: { artifact: ArtifactRecord; idempotencyKey: string },
  ): Promise<ArtifactAssetReference>;
  stage?(
    inputs: ArtifactAssetWriteInput[],
    context: { artifact: ArtifactRecord; idempotencyKey: string },
  ): Promise<ArtifactAssetTransaction>;
};

export type ArtifactStore = {
  /** Persist the current record and its first immutable revision atomically. */
  create(record: ArtifactRecord, events?: ArtifactEvent[]): Promise<void>;
  getIndexingState(
    ownerId: string,
    artifactId: string,
  ): Promise<ArtifactIndexingState | null>;
  get(ownerId: string, artifactId: string): Promise<ArtifactRecord | null>;
  getRevision(
    ownerId: string,
    artifactId: string,
    revision: number,
  ): Promise<ArtifactRevision | null>;
  list(ownerId: string, query?: ArtifactListQuery): Promise<ArtifactRecord[]>;
  listRevisions(
    ownerId: string,
    artifactId: string,
  ): Promise<ArtifactRevision[]>;
  listEvents(query?: ArtifactEventQuery): Promise<ArtifactEvent[]>;
  listReferencedAssetIds(): Promise<string[]>;
  markEventProcessed(eventId: string, processedAt: string): Promise<boolean>;
  putIndexingState(
    ownerId: string,
    state: ArtifactIndexingState,
    events?: ArtifactEvent[],
  ): Promise<void>;
  /** Compare, replace current state, and append its revision atomically. */
  save(
    record: ArtifactRecord,
    expectedRevision: number,
    events?: ArtifactEvent[],
  ): Promise<boolean>;
};

const clone = <T>(value: T): T => structuredClone(value);

export const createMemoryArtifactAssetStore = (): ArtifactAssetStore => {
  const bytes = new Map<string, Uint8Array>();
  const references = new Map<string, ArtifactAssetReference>();
  const idempotency = new Map<string, string>();

  return {
    delete: async (reference) => {
      bytes.delete(reference.id);
      references.delete(reference.id);
    },
    listCandidates: async () =>
      [...references.values()].map((reference) => ({
        createdAt: reference.createdAt,
        reference: clone(reference),
      })),
    read: async (reference) => {
      const data = bytes.get(reference.id);
      if (!data) throw new Error(`Artifact asset not found: ${reference.id}`);

      return clone(data);
    },
    write: async (input, context) => {
      const existingId = idempotency.get(context.idempotencyKey);
      if (existingId) return clone(references.get(existingId)!);
      const id = crypto.randomUUID();
      const reference: ArtifactAssetReference = {
        checksum: {
          algorithm: "sha256",
          value: createHash("sha256").update(input.data).digest("hex"),
        },
        createdAt: new Date().toISOString(),
        id,
        mediaType: input.mediaType,
        metadata: input.metadata,
        name: input.name,
        role: input.role ?? "attachment",
        size: input.data.byteLength,
        uri: `memory://${id}`,
      };
      bytes.set(id, clone(input.data));
      references.set(id, clone(reference));
      idempotency.set(context.idempotencyKey, id);

      return reference;
    },
    stage: async (inputs, context) => {
      const staged = inputs.map((input, index) => {
        const key = `${context.idempotencyKey}:${index}`;
        const existingId = idempotency.get(key);
        if (existingId) {
          return {
            data: bytes.get(existingId)!,
            key,
            reference: references.get(existingId)!,
          };
        }
        const id = crypto.randomUUID();
        const reference: ArtifactAssetReference = {
          checksum: {
            algorithm: "sha256",
            value: createHash("sha256").update(input.data).digest("hex"),
          },
          createdAt: new Date().toISOString(),
          id,
          mediaType: input.mediaType,
          metadata: input.metadata,
          name: input.name,
          role: input.role ?? "attachment",
          size: input.data.byteLength,
          uri: `memory://${id}`,
        };

        return { data: clone(input.data), key, reference };
      });

      return {
        commit: async () => {
          for (const item of staged) {
            bytes.set(item.reference.id, clone(item.data));
            references.set(item.reference.id, clone(item.reference));
            idempotency.set(item.key, item.reference.id);
          }
        },
        references: staged.map((item) => clone(item.reference)),
        rollback: async () => {
          for (const item of staged) {
            bytes.delete(item.reference.id);
            references.delete(item.reference.id);
            idempotency.delete(item.key);
          }
        },
      };
    },
  };
};

export const createMemoryArtifactStore = (
  initial: ArtifactRecord[] = [],
): ArtifactStore => {
  const records = new Map(initial.map((record) => [record.id, clone(record)]));
  const revisions = new Map<string, ArtifactRevision[]>();
  const events = new Map<string, ArtifactEvent>();
  const indexing = new Map<string, ArtifactIndexingState>();
  for (const record of initial) revisions.set(record.id, [clone(record)]);

  return {
    create: async (record, newEvents = []) => {
      if (records.has(record.id))
        throw new Error(`Duplicate artifact id: ${record.id}`);
      records.set(record.id, clone(record));
      revisions.set(record.id, [clone(record)]);
      for (const event of newEvents) events.set(event.id, clone(event));
    },
    get: async (ownerId, artifactId) => {
      const record = records.get(artifactId);

      return record?.ownerId === ownerId ? clone(record) : null;
    },
    getIndexingState: async (ownerId, artifactId) => {
      const record = records.get(artifactId);
      if (record?.ownerId !== ownerId) return null;

      return clone(indexing.get(artifactId) ?? null);
    },
    getRevision: async (ownerId, artifactId, revision) => {
      const current = records.get(artifactId);
      if (current?.ownerId !== ownerId) return null;

      return clone(
        revisions
          .get(artifactId)
          ?.find((candidate) => candidate.revision === revision) ?? null,
      );
    },
    list: async (ownerId, query = {}) =>
      [...records.values()]
        .filter(
          (record) =>
            record.ownerId === ownerId &&
            (!query.kind || record.kind === query.kind) &&
            (!query.status || record.status === query.status),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, query.limit ?? Number.POSITIVE_INFINITY)
        .map(clone),
    listRevisions: async (ownerId, artifactId) => {
      const current = records.get(artifactId);
      if (current?.ownerId !== ownerId) return [];

      return (revisions.get(artifactId) ?? [])
        .toSorted((left, right) => right.revision - left.revision)
        .map(clone);
    },
    listEvents: async (query = {}) =>
      [...events.values()]
        .filter(
          (event) =>
            (query.processed === undefined ||
              Boolean(event.processedAt) === query.processed) &&
            (!query.type || event.type === query.type),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, query.limit ?? Number.POSITIVE_INFINITY)
        .map(clone),
    listReferencedAssetIds: async () => [
      ...new Set(
        [...revisions.values()]
          .flat()
          .flatMap((revision) => revision.assets.map((asset) => asset.id)),
      ),
    ],
    markEventProcessed: async (eventId, processedAt) => {
      const event = events.get(eventId);
      if (!event) return false;
      events.set(eventId, { ...event, processedAt });

      return true;
    },
    putIndexingState: async (ownerId, state, newEvents = []) => {
      const record = records.get(state.artifactId);
      if (record?.ownerId !== ownerId) {
        throw new Error("Artifact not found");
      }
      indexing.set(state.artifactId, clone(state));
      for (const event of newEvents) events.set(event.id, clone(event));
    },
    save: async (record, expectedRevision, newEvents = []) => {
      const current = records.get(record.id);
      if (
        !current ||
        current.ownerId !== record.ownerId ||
        current.revision !== expectedRevision
      ) {
        return false;
      }
      records.set(record.id, clone(record));
      revisions.set(record.id, [
        ...(revisions.get(record.id) ?? []),
        clone(record),
      ]);
      for (const event of newEvents) events.set(event.id, clone(event));

      return true;
    },
  };
};

import type {
  ArtifactAssetReference,
  ArtifactAssetWriteInput,
  ArtifactListQuery,
  ArtifactRecord,
  ArtifactRevision,
} from "./types";

export type ArtifactAssetStore = {
  read(
    reference: ArtifactAssetReference,
    context: { artifact: ArtifactRecord },
  ): Promise<Uint8Array>;
  write(
    input: ArtifactAssetWriteInput,
    context: { artifact: ArtifactRecord; idempotencyKey: string },
  ): Promise<ArtifactAssetReference>;
};

export type ArtifactStore = {
  /** Persist the current record and its first immutable revision atomically. */
  create(record: ArtifactRecord): Promise<void>;
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
  /** Compare, replace current state, and append its revision atomically. */
  save(record: ArtifactRecord, expectedRevision: number): Promise<boolean>;
};

const clone = <T>(value: T): T => structuredClone(value);

export const createMemoryArtifactAssetStore = (): ArtifactAssetStore => {
  const bytes = new Map<string, Uint8Array>();
  const references = new Map<string, ArtifactAssetReference>();
  const idempotency = new Map<string, string>();

  return {
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
  };
};

export const createMemoryArtifactStore = (
  initial: ArtifactRecord[] = [],
): ArtifactStore => {
  const records = new Map(initial.map((record) => [record.id, clone(record)]));
  const revisions = new Map<string, ArtifactRevision[]>();
  for (const record of initial) revisions.set(record.id, [clone(record)]);

  return {
    create: async (record) => {
      if (records.has(record.id))
        throw new Error(`Duplicate artifact id: ${record.id}`);
      records.set(record.id, clone(record));
      revisions.set(record.id, [clone(record)]);
    },
    get: async (ownerId, artifactId) => {
      const record = records.get(artifactId);

      return record?.ownerId === ownerId ? clone(record) : null;
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
    save: async (record, expectedRevision) => {
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

      return true;
    },
  };
};
import { createHash } from "node:crypto";

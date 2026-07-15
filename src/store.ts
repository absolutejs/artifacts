import type { ArtifactListQuery, ArtifactRecord } from "./types";

export type ArtifactStore = {
  create(record: ArtifactRecord): Promise<void>;
  get(ownerId: string, artifactId: string): Promise<ArtifactRecord | null>;
  list(ownerId: string, query?: ArtifactListQuery): Promise<ArtifactRecord[]>;
  save(record: ArtifactRecord, expectedRevision: number): Promise<boolean>;
};

const clone = <T>(value: T): T => structuredClone(value);

export const createMemoryArtifactStore = (
  initial: ArtifactRecord[] = [],
): ArtifactStore => {
  const records = new Map(initial.map((record) => [record.id, clone(record)]));

  return {
    create: async (record) => {
      if (records.has(record.id))
        throw new Error(`Duplicate artifact id: ${record.id}`);
      records.set(record.id, clone(record));
    },
    get: async (ownerId, artifactId) => {
      const record = records.get(artifactId);

      return record?.ownerId === ownerId ? clone(record) : null;
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

      return true;
    },
  };
};

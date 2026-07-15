import type { ArtifactKindDefinitions, ArtifactRegistry } from "./registry";
import type { ArtifactStore } from "./store";
import {
  ArtifactError,
  type ArtifactCreateInput,
  type ArtifactListQuery,
  type ArtifactPublication,
  type ArtifactRecord,
  type ArtifactUpdateInput,
} from "./types";

export type ArtifactPublisher = {
  publish(
    artifact: ArtifactRecord,
    options: { idempotencyKey: string },
  ): Promise<{ id: string; url: string }>;
  unpublish(
    artifact: ArtifactRecord,
    options: { idempotencyKey: string },
  ): Promise<void>;
};

export type ArtifactServiceOptions<
  TDefinitions extends ArtifactKindDefinitions = ArtifactKindDefinitions,
> = {
  clock?: () => Date;
  idFactory?: () => string;
  publisher?: ArtifactPublisher;
  registry: ArtifactRegistry<TDefinitions>;
  store: ArtifactStore;
};

export type ArtifactService = ReturnType<typeof createArtifactService>;

const requireCapability = (
  artifact: ArtifactRecord,
  capability: ArtifactRecord["capabilities"][number],
) => {
  if (!artifact.capabilities.includes(capability)) {
    throw new ArtifactError(
      "unsupported_capability",
      `${artifact.kind} artifacts do not support ${capability}`,
    );
  }
};

export const createArtifactService = <
  TDefinitions extends ArtifactKindDefinitions,
>(
  options: ArtifactServiceOptions<TDefinitions>,
) => {
  const now = () => (options.clock ?? (() => new Date()))().toISOString();
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());

  const get = async (ownerId: string, artifactId: string) => {
    const artifact = await options.store.get(ownerId, artifactId);
    if (!artifact) {
      throw new ArtifactError("not_found", "Artifact not found");
    }

    return artifact;
  };

  const saveRevision = async (
    artifact: ArtifactRecord,
    expectedRevision: number,
  ) => {
    const saved = await options.store.save(artifact, expectedRevision);
    if (!saved) {
      throw new ArtifactError(
        "conflict",
        "Artifact changed since it was opened; reload before saving",
      );
    }

    return artifact;
  };

  return {
    archive: async (ownerId: string, artifactId: string) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "archive");

      return saveRevision(
        {
          ...current,
          revision: current.revision + 1,
          status: "archived",
          updatedAt: now(),
        },
        current.revision,
      );
    },
    create: async (ownerId: string, input: ArtifactCreateInput) => {
      const definition = options.registry.definitions[input.kind];
      if (!definition) {
        throw new ArtifactError(
          "unknown_kind",
          `Unknown artifact kind: ${input.kind}`,
        );
      }
      const content = options.registry.parse(input.kind, input.content);
      const timestamp = now();
      const artifact: ArtifactRecord = {
        capabilities: definition.capabilities ?? ["archive", "edit", "preview"],
        content,
        createdAt: timestamp,
        createdBy: input.createdBy,
        id: idFactory(),
        kind: input.kind,
        metadata: input.metadata ?? {},
        ownerId,
        provenance: input.provenance,
        revision: 1,
        schemaVersion: definition.schemaVersion ?? 1,
        status: "draft",
        title: input.title.trim(),
        updatedAt: timestamp,
      };
      await options.store.create(artifact);

      return artifact;
    },
    get,
    list: (ownerId: string, query?: ArtifactListQuery) =>
      options.store.list(ownerId, query),
    publish: async (ownerId: string, artifactId: string) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "publish");
      if (!options.publisher) {
        throw new ArtifactError(
          "publisher_unavailable",
          "No artifact publisher is configured",
        );
      }
      const result = await options.publisher.publish(current, {
        idempotencyKey: `artifact:${current.id}:publish:${current.revision + 1}`,
      });
      const publishedAt = now();
      const publication: ArtifactPublication = {
        id: result.id,
        publishedAt,
        url: result.url,
      };

      return saveRevision(
        {
          ...current,
          publication,
          revision: current.revision + 1,
          status: "published",
          updatedAt: publishedAt,
        },
        current.revision,
      );
    },
    unpublish: async (ownerId: string, artifactId: string) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "publish");
      if (!options.publisher) {
        throw new ArtifactError(
          "publisher_unavailable",
          "No artifact publisher is configured",
        );
      }
      await options.publisher.unpublish(current, {
        idempotencyKey: `artifact:${current.id}:unpublish:${current.revision + 1}`,
      });

      return saveRevision(
        {
          ...current,
          publication: undefined,
          revision: current.revision + 1,
          status: "draft",
          updatedAt: now(),
        },
        current.revision,
      );
    },
    update: async (
      ownerId: string,
      artifactId: string,
      input: ArtifactUpdateInput,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "edit");
      const expectedRevision = input.expectedRevision ?? current.revision;
      const content =
        input.content === undefined
          ? current.content
          : options.registry.parse(current.kind, input.content);

      return saveRevision(
        {
          ...current,
          content,
          metadata: input.metadata ?? current.metadata,
          revision: current.revision + 1,
          title: input.title?.trim() || current.title,
          updatedAt: now(),
        },
        expectedRevision,
      );
    },
  };
};

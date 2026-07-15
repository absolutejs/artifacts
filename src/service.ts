import type { ArtifactKindDefinitions, ArtifactRegistry } from "./registry";
import type { ArtifactAssetStore, ArtifactStore } from "./store";
import {
  ArtifactError,
  type ArtifactAssetReference,
  type ArtifactAssetWriteInput,
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
  assetStore?: ArtifactAssetStore;
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

const mediaTypeMatches = (accepted: string, actual: string) => {
  if (accepted === "*/*" || accepted === actual) return true;
  if (!accepted.endsWith("/*")) return false;

  return actual.startsWith(accepted.slice(0, -1));
};

export const createArtifactService = <
  TDefinitions extends ArtifactKindDefinitions,
>(
  options: ArtifactServiceOptions<TDefinitions>,
) => {
  const now = () => (options.clock ?? (() => new Date()))().toISOString();
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());

  const validateAssets = (kind: string, assets: ArtifactAssetReference[]) => {
    const policy = options.registry.definitions[kind]?.assets;
    if (!policy) {
      if (assets.length > 0) {
        throw new ArtifactError(
          "invalid_content",
          `${kind} artifacts do not accept file assets`,
        );
      }

      return assets;
    }
    if (policy.maxCount !== undefined && assets.length > policy.maxCount) {
      throw new ArtifactError(
        "invalid_content",
        `${kind} artifacts accept at most ${policy.maxCount} file assets`,
      );
    }
    const rejected = assets.find(
      (asset) =>
        policy.acceptedMediaTypes?.length &&
        !policy.acceptedMediaTypes.some((accepted) =>
          mediaTypeMatches(accepted, asset.mediaType),
        ),
    );
    if (rejected) {
      throw new ArtifactError(
        "invalid_content",
        `${rejected.mediaType} is not accepted by ${kind} artifacts`,
      );
    }

    return assets;
  };

  const validateNewAsset = (
    kind: string,
    input: ArtifactAssetWriteInput,
    currentCount: number,
  ) => {
    const policy = options.registry.definitions[kind]?.assets;
    if (!policy) {
      throw new ArtifactError(
        "invalid_content",
        `${kind} artifacts do not accept file assets`,
      );
    }
    if (policy.maxCount !== undefined && currentCount >= policy.maxCount) {
      throw new ArtifactError(
        "invalid_content",
        `${kind} artifacts accept at most ${policy.maxCount} file assets`,
      );
    }
    if (
      policy.acceptedMediaTypes?.length &&
      !policy.acceptedMediaTypes.some((accepted) =>
        mediaTypeMatches(accepted, input.mediaType),
      )
    ) {
      throw new ArtifactError(
        "invalid_content",
        `${input.mediaType} is not accepted by ${kind} artifacts`,
      );
    }
  };

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
    attach: async (
      ownerId: string,
      artifactId: string,
      input: ArtifactAssetWriteInput,
      expectedRevision?: number,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "attach");
      validateNewAsset(current.kind, input, current.assets.length);
      if (!options.assetStore) {
        throw new ArtifactError(
          "asset_store_unavailable",
          "No artifact asset store is configured",
        );
      }
      const reference = await options.assetStore.write(input, {
        artifact: current,
        idempotencyKey: `artifact:${current.id}:asset:${current.revision + 1}`,
      });
      const assets = validateAssets(current.kind, [
        ...current.assets.filter((asset) => asset.id !== reference.id),
        reference,
      ]);

      return saveRevision(
        {
          ...current,
          assets,
          revision: current.revision + 1,
          updatedAt: now(),
        },
        expectedRevision ?? current.revision,
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
        assets: validateAssets(input.kind, input.assets ?? []),
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
    detach: async (
      ownerId: string,
      artifactId: string,
      assetId: string,
      expectedRevision?: number,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "attach");
      const assets = current.assets.filter((asset) => asset.id !== assetId);
      if (assets.length === current.assets.length) {
        throw new ArtifactError("not_found", "Artifact asset not found");
      }

      return saveRevision(
        {
          ...current,
          assets,
          revision: current.revision + 1,
          updatedAt: now(),
        },
        expectedRevision ?? current.revision,
      );
    },
    get,
    getRevision: async (
      ownerId: string,
      artifactId: string,
      revision: number,
    ) => {
      const snapshot = await options.store.getRevision(
        ownerId,
        artifactId,
        revision,
      );
      if (!snapshot) {
        throw new ArtifactError("not_found", "Artifact revision not found");
      }

      return snapshot;
    },
    list: (ownerId: string, query?: ArtifactListQuery) =>
      options.store.list(ownerId, query),
    listRevisions: (ownerId: string, artifactId: string) =>
      options.store.listRevisions(ownerId, artifactId),
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
    readAsset: async (ownerId: string, artifactId: string, assetId: string) => {
      const artifact = await get(ownerId, artifactId);
      const asset = artifact.assets.find(
        (candidate) => candidate.id === assetId,
      );
      if (!asset) {
        throw new ArtifactError("not_found", "Artifact asset not found");
      }
      if (!options.assetStore) {
        throw new ArtifactError(
          "asset_store_unavailable",
          "No artifact asset store is configured",
        );
      }

      return {
        asset,
        data: await options.assetStore.read(asset, { artifact }),
      };
    },
    restore: async (
      ownerId: string,
      artifactId: string,
      revision: number,
      expectedRevision?: number,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "edit");
      const snapshot = await options.store.getRevision(
        ownerId,
        artifactId,
        revision,
      );
      if (!snapshot) {
        throw new ArtifactError("not_found", "Artifact revision not found");
      }
      const timestamp = now();

      return saveRevision(
        {
          ...current,
          assets: validateAssets(current.kind, snapshot.assets),
          content: options.registry.parse(current.kind, snapshot.content),
          metadata: snapshot.metadata,
          publication: undefined,
          revision: current.revision + 1,
          status: "draft",
          title: snapshot.title,
          updatedAt: timestamp,
        },
        expectedRevision ?? current.revision,
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
          assets:
            input.assets === undefined
              ? current.assets
              : validateAssets(current.kind, input.assets),
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

import type { ArtifactKindDefinitions, ArtifactRegistry } from "./registry";
import type { ArtifactAssetStore, ArtifactStore } from "./store";
import {
  ArtifactError,
  type ArtifactAssetReference,
  type ArtifactAssetWriteInput,
  type ArtifactBundleCreateInput,
  type ArtifactCreateInput,
  type ArtifactEvent,
  type ArtifactEventQuery,
  type ArtifactEventType,
  type ArtifactGarbageCollectionResult,
  type ArtifactIndexingState,
  type ArtifactIndexingStatus,
  type ArtifactListQuery,
  type ArtifactPublication,
  type ArtifactPublishInput,
  type ArtifactRecord,
  type ArtifactUpdateInput,
} from "./types";

export type ArtifactPublisher = {
  publish(
    artifact: ArtifactRecord,
    options: {
      idempotencyKey: string;
      mode: "live" | "pinned";
      revision: number;
    },
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
  eventIdFactory?: () => string;
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
  const eventIdFactory = options.eventIdFactory ?? (() => crypto.randomUUID());

  const event = (
    artifact: ArtifactRecord,
    type: ArtifactEventType,
    payload?: Record<string, unknown>,
  ): ArtifactEvent => ({
    artifactId: artifact.id,
    createdAt: now(),
    id: eventIdFactory(),
    ownerId: artifact.ownerId,
    payload,
    revision: artifact.revision,
    type,
  });

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

  const validateAssetInputs = (
    kind: string,
    inputs: ArtifactAssetWriteInput[],
    currentCount = 0,
  ) => {
    const policy = options.registry.definitions[kind]?.assets;
    if (!policy && inputs.length > 0) {
      throw new ArtifactError(
        "invalid_content",
        `${kind} artifacts do not accept file assets`,
      );
    }
    if (
      policy?.maxCount !== undefined &&
      currentCount + inputs.length > policy.maxCount
    ) {
      throw new ArtifactError(
        "invalid_content",
        `${kind} artifacts accept at most ${policy.maxCount} file assets`,
      );
    }
    const rejected = inputs.find(
      (input) =>
        policy?.acceptedMediaTypes?.length &&
        !policy.acceptedMediaTypes.some((accepted) =>
          mediaTypeMatches(accepted, input.mediaType),
        ),
    );
    if (rejected) {
      throw new ArtifactError(
        "invalid_content",
        `${rejected.mediaType} is not accepted by ${kind} artifacts`,
      );
    }
  };

  const buildRecord = (
    ownerId: string,
    input: ArtifactCreateInput,
    assets: ArtifactAssetReference[],
  ) => {
    const definition = options.registry.definitions[input.kind];
    if (!definition) {
      throw new ArtifactError(
        "unknown_kind",
        `Unknown artifact kind: ${input.kind}`,
      );
    }
    const timestamp = now();
    const artifact: ArtifactRecord = {
      assets: validateAssets(input.kind, assets),
      capabilities: definition.capabilities ?? ["archive", "edit", "preview"],
      content: options.registry.parse(input.kind, input.content),
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

    return artifact;
  };

  const get = async (ownerId: string, artifactId: string) => {
    const artifact = await options.store.get(ownerId, artifactId);
    if (!artifact) throw new ArtifactError("not_found", "Artifact not found");

    return artifact;
  };

  const saveRevision = async (
    artifact: ArtifactRecord,
    expectedRevision: number,
    type: ArtifactEventType,
    payload?: Record<string, unknown>,
  ) => {
    const saved = await options.store.save(artifact, expectedRevision, [
      event(artifact, type, payload),
    ]);
    if (!saved) {
      throw new ArtifactError(
        "conflict",
        "Artifact changed since it was opened; reload before saving",
      );
    }

    return artifact;
  };

  const requireAssetTransactions = () => {
    if (!options.assetStore?.stage) {
      throw new ArtifactError(
        "asset_transaction_unavailable",
        "The configured artifact asset store does not support atomic bundles",
      );
    }

    return options.assetStore;
  };

  const service = {
    archive: async (ownerId: string, artifactId: string) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "archive");
      const archived = {
        ...current,
        revision: current.revision + 1,
        status: "archived" as const,
        updatedAt: now(),
      };

      return saveRevision(archived, current.revision, "artifact.archived");
    },
    attach: async (
      ownerId: string,
      artifactId: string,
      input: ArtifactAssetWriteInput,
      expectedRevision?: number,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "attach");
      validateAssetInputs(current.kind, [input], current.assets.length);
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

      return saveRevision(
        {
          ...current,
          assets: validateAssets(current.kind, [...current.assets, reference]),
          revision: current.revision + 1,
          updatedAt: now(),
        },
        expectedRevision ?? current.revision,
        "artifact.asset_attached",
        { assetIds: [reference.id] },
      );
    },
    attachBundle: async (
      ownerId: string,
      artifactId: string,
      inputs: ArtifactAssetWriteInput[],
      expectedRevision?: number,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "attach");
      validateAssetInputs(current.kind, inputs, current.assets.length);
      const assetStore = requireAssetTransactions();
      const transaction = await assetStore.stage!(inputs, {
        artifact: current,
        idempotencyKey: `artifact:${current.id}:bundle:${current.revision + 1}`,
      });
      const assets = validateAssets(current.kind, [
        ...current.assets,
        ...transaction.references,
      ]);
      const revised: ArtifactRecord = {
        ...current,
        assets,
        revision: current.revision + 1,
        updatedAt: now(),
      };
      try {
        await transaction.commit();

        return await saveRevision(
          revised,
          expectedRevision ?? current.revision,
          "artifact.asset_attached",
          { assetIds: transaction.references.map((asset) => asset.id) },
        );
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    },
    collectAssetGarbage: async (input: {
      dryRun?: boolean;
      minimumAgeMs?: number;
    }): Promise<ArtifactGarbageCollectionResult> => {
      if (!options.assetStore) {
        throw new ArtifactError(
          "asset_store_unavailable",
          "No artifact asset store is configured",
        );
      }
      const referenced = new Set(await options.store.listReferencedAssetIds());
      const cutoff = Date.now() - (input.minimumAgeMs ?? 0);
      const candidates = await options.assetStore.listCandidates();
      const deleted: ArtifactAssetReference[] = [];
      const retained: ArtifactAssetReference[] = [];
      for (const candidate of candidates) {
        if (
          referenced.has(candidate.reference.id) ||
          new Date(candidate.createdAt).getTime() > cutoff
        ) {
          retained.push(candidate.reference);
        } else {
          deleted.push(candidate.reference);
          if (!input.dryRun)
            await options.assetStore.delete(candidate.reference);
        }
      }

      return { deleted, retained };
    },
    create: async (ownerId: string, input: ArtifactCreateInput) => {
      const artifact = buildRecord(ownerId, input, input.assets ?? []);
      await options.store.create(artifact, [
        event(artifact, "artifact.created"),
      ]);

      return artifact;
    },
    createBundle: async (ownerId: string, input: ArtifactBundleCreateInput) => {
      const { assets: assetInputs = [], ...createInput } = input;
      validateAssetInputs(input.kind, assetInputs);
      if (assetInputs.length === 0) {
        return service.create(ownerId, createInput);
      }
      const assetStore = requireAssetTransactions();
      const provisional = buildRecord(ownerId, createInput, []);
      const transaction = await assetStore.stage!(assetInputs, {
        artifact: provisional,
        idempotencyKey: `artifact:${provisional.id}:bundle:1`,
      });
      const artifact = {
        ...provisional,
        assets: validateAssets(input.kind, transaction.references),
      };
      try {
        await transaction.commit();
        await options.store.create(artifact, [
          event(artifact, "artifact.created"),
          event(artifact, "artifact.generated", {
            assetIds: transaction.references.map((asset) => asset.id),
          }),
        ]);

        return artifact;
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
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
        "artifact.asset_detached",
        { assetId },
      );
    },
    get,
    getIndexingState: (ownerId: string, artifactId: string) =>
      options.store.getIndexingState(ownerId, artifactId),
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
    listEvents: (query?: ArtifactEventQuery) => options.store.listEvents(query),
    listRevisions: (ownerId: string, artifactId: string) =>
      options.store.listRevisions(ownerId, artifactId),
    markEventProcessed: (eventId: string, processedAt = now()) =>
      options.store.markEventProcessed(eventId, processedAt),
    markIndexing: async (
      ownerId: string,
      artifactId: string,
      input: {
        documentIds?: string[];
        error?: string;
        revision: number;
        status: ArtifactIndexingStatus;
      },
    ) => {
      const artifact = await get(ownerId, artifactId);
      const state: ArtifactIndexingState = {
        artifactId,
        documentIds: input.documentIds ?? [],
        error: input.error,
        indexedAt: input.status === "indexed" ? now() : undefined,
        revision: input.revision,
        status: input.status,
        updatedAt: now(),
      };
      await options.store.putIndexingState(ownerId, state, [
        event(artifact, "artifact.indexing_changed", {
          indexingRevision: state.revision,
          indexingStatus: state.status,
        }),
      ]);

      return state;
    },
    publish: async (
      ownerId: string,
      artifactId: string,
      input: ArtifactPublishInput = {},
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "publish");
      if (!options.publisher) {
        throw new ArtifactError(
          "publisher_unavailable",
          "No artifact publisher is configured",
        );
      }
      const mode = input.mode ?? "pinned";
      const publishedRevision = current.revision;
      const result = await options.publisher.publish(current, {
        idempotencyKey: `artifact:${current.id}:publish:${publishedRevision}:${mode}`,
        mode,
        revision: publishedRevision,
      });
      const publishedAt = now();
      const publication: ArtifactPublication = {
        id: result.id,
        mode,
        publishedAt,
        revision: publishedRevision,
        url: result.url,
      };
      const published = {
        ...current,
        publication,
        revision: current.revision + 1,
        status: "published" as const,
        updatedAt: publishedAt,
      };

      return saveRevision(published, current.revision, "artifact.published", {
        mode,
        publishedRevision,
      });
    },
    readAsset: async (ownerId: string, artifactId: string, assetId: string) => {
      const artifact = await get(ownerId, artifactId);
      const asset = artifact.assets.find(
        (candidate) => candidate.id === assetId,
      );
      if (!asset)
        throw new ArtifactError("not_found", "Artifact asset not found");
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

      return saveRevision(
        {
          ...current,
          assets: validateAssets(current.kind, snapshot.assets),
          content: options.registry.parse(current.kind, snapshot.content),
          metadata: snapshot.metadata,
          publication: undefined,
          provenance: snapshot.provenance,
          revision: current.revision + 1,
          status: "draft",
          title: snapshot.title,
          updatedAt: now(),
        },
        expectedRevision ?? current.revision,
        "artifact.restored",
        { restoredRevision: revision },
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
        "artifact.unpublished",
      );
    },
    update: async (
      ownerId: string,
      artifactId: string,
      input: ArtifactUpdateInput,
    ) => {
      const current = await get(ownerId, artifactId);
      requireCapability(current, "edit");
      const nextRevision = current.revision + 1;
      const publication =
        current.publication?.mode === "live"
          ? { ...current.publication, revision: nextRevision }
          : current.publication;

      return saveRevision(
        {
          ...current,
          assets:
            input.assets === undefined
              ? current.assets
              : validateAssets(current.kind, input.assets),
          content:
            input.content === undefined
              ? current.content
              : options.registry.parse(current.kind, input.content),
          metadata: input.metadata ?? current.metadata,
          publication,
          revision: nextRevision,
          title: input.title?.trim() || current.title,
          updatedAt: now(),
        },
        input.expectedRevision ?? current.revision,
        "artifact.revised",
      );
    },
  };

  return service;
};

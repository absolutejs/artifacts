import type { ArtifactKindDefinitions, ArtifactRegistry } from "./registry";
import type {
  ArtifactAssetStore,
  ArtifactAssetTransaction,
  ArtifactStore,
} from "./store";
import {
  ArtifactError,
  type ArtifactAssetReference,
  type ArtifactAssetWriteInput,
  type ArtifactBatchCompletionReceipt,
  type ArtifactBatchCreateInput,
  type ArtifactBatchValidationIssue,
  type ArtifactBatchValidator,
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
  type JsonObject,
  type StagedArtifactBatch,
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
  batchIdFactory?: () => string;
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
  const batchIdFactory = options.batchIdFactory ?? (() => crypto.randomUUID());

  const event = (
    artifact: ArtifactRecord,
    type: ArtifactEventType,
    payload?: JsonObject,
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
    payload?: JsonObject,
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
    stageBatch: async (
      ownerId: string,
      input: ArtifactBatchCreateInput,
      stageOptions: { validators?: ArtifactBatchValidator[] } = {},
    ): Promise<StagedArtifactBatch> => {
      if (input.items.length === 0) {
        throw new ArtifactError(
          "invalid_content",
          "An artifact batch must contain at least one artifact",
        );
      }
      const keys = input.items.map((item) => item.key.trim());
      if (
        keys.some((key) => key.length === 0) ||
        new Set(keys).size !== keys.length
      ) {
        throw new ArtifactError(
          "invalid_content",
          "Artifact batch item keys must be non-empty and unique",
        );
      }

      const bundleId = input.bundleId ?? batchIdFactory();
      const stagedAt = now();
      const sharedEvidence = input.evidence ?? [];
      const staged: Array<{
        evidence: NonNullable<(typeof input.items)[number]["evidence"]>;
        key: string;
        record: ArtifactRecord;
        transaction?: ArtifactAssetTransaction;
      }> = [];
      const evidenceJson = (
        evidence: NonNullable<(typeof input.items)[number]["evidence"]>,
      ) =>
        evidence.map((reference) => ({
          ...(reference.capturedAt ? { capturedAt: reference.capturedAt } : {}),
          ...(reference.excerpt ? { excerpt: reference.excerpt } : {}),
          ...(reference.metadata ? { metadata: reference.metadata } : {}),
          ...(reference.sourceId ? { sourceId: reference.sourceId } : {}),
          ...(reference.sourceUrl ? { sourceUrl: reference.sourceUrl } : {}),
        }));

      try {
        for (const [index, item] of input.items.entries()) {
          const { assets: assetInputs = [], ...artifactInput } = item.artifact;
          validateAssetInputs(item.artifact.kind, assetInputs);
          const evidence = [...sharedEvidence, ...(item.evidence ?? [])];
          const provisional = buildRecord(
            ownerId,
            {
              ...artifactInput,
              metadata: {
                ...input.metadata,
                ...artifactInput.metadata,
                artifactBatch: {
                  bundleId,
                  evidence: evidenceJson(evidence),
                  itemKey: item.key,
                },
              },
              provenance: {
                ...input.provenance,
                ...artifactInput.provenance,
                evidence,
                sourceIds: [
                  ...new Set([
                    ...(input.provenance?.sourceIds ?? []),
                    ...(artifactInput.provenance?.sourceIds ?? []),
                    ...evidence.flatMap((reference) =>
                      reference.sourceId ? [reference.sourceId] : [],
                    ),
                  ]),
                ],
              },
            },
            [],
          );
          if (assetInputs.length === 0) {
            staged.push({ evidence, key: item.key, record: provisional });
            continue;
          }
          const assetStore = requireAssetTransactions();
          const transaction = await assetStore.stage!(assetInputs, {
            artifact: provisional,
            idempotencyKey: `artifact-batch:${bundleId}:${index}`,
          });
          staged.push({
            evidence,
            key: item.key,
            record: {
              ...provisional,
              assets: validateAssets(
                item.artifact.kind,
                transaction.references,
              ),
            },
            transaction,
          });
        }
      } catch (error) {
        await Promise.allSettled(
          staged.map((item) => item.transaction?.rollback()),
        );
        throw error;
      }

      let validationIssues: ArtifactBatchValidationIssue[];
      try {
        validationIssues = (
          await Promise.all(
            (stageOptions.validators ?? []).map((validate) =>
              validate({
                bundleId,
                evidence: sharedEvidence,
                items: staged,
                ownerId,
              }),
            ),
          )
        ).flat();
      } catch (error) {
        await Promise.allSettled(
          staged.map((item) => item.transaction?.rollback()),
        );
        throw error;
      }
      const validation =
        validationIssues.length === 0
          ? ({ valid: true } as const)
          : ({ issues: validationIssues, valid: false } as const);
      let settled: ArtifactBatchCompletionReceipt | undefined;

      const receiptItems = () =>
        staged.map(({ key, record }) => ({
          artifactId: record.id,
          key,
          kind: record.kind,
          revision: record.revision,
          title: record.title,
        }));
      const finish = (
        partial: Omit<
          ArtifactBatchCompletionReceipt,
          | "bundleId"
          | "completedAt"
          | "items"
          | "ownerId"
          | "stagedAt"
          | "validation"
        > & { items?: ArtifactBatchCompletionReceipt["items"] },
      ) => {
        settled = {
          bundleId,
          completedAt: now(),
          items: partial.items ?? receiptItems(),
          ownerId,
          stagedAt,
          validation,
          ...partial,
        };

        return settled;
      };
      const rollbackTransactions = async (
        candidates = staged,
      ): Promise<string[]> => {
        const failures: string[] = [];
        for (const item of candidates) {
          if (!item.transaction) continue;
          try {
            await item.transaction.rollback();
          } catch {
            failures.push(item.key);
          }
        }

        return failures;
      };

      if (!validation.valid) {
        const failures = await rollbackTransactions();
        finish({
          archivedArtifactIds: [],
          atomic: Boolean(options.store.createBatch),
          error:
            failures.length === 0
              ? "Artifact batch validation failed"
              : `Artifact batch validation failed; asset rollback failed for: ${failures.join(", ")}`,
          status: failures.length === 0 ? "rolled_back" : "partial_failure",
        });
      }

      return {
        bundleId,
        commit: async () => {
          if (settled) return settled;
          const transactions = staged.flatMap((item) =>
            item.transaction ? [item.transaction] : [],
          );
          const entries = staged.map(({ key, record }) => ({
            events: [
              event(record, "artifact.created", { bundleId, itemKey: key }),
              event(record, "artifact.generated", { bundleId, itemKey: key }),
            ],
            record,
          }));

          if (options.store.createBatch) {
            try {
              for (const transaction of transactions)
                await transaction.commit();
              await options.store.createBatch(entries);

              return finish({
                archivedArtifactIds: [],
                atomic: true,
                status: "committed",
              });
            } catch (error) {
              const failures = await rollbackTransactions();

              return finish({
                archivedArtifactIds: [],
                atomic: true,
                error: error instanceof Error ? error.message : String(error),
                status:
                  failures.length === 0 ? "rolled_back" : "partial_failure",
              });
            }
          }

          if ((input.commitMode ?? "require_atomic") === "require_atomic") {
            const failures = await rollbackTransactions();

            return finish({
              archivedArtifactIds: [],
              atomic: false,
              error:
                "The configured artifact store does not support atomic batches",
              status: failures.length === 0 ? "rolled_back" : "partial_failure",
            });
          }

          const created: typeof staged = [];
          try {
            for (const transaction of transactions) await transaction.commit();
            for (const [index, entry] of entries.entries()) {
              await options.store.create(entry.record, entry.events);
              created.push(staged[index]!);
            }

            return finish({
              archivedArtifactIds: [],
              atomic: false,
              status: "committed",
            });
          } catch (error) {
            const archivedArtifactIds: string[] = [];
            const archiveFailures: string[] = [];
            for (const item of created) {
              try {
                await service.archive(ownerId, item.record.id);
                archivedArtifactIds.push(item.record.id);
              } catch {
                archiveFailures.push(item.record.id);
              }
            }
            const uncreated = staged.filter((item) => !created.includes(item));
            const rollbackFailures = await rollbackTransactions(uncreated);
            const failed = [...archiveFailures, ...rollbackFailures];

            return finish({
              archivedArtifactIds,
              atomic: false,
              error: error instanceof Error ? error.message : String(error),
              items: receiptItems().map((item) => ({
                ...item,
                ...(archivedArtifactIds.includes(item.artifactId)
                  ? { archived: true }
                  : {}),
              })),
              status: failed.length === 0 ? "rolled_back" : "partial_failure",
            });
          }
        },
        evidence: sharedEvidence,
        items: staged,
        ownerId,
        rollback: async (
          reason = "Artifact batch rolled back before commit",
        ) => {
          if (settled) return settled;
          const failures = await rollbackTransactions();

          return finish({
            archivedArtifactIds: [],
            atomic: Boolean(options.store.createBatch),
            error:
              failures.length === 0
                ? reason
                : `${reason}; asset rollback failed for: ${failures.join(", ")}`,
            status: failures.length === 0 ? "rolled_back" : "partial_failure",
          });
        },
        stagedAt,
        validation,
      };
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
    purgeOwner: (ownerId: string) => options.store.purgeOwner(ownerId),
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

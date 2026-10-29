import { Buffer } from "node:buffer";
import type { RAGDocumentUploadInput } from "@absolutejs/rag";
import type { ArtifactAssetReference, ArtifactRecord } from "./types";

export type ArtifactRAGAssetReader = {
  read(
    reference: ArtifactAssetReference,
    context: { artifact: ArtifactRecord },
  ): Promise<Uint8Array>;
};

export type ArtifactRAGUploadOptions = {
  includeStructuredContent?: boolean;
};

export type ArtifactRAGIndexTarget = {
  index(
    uploads: RAGDocumentUploadInput[],
    context: { artifact: ArtifactRecord },
  ): Promise<{ documentIds: string[] }>;
  remove?(
    documentIds: string[],
    context: { artifact: ArtifactRecord },
  ): Promise<void>;
};

export type ArtifactRAGIndexStateWriter = {
  getIndexingState(
    ownerId: string,
    artifactId: string,
  ): Promise<{ documentIds: string[] } | null>;
  markIndexing(
    ownerId: string,
    artifactId: string,
    input: {
      documentIds?: string[];
      error?: string;
      revision: number;
      status: "failed" | "indexed" | "partial" | "pending" | "stale";
    },
  ): Promise<unknown>;
};

export type ArtifactRAGIndexFailure = {
  contentType: string;
  error: string;
  name: string;
  source: string;
};

export type ArtifactRAGIndexReceipt = {
  artifactId: string;
  documentIds: string[];
  failures: ArtifactRAGIndexFailure[];
  indexedUploads: number;
  revision: number;
  status: "failed" | "indexed" | "partial";
  totalUploads: number;
};

export class ArtifactRAGPartialIndexError extends Error {
  readonly receipt: ArtifactRAGIndexReceipt;

  constructor(receipt: ArtifactRAGIndexReceipt) {
    super(
      `Artifact ${receipt.artifactId} indexed ${receipt.indexedUploads}/${receipt.totalUploads} uploads; ${receipt.failures.length} failed`,
    );
    this.name = "ArtifactRAGPartialIndexError";
    this.receipt = receipt;
  }
}

const artifactMetadata = (artifact: ArtifactRecord) => ({
  artifactId: artifact.id,
  artifactKind: artifact.kind,
  artifactRevision: artifact.revision,
  artifactStatus: artifact.status,
  ...artifact.metadata,
});

const artifactUploadSources = (
  artifact: ArtifactRecord,
  reader: ArtifactRAGAssetReader,
  options: ArtifactRAGUploadOptions = {},
) => {
  const metadata = artifactMetadata(artifact);
  const assets = artifact.assets.map((asset) => ({
    contentType: asset.mediaType,
    encoding: "base64" as const,
    metadata: {
      ...metadata,
      artifactAssetId: asset.id,
      artifactAssetRole: asset.role,
      ...asset.metadata,
    },
    name: asset.name,
    source: `artifact:${artifact.id}:revision:${artifact.revision}:asset:${asset.id}`,
    title: artifact.title,
    read: async () =>
      Buffer.from(await reader.read(asset, { artifact })).toString("base64"),
  }));
  if (options.includeStructuredContent === false) return assets;
  return [
    {
      contentType: "application/json",
      encoding: "utf8" as const,
      metadata: { ...metadata, artifactStructuredContent: true },
      name: `${artifact.kind}-${artifact.id}-r${artifact.revision}.json`,
      source: `artifact:${artifact.id}:revision:${artifact.revision}:content`,
      title: artifact.title,
      read: async () => JSON.stringify(artifact.content),
    },
    ...assets,
  ];
};

/** Resolve revision bytes. Storage URIs remain opaque to callers. */
export const artifactToRAGUploads = async (
  artifact: ArtifactRecord,
  reader: ArtifactRAGAssetReader,
  options: ArtifactRAGUploadOptions = {},
): Promise<RAGDocumentUploadInput[]> =>
  Promise.all(
    artifactUploadSources(artifact, reader, options).map(
      async ({ read, ...upload }) => ({
        ...upload,
        content: await read(),
      }),
    ),
  );

export const createArtifactRAGIndexCoordinator = (options: {
  failureMode?: "fail_fast" | "isolate_uploads";
  reader: ArtifactRAGAssetReader;
  service: ArtifactRAGIndexStateWriter;
  target: ArtifactRAGIndexTarget;
}) => ({
  index: async (artifact: ArtifactRecord) => {
    const previous = await options.service.getIndexingState(
      artifact.ownerId,
      artifact.id,
    );
    await options.service.markIndexing(artifact.ownerId, artifact.id, {
      documentIds: previous?.documentIds,
      revision: artifact.revision,
      status: "pending",
    });
    try {
      if (options.failureMode === "isolate_uploads") {
        const documentIds: string[] = [];
        const failures: ArtifactRAGIndexFailure[] = [];
        let indexedUploads = 0;
        const sources = artifactUploadSources(artifact, options.reader);
        for (const { read, ...upload } of sources) {
          try {
            const content = await read();
            const indexed = await options.target.index(
              [{ ...upload, content }],
              { artifact },
            );
            documentIds.push(...indexed.documentIds);
            indexedUploads += 1;
          } catch (error) {
            failures.push({
              contentType: upload.contentType ?? "application/octet-stream",
              error: error instanceof Error ? error.message : String(error),
              name: upload.name ?? "unnamed upload",
              source: upload.source ?? `artifact:${artifact.id}`,
            });
          }
        }
        const receipt: ArtifactRAGIndexReceipt = {
          artifactId: artifact.id,
          documentIds,
          failures,
          indexedUploads,
          revision: artifact.revision,
          status:
            failures.length === 0
              ? "indexed"
              : indexedUploads > 0
                ? "partial"
                : "failed",
          totalUploads: sources.length,
        };
        if (failures.length > 0) {
          await options.service.markIndexing(artifact.ownerId, artifact.id, {
            documentIds: [
              ...new Set([...(previous?.documentIds ?? []), ...documentIds]),
            ],
            error: JSON.stringify({ failures, receipt }),
            revision: artifact.revision,
            status: receipt.status,
          });
          throw new ArtifactRAGPartialIndexError(receipt);
        }
        if (previous?.documentIds.length && options.target.remove) {
          const currentIds = new Set(documentIds);
          const obsoleteIds = previous.documentIds.filter(
            (documentId) => !currentIds.has(documentId),
          );
          if (obsoleteIds.length) {
            await options.target.remove(obsoleteIds, { artifact });
          }
        }
        await options.service.markIndexing(artifact.ownerId, artifact.id, {
          documentIds,
          revision: artifact.revision,
          status: "indexed",
        });

        return receipt;
      }
      const uploads = await artifactToRAGUploads(artifact, options.reader);
      const indexed = await options.target.index(uploads, { artifact });
      if (previous?.documentIds.length && options.target.remove) {
        const currentIds = new Set(indexed.documentIds);
        const obsoleteIds = previous.documentIds.filter(
          (documentId) => !currentIds.has(documentId),
        );
        if (obsoleteIds.length) {
          await options.target.remove(obsoleteIds, { artifact });
        }
      }
      await options.service.markIndexing(artifact.ownerId, artifact.id, {
        documentIds: indexed.documentIds,
        revision: artifact.revision,
        status: "indexed",
      });

      return {
        artifactId: artifact.id,
        documentIds: indexed.documentIds,
        failures: [],
        indexedUploads: uploads.length,
        revision: artifact.revision,
        status: "indexed" as const,
        totalUploads: uploads.length,
      };
    } catch (error) {
      if (error instanceof ArtifactRAGPartialIndexError) throw error;
      await options.service.markIndexing(artifact.ownerId, artifact.id, {
        documentIds: previous?.documentIds,
        error: error instanceof Error ? error.message : String(error),
        revision: artifact.revision,
        status: "failed",
      });
      throw error;
    }
  },
});

export type ArtifactRAGIndexCoordinator = ReturnType<
  typeof createArtifactRAGIndexCoordinator
>;

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
      status: "failed" | "indexed" | "pending" | "stale";
    },
  ): Promise<unknown>;
};

const artifactMetadata = (artifact: ArtifactRecord) => ({
  artifactId: artifact.id,
  artifactKind: artifact.kind,
  artifactRevision: artifact.revision,
  artifactStatus: artifact.status,
  ...artifact.metadata,
});

/**
 * Resolve an artifact revision into upload inputs accepted by @absolutejs/rag.
 * Storage URIs remain opaque; only the supplied reader is allowed to access bytes.
 */
export const artifactToRAGUploads = async (
  artifact: ArtifactRecord,
  reader: ArtifactRAGAssetReader,
  options: ArtifactRAGUploadOptions = {},
): Promise<RAGDocumentUploadInput[]> => {
  const metadata = artifactMetadata(artifact);
  const uploads = await Promise.all(
    artifact.assets.map(async (asset) => ({
      content: Buffer.from(await reader.read(asset, { artifact })).toString(
        "base64",
      ),
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
    })),
  );

  if (options.includeStructuredContent === false) return uploads;

  return [
    {
      content: JSON.stringify(artifact.content),
      contentType: "application/json",
      encoding: "utf8",
      metadata: { ...metadata, artifactStructuredContent: true },
      name: `${artifact.kind}-${artifact.id}-r${artifact.revision}.json`,
      source: `artifact:${artifact.id}:revision:${artifact.revision}:content`,
      title: artifact.title,
    },
    ...uploads,
  ];
};

export const createArtifactRAGIndexCoordinator = (options: {
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
      const uploads = await artifactToRAGUploads(artifact, options.reader);
      const indexed = await options.target.index(uploads, { artifact });
      if (previous?.documentIds.length && options.target.remove) {
        await options.target.remove(previous.documentIds, { artifact });
      }
      await options.service.markIndexing(artifact.ownerId, artifact.id, {
        documentIds: indexed.documentIds,
        revision: artifact.revision,
        status: "indexed",
      });

      return indexed;
    } catch (error) {
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

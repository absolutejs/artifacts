import { Type, type TSchema } from "@sinclair/typebox";
import type { ArtifactService } from "./service";
import { ARTIFACT_STATUSES } from "./types";

export type ArtifactToolDefinition = {
  annotations?: { readOnlyHint?: boolean };
  description: string;
  handler(input: unknown): Promise<string> | string;
  input: TSchema;
};

export type ArtifactToolMap = Record<string, ArtifactToolDefinition>;

export type ArtifactToolOptions = {
  createdBy: string;
  ownerId: string;
  service: ArtifactService;
};

const record = (input: unknown) =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

const stringValue = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === "string" ? input[key] : undefined;

export const createArtifactTools = (
  options: ArtifactToolOptions,
): ArtifactToolMap => ({
  artifact_create: {
    description:
      "Create a private, typed artifact. The kind must be registered by the host; publishing is a separate explicit action.",
    handler: async (raw) => {
      const input = record(raw);
      const kind = stringValue(input, "kind");
      const title = stringValue(input, "title");
      if (!kind || !title || input.content === undefined) {
        return "Provide kind, title, and content.";
      }
      const artifact = await options.service.create(options.ownerId, {
        content: input.content,
        createdBy: options.createdBy,
        kind,
        title,
      });

      return JSON.stringify(artifact);
    },
    input: Type.Object({
      content: Type.Unknown(),
      kind: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
    }),
  },
  artifact_get: {
    annotations: { readOnlyHint: true },
    description: "Open one artifact owned by the current user.",
    handler: async (raw) => {
      const artifactId = stringValue(record(raw), "artifactId");
      if (!artifactId) return "Provide artifactId.";

      return JSON.stringify(
        await options.service.get(options.ownerId, artifactId),
      );
    },
    input: Type.Object({ artifactId: Type.String({ minLength: 1 }) }),
  },
  artifact_list: {
    annotations: { readOnlyHint: true },
    description: "List artifacts owned by the current user.",
    handler: async (raw) => {
      const input = record(raw);
      const status = stringValue(input, "status");

      return JSON.stringify(
        await options.service.list(options.ownerId, {
          kind: stringValue(input, "kind"),
          status: ARTIFACT_STATUSES.find((candidate) => candidate === status),
        }),
      );
    },
    input: Type.Object({
      kind: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.Union(ARTIFACT_STATUSES.map((status) => Type.Literal(status))),
      ),
    }),
  },
  artifact_history: {
    annotations: { readOnlyHint: true },
    description: "List the immutable revisions of one owned artifact.",
    handler: async (raw) => {
      const artifactId = stringValue(record(raw), "artifactId");
      if (!artifactId) return "Provide artifactId.";

      return JSON.stringify(
        await options.service.listRevisions(options.ownerId, artifactId),
      );
    },
    input: Type.Object({ artifactId: Type.String({ minLength: 1 }) }),
  },
  artifact_publish: {
    description:
      "Publish or unpublish an artifact. Hosts should expose this tool only when the user explicitly controls public access.",
    handler: async (raw) => {
      const input = record(raw);
      const artifactId = stringValue(input, "artifactId");
      if (!artifactId || typeof input.published !== "boolean") {
        return "Provide artifactId and published.";
      }
      const artifact = input.published
        ? await options.service.publish(options.ownerId, artifactId)
        : await options.service.unpublish(options.ownerId, artifactId);

      return JSON.stringify(artifact);
    },
    input: Type.Object({
      artifactId: Type.String({ minLength: 1 }),
      published: Type.Boolean(),
    }),
  },
  artifact_restore: {
    description:
      "Restore an immutable artifact revision as a new private draft revision.",
    handler: async (raw) => {
      const input = record(raw);
      const artifactId = stringValue(input, "artifactId");
      if (!artifactId || typeof input.revision !== "number") {
        return "Provide artifactId and revision.";
      }

      return JSON.stringify(
        await options.service.restore(
          options.ownerId,
          artifactId,
          input.revision,
          typeof input.expectedRevision === "number"
            ? input.expectedRevision
            : undefined,
        ),
      );
    },
    input: Type.Object({
      artifactId: Type.String({ minLength: 1 }),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      revision: Type.Integer({ minimum: 1 }),
    }),
  },
  artifact_update: {
    description:
      "Update an artifact's title or structured content with optional optimistic revision protection.",
    handler: async (raw) => {
      const input = record(raw);
      const artifactId = stringValue(input, "artifactId");
      if (!artifactId) return "Provide artifactId.";
      const artifact = await options.service.update(
        options.ownerId,
        artifactId,
        {
          content: input.content,
          expectedRevision:
            typeof input.expectedRevision === "number"
              ? input.expectedRevision
              : undefined,
          title: stringValue(input, "title"),
        },
      );

      return JSON.stringify(artifact);
    },
    input: Type.Object({
      artifactId: Type.String({ minLength: 1 }),
      content: Type.Optional(Type.Unknown()),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      title: Type.Optional(Type.String({ minLength: 1 })),
    }),
  },
});

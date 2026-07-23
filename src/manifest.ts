import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { ArtifactService } from "./service";

const tool = toolFactory<ArtifactService>();

export const manifest = defineManifest<
  Record<string, never>,
  ArtifactService
>()({
  contract: 2,
  identity: {
    accent: "#8b5cf6",
    category: "ai",
    description:
      "Typed, versioned artifacts for AI products: define structured kinds once, then compose storage, revisions, rendering, publishing, and agent tools without coupling the contract to a database or hosting layer.",
    docsUrl: "https://github.com/absolutejs/artifacts",
    name: "@absolutejs/artifacts",
    tagline: "Give everything your AI makes a real lifecycle.",
  },
  settings: Type.Object({}),
  slots: {
    service: {
      configPath: "$self",
      contract: "artifacts/service",
      description: "The host-configured artifact service",
      known: [],
      required: true,
    },
  },
  tools: {
    artifact_get: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "owner",
        effects: ["read"],
        requiredScopes: ["artifacts:read"],
        resource: {
          idField: "artifactId",
          ownerIdField: "ownerId",
          type: "artifact",
        },
      },
      description: "Open one artifact owned by a user.",
      handler: async ({ artifactId, ownerId }, service) =>
        JSON.stringify(await service.get(ownerId, artifactId)),
      input: Type.Object({
        artifactId: Type.String({ minLength: 1 }),
        ownerId: Type.String({ minLength: 1 }),
      }),
    }),
    artifact_list: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "owner",
        effects: ["read"],
        requiredScopes: ["artifacts:read"],
        resource: { ownerIdField: "ownerId", type: "artifact" },
      },
      description: "List artifacts owned by a user.",
      handler: async ({ kind, ownerId }, service) =>
        JSON.stringify(await service.list(ownerId, { kind })),
      input: Type.Object({
        kind: Type.Optional(Type.String({ minLength: 1 })),
        ownerId: Type.String({ minLength: 1 }),
      }),
    }),
    artifact_history: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "owner",
        effects: ["read"],
        requiredScopes: ["artifacts:read"],
        resource: {
          idField: "artifactId",
          ownerIdField: "ownerId",
          type: "artifact-revision",
        },
      },
      description: "List immutable revisions of one artifact owned by a user.",
      handler: async ({ artifactId, ownerId }, service) =>
        JSON.stringify(await service.listRevisions(ownerId, artifactId)),
      input: Type.Object({
        artifactId: Type.String({ minLength: 1 }),
        ownerId: Type.String({ minLength: 1 }),
      }),
    }),
    artifact_restore: tool.runtime({
      authorization: {
        approval: "policy",
        audience: "owner",
        effects: ["write"],
        idempotency: { mode: "host" },
        requiredScopes: ["artifacts:write"],
        resource: {
          idField: "artifactId",
          ownerIdField: "ownerId",
          type: "artifact-revision",
        },
        reversible: false,
      },
      description: "Restore an old artifact revision as a new private draft.",
      handler: async ({ artifactId, ownerId, revision }, service) =>
        JSON.stringify(await service.restore(ownerId, artifactId, revision)),
      input: Type.Object({
        artifactId: Type.String({ minLength: 1 }),
        ownerId: Type.String({ minLength: 1 }),
        revision: Type.Integer({ minimum: 1 }),
      }),
    }),
  },
  wiring: [
    {
      description:
        "Define structured artifact kinds, provide a store, and create the lifecycle service. Add a publisher only when your host supports public access.",
      id: "default",
      server: {
        code: [
          "const artifactRegistry = defineArtifactRegistry({",
          "\tpage: {",
          "\t\tcapabilities: ['archive', 'edit', 'preview', 'publish'],",
          "\t\tcontent: Type.Object({ blocks: Type.Array(Type.Unknown()) }),",
          "\t\tlabel: 'Page'",
          "\t}",
          "});",
          "",
          "const artifactStore = createMemoryArtifactStore();",
          "const artifactService = createArtifactService({",
          "\tregistry: artifactRegistry,",
          "\tstore: artifactStore",
          "});",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/artifacts",
            names: [
              "createArtifactService",
              "createMemoryArtifactStore",
              "defineArtifactRegistry",
            ],
          },
          { from: "@sinclair/typebox", names: ["Type"] },
        ],
        placement: "module-scope",
      },
      title: "Define artifact kinds and lifecycle",
    },
  ],
});

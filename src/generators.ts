import { ArtifactError } from "./types";
import type {
  ArtifactAssetWriteInput,
  ArtifactBundleCreateInput,
  ArtifactProvenance,
  ArtifactRecord,
} from "./types";

export type ArtifactGenerationInput = {
  createdBy: string;
  input?: Record<string, unknown>;
  kind: string;
  ownerId: string;
  prompt?: string;
  title?: string;
};

export type ArtifactGenerationContext = {
  ownerId: string;
};

export type ArtifactGenerationResult = {
  assets?: ArtifactAssetWriteInput[];
  content: unknown;
  metadata?: Record<string, unknown>;
  provenance?: ArtifactProvenance;
  title?: string;
  warnings?: string[];
};

export type ArtifactGenerator = {
  generate(
    input: ArtifactGenerationInput,
    context: ArtifactGenerationContext,
  ): Promise<ArtifactGenerationResult>;
  kind: string;
  name: string;
};

export type ArtifactBundleCreator = {
  createBundle(
    ownerId: string,
    input: ArtifactBundleCreateInput,
  ): Promise<ArtifactRecord>;
};

export const createArtifactGeneratorRegistry = (
  initial: ArtifactGenerator[] = [],
) => {
  const generators = new Map(
    initial.map((generator) => [generator.kind, generator]),
  );

  return {
    generate: async (
      service: ArtifactBundleCreator,
      input: ArtifactGenerationInput,
    ) => {
      const generator = generators.get(input.kind);
      if (!generator) {
        throw new ArtifactError(
          "generator_unavailable",
          `No generator is registered for ${input.kind} artifacts`,
        );
      }
      const result = await generator.generate(input, {
        ownerId: input.ownerId,
      });
      const artifact = await service.createBundle(input.ownerId, {
        assets: result.assets,
        content: result.content,
        createdBy: input.createdBy,
        kind: input.kind,
        metadata: {
          ...result.metadata,
          ...(result.warnings?.length
            ? { generationWarnings: result.warnings }
            : {}),
        },
        provenance: result.provenance,
        title: result.title ?? input.title ?? `Generated ${input.kind}`,
      });

      return artifact;
    },
    kinds: () => [...generators.keys()],
    register: (generator: ArtifactGenerator) => {
      generators.set(generator.kind, generator);
    },
  };
};

export type ArtifactGeneratorRegistry = ReturnType<
  typeof createArtifactGeneratorRegistry
>;

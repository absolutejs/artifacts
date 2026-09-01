import { ArtifactError } from "./types";
import type {
  ArtifactAssetWriteInput,
  ArtifactBatchCompletionReceipt,
  ArtifactBatchCreateInput,
  ArtifactBatchValidator,
  ArtifactBundleCreateInput,
  ArtifactEvidenceReference,
  ArtifactProvenance,
  ArtifactRecord,
  JsonObject,
  JsonValue,
} from "./types";

export type ArtifactGenerationInput = {
  createdBy: string;
  input?: JsonObject;
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
  content: JsonValue;
  metadata?: JsonObject;
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
  validate?(
    result: ArtifactGenerationResult,
    input: ArtifactGenerationInput,
    context: ArtifactGenerationContext,
  ):
    | ArtifactGenerationValidationIssue[]
    | Promise<ArtifactGenerationValidationIssue[]>;
};

export type ArtifactGenerationValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type ArtifactBundleCreator = {
  createBundle(
    ownerId: string,
    input: ArtifactBundleCreateInput,
  ): Promise<ArtifactRecord>;
};

export type ArtifactBatchGeneratorService = ArtifactBundleCreator & {
  stageBatch(
    ownerId: string,
    input: ArtifactBatchCreateInput,
    options?: { validators?: ArtifactBatchValidator[] },
  ): Promise<{ commit(): Promise<ArtifactBatchCompletionReceipt> }>;
};

export type ArtifactBatchGenerationItem = Omit<
  ArtifactGenerationInput,
  "ownerId"
> & {
  evidence?: ArtifactEvidenceReference[];
  key: string;
};

export type ArtifactBatchGenerationInput = Omit<
  ArtifactBatchCreateInput,
  "items"
> & {
  items: ArtifactBatchGenerationItem[];
  ownerId: string;
  validators?: ArtifactBatchValidator[];
};

export const createArtifactGeneratorRegistry = (
  initial: ArtifactGenerator[] = [],
) => {
  const generators = new Map(
    initial.map((generator) => [generator.kind, generator]),
  );

  const generateResult = async (input: ArtifactGenerationInput) => {
    const generator = generators.get(input.kind);
    if (!generator) {
      throw new ArtifactError(
        "generator_unavailable",
        `No generator is registered for ${input.kind} artifacts`,
      );
    }
    const context = { ownerId: input.ownerId };
    const result = await generator.generate(input, context);
    const issues = (await generator.validate?.(result, input, context)) ?? [];
    if (issues.length > 0) {
      throw new ArtifactError(
        "batch_validation_failed",
        issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      );
    }

    return result;
  };

  const bundleInput = (
    input: ArtifactGenerationInput,
    result: ArtifactGenerationResult,
  ): ArtifactBundleCreateInput => ({
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

  return {
    generate: async (
      service: ArtifactBundleCreator,
      input: ArtifactGenerationInput,
    ) => {
      const result = await generateResult(input);
      const artifact = await service.createBundle(
        input.ownerId,
        bundleInput(input, result),
      );

      return artifact;
    },
    generateBatch: async (
      service: ArtifactBatchGeneratorService,
      input: ArtifactBatchGenerationInput,
    ) => {
      const generated = await Promise.all(
        input.items.map(async (item) => {
          const generationInput: ArtifactGenerationInput = {
            createdBy: item.createdBy,
            input: item.input,
            kind: item.kind,
            ownerId: input.ownerId,
            prompt: item.prompt,
            title: item.title,
          };
          const generator = generators.get(item.kind);
          if (!generator) {
            throw new ArtifactError(
              "generator_unavailable",
              `No generator is registered for ${item.kind} artifacts`,
            );
          }
          const context = { ownerId: input.ownerId };
          const result = await generator.generate(generationInput, context);
          const issues =
            (await generator.validate?.(result, generationInput, context)) ??
            [];

          return {
            artifact: bundleInput(generationInput, result),
            evidence: item.evidence,
            generationIssues: issues,
            key: item.key,
          };
        }),
      );
      const staged = await service.stageBatch(
        input.ownerId,
        {
          bundleId: input.bundleId,
          commitMode: input.commitMode,
          evidence: input.evidence,
          items: generated.map(
            ({ generationIssues: _issues, ...item }) => item,
          ),
          metadata: input.metadata,
          provenance: input.provenance,
        },
        {
          validators: [
            () =>
              generated.flatMap((item) =>
                item.generationIssues.map((generationIssue) => ({
                  ...generationIssue,
                  itemKey: item.key,
                })),
              ),
            ...(input.validators ?? []),
          ],
        },
      );

      return staged.commit();
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

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ArtifactError,
  isJsonValue,
  type ArtifactCapability,
  type JsonValue,
} from "./types";

export type ArtifactAssetPolicy = {
  /** Exact media types or wildcards such as image/* and application/*. */
  acceptedMediaTypes?: string[];
  maxCount?: number;
};

export type ArtifactKindDefinition<TContent extends TSchema = TSchema> = {
  assets?: ArtifactAssetPolicy;
  capabilities?: ArtifactCapability[];
  content: TContent;
  description?: string;
  label: string;
  schemaVersion?: number;
};

export type ArtifactKindDefinitions = Record<
  string,
  ArtifactKindDefinition<TSchema>
>;

export type ArtifactContent<
  TDefinitions extends ArtifactKindDefinitions,
  TKind extends keyof TDefinitions,
> =
  TDefinitions[TKind] extends ArtifactKindDefinition<infer TSchemaValue>
    ? Static<TSchemaValue>
    : never;

export type ArtifactRegistry<TDefinitions extends ArtifactKindDefinitions> = {
  definitions: TDefinitions;
  kindNames: Array<keyof TDefinitions & string>;
  parse<TKind extends keyof TDefinitions & string>(
    kind: TKind,
    content: unknown,
  ): ArtifactContent<TDefinitions, TKind> & JsonValue;
};

export const defineArtifactRegistry = <
  const TDefinitions extends ArtifactKindDefinitions,
>(
  definitions: TDefinitions,
): ArtifactRegistry<TDefinitions> => ({
  definitions,
  kindNames: Object.keys(definitions),
  parse: (kind, content) => {
    const definition = definitions[kind];
    if (!definition) {
      throw new ArtifactError("unknown_kind", `Unknown artifact kind: ${kind}`);
    }
    if (!Value.Check(definition.content, content) || !isJsonValue(content)) {
      const issue = [...Value.Errors(definition.content, content)][0];
      const detail = issue
        ? `${issue.path || "/"}: ${issue.message}`
        : "invalid content";
      throw new ArtifactError(
        "invalid_content",
        `Invalid ${kind} artifact content (${detail})`,
      );
    }

    return content as ArtifactContent<TDefinitions, typeof kind> & JsonValue;
  },
});

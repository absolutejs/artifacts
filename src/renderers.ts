import { ArtifactError, type ArtifactRecord } from "./types";

export type ArtifactRenderResult = {
  body: Uint8Array | string;
  filename?: string;
  mediaType: string;
};

export type ArtifactRenderer = {
  format: string;
  kind: string;
  render(artifact: ArtifactRecord): Promise<ArtifactRenderResult>;
};

export const createArtifactRendererRegistry = (
  initial: ArtifactRenderer[] = [],
) => {
  const key = (kind: string, format: string) => `${kind}:${format}`;
  const renderers = new Map(
    initial.map((renderer) => [key(renderer.kind, renderer.format), renderer]),
  );

  return {
    formatsFor: (kind: string) =>
      [...renderers.values()]
        .filter((renderer) => renderer.kind === kind)
        .map((renderer) => renderer.format),
    register: (renderer: ArtifactRenderer) => {
      renderers.set(key(renderer.kind, renderer.format), renderer);
    },
    render: async (artifact: ArtifactRecord, format: string) => {
      const renderer = renderers.get(key(artifact.kind, format));
      if (!renderer) {
        throw new ArtifactError(
          "renderer_unavailable",
          `No ${format} renderer is registered for ${artifact.kind}`,
        );
      }

      return renderer.render(artifact);
    },
  };
};

export type ArtifactRendererRegistry = ReturnType<
  typeof createArtifactRendererRegistry
>;

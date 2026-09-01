import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import {
  ArtifactError,
  createArtifactGeneratorRegistry,
  createArtifactService,
  createMemoryArtifactAssetStore,
  createMemoryArtifactStore,
  defineArtifactRegistry,
  standardArtifactDefinitions,
  validateGeneratedArtifactFormats,
} from "../src";

const registry = defineArtifactRegistry(standardArtifactDefinitions);
const encoder = new TextEncoder();

describe("artifact generator batches and format validation", () => {
  test("generates and atomically commits multiple outputs with one receipt", async () => {
    const store = createMemoryArtifactStore();
    const service = createArtifactService({
      assetStore: createMemoryArtifactAssetStore(),
      batchIdFactory: () => "generated-bundle",
      registry,
      store,
    });
    const generators = createArtifactGeneratorRegistry([
      {
        generate: async (input) => ({
          assets: [
            {
              data: encoder.encode(String(input.input?.body ?? "")),
              mediaType: "text/markdown",
              name: `${input.kind}.md`,
            },
          ],
          content: { summary: input.title ?? input.kind },
        }),
        kind: "document",
        name: "document-test",
      },
    ]);

    const receipt = await generators.generateBatch(service, {
      items: [
        {
          createdBy: "agent",
          input: { body: "worksheet" },
          key: "worksheet",
          kind: "document",
          title: "Worksheet",
        },
        {
          createdBy: "agent",
          input: { body: "report" },
          key: "report",
          kind: "document",
          title: "Report",
        },
      ],
      ownerId: "owner-1",
    });

    expect(receipt).toMatchObject({
      atomic: true,
      bundleId: "generated-bundle",
      status: "committed",
    });
    expect(await store.list("owner-1")).toHaveLength(2);
  });

  test("rejects malformed CSV before creating an artifact", async () => {
    const store = createMemoryArtifactStore();
    const service = createArtifactService({
      assetStore: createMemoryArtifactAssetStore(),
      registry,
      store,
    });
    const generators = createArtifactGeneratorRegistry([
      {
        generate: async () => ({
          assets: [
            {
              data: encoder.encode("name,email\nAda,ada@example.test,extra"),
              mediaType: "text/csv",
              name: "contacts.csv",
            },
          ],
          content: { summary: "Contacts" },
        }),
        kind: "spreadsheet",
        name: "spreadsheet-test",
        validate: validateGeneratedArtifactFormats,
      },
    ]);

    expect(
      generators.generate(service, {
        createdBy: "agent",
        kind: "spreadsheet",
        ownerId: "owner-1",
      }),
    ).rejects.toBeInstanceOf(ArtifactError);
    expect(await store.list("owner-1")).toHaveLength(0);
  });

  test("returns a rolled-back validation receipt for an invalid generated batch", async () => {
    const store = createMemoryArtifactStore();
    const service = createArtifactService({
      assetStore: createMemoryArtifactAssetStore(),
      registry,
      store,
    });
    const generators = createArtifactGeneratorRegistry([
      {
        generate: async () => ({
          assets: [
            {
              data: encoder.encode(
                "To: person@example.test\nSubject: Missing separator",
              ),
              mediaType: "message/rfc822",
              name: "draft.eml",
            },
          ],
          content: { summary: "Draft" },
        }),
        kind: "email",
        name: "email-test",
        validate: validateGeneratedArtifactFormats,
      },
    ]);

    const receipt = await generators.generateBatch(service, {
      items: [
        {
          createdBy: "agent",
          key: "first-email",
          kind: "email",
          title: "First email",
        },
        {
          createdBy: "agent",
          key: "second-email",
          kind: "email",
          title: "Second email",
        },
      ],
      ownerId: "owner-1",
    });

    expect(receipt.status).toBe("rolled_back");
    expect(receipt.validation).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ itemKey: "first-email" }),
        expect.objectContaining({ itemKey: "second-email" }),
      ]),
      valid: false,
    });
    expect(await store.list("owner-1")).toHaveLength(0);
  });

  test("rejects malformed presentation XML", () => {
    const bytes = zipSync({
      "[Content_Types].xml": encoder.encode("<Types></Types>"),
      "ppt/presentation.xml": encoder.encode(
        "<p:presentation><p:sldIdLst></p:presentation>",
      ),
      "ppt/slides/slide1.xml": encoder.encode("<p:sld><Z></p:sld>"),
    });
    const issues = validateGeneratedArtifactFormats({
      assets: [
        {
          data: bytes,
          mediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          name: "broken.pptx",
        },
      ],
      content: {},
    });

    expect(issues.map((entry) => entry.code)).toContain(
      "presentation_xml_invalid",
    );
  });
});

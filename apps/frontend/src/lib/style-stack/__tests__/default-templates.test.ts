import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { StyleStackConfigSchema } from "../../schemas/style-stack";
import {
  DEFAULT_STYLE_TEMPLATES,
  seedDefaultTemplates,
} from "../default-templates";

describe("DEFAULT_STYLE_TEMPLATES", () => {
  it("should have at least 12 templates", () => {
    expect(DEFAULT_STYLE_TEMPLATES.length).toBeGreaterThanOrEqual(12);
  });

  it("should have all templates marked as public and template", () => {
    for (const template of DEFAULT_STYLE_TEMPLATES) {
      expect(template.is_public).toBe(true);
      expect(template.is_template).toBe(true);
    }
  });

  it("should have unique template names", () => {
    const names = DEFAULT_STYLE_TEMPLATES.map((t) => t.name);
    const uniqueNames = [...new Set(names)];
    expect(uniqueNames.length).toBe(names.length);
  });

  it("should have valid style stack configurations", () => {
    for (const template of DEFAULT_STYLE_TEMPLATES) {
      expect(() => StyleStackConfigSchema.parse(template.config)).not.toThrow(
        `Template "${template.name}" has invalid configuration`,
      );
    }
  });

  it("should have required base properties in all templates", () => {
    for (const template of DEFAULT_STYLE_TEMPLATES) {
      const config = template.config as any;

      expect(config.base).toBeDefined();
      expect(config.base.mood).toBeDefined();
      expect(config.base.lighting).toBeDefined();
      expect(config.base.color_palette).toBeDefined();
      expect(config.base.camera).toBeDefined();
    }
  });

  it("should have categories assigned to all templates", () => {
    for (const template of DEFAULT_STYLE_TEMPLATES) {
      expect(template.category).toBeDefined();
      expect(typeof template.category).toBe("string");
      expect(template.category?.length).toBeGreaterThan(0);
    }
  });

  it("should have tags assigned to all templates", () => {
    for (const template of DEFAULT_STYLE_TEMPLATES) {
      expect(template.tags).toBeDefined();
      expect(Array.isArray(template.tags)).toBe(true);
      expect(template.tags?.length).toBeGreaterThan(0);
    }
  });

  describe("Specific Templates", () => {
    it("should have Cinematic Noir template", () => {
      const noirTemplate = DEFAULT_STYLE_TEMPLATES.find(
        (t) => t.name === "Cinematic Noir",
      );

      expect(noirTemplate).toBeDefined();
      expect(noirTemplate?.category).toBe("cinematic");
      expect(noirTemplate?.tags).toContain("noir");

      const config = noirTemplate?.config as any;
      expect(config.base.mood).toContain("dark");
      expect(config.base.color_palette).toContain("black and white");
    });

    it("should have Vibrant Pop Art template", () => {
      const popArtTemplate = DEFAULT_STYLE_TEMPLATES.find(
        (t) => t.name === "Vibrant Pop Art",
      );

      expect(popArtTemplate).toBeDefined();
      expect(popArtTemplate?.category).toBe("artistic");
      expect(popArtTemplate?.tags).toContain("pop-art");

      const config = popArtTemplate?.config as any;
      expect(config.base.mood).toContain("energetic");
      expect(config.base.color_palette).toContain("neon colors");
    });

    it("should have Documentary Realism template", () => {
      const docTemplate = DEFAULT_STYLE_TEMPLATES.find(
        (t) => t.name === "Documentary Realism",
      );

      expect(docTemplate).toBeDefined();
      expect(docTemplate?.category).toBe("documentary");
      expect(docTemplate?.tags).toContain("realistic");

      const config = docTemplate?.config as any;
      expect(config.base.mood).toContain("authentic");
      expect(config.base.lighting).toContain("natural");
    });

    it("should have Futuristic Sci-Fi template", () => {
      const sciFiTemplate = DEFAULT_STYLE_TEMPLATES.find(
        (t) => t.name === "Futuristic Sci-Fi",
      );

      expect(sciFiTemplate).toBeDefined();
      expect(sciFiTemplate?.category).toBe("sci-fi");
      expect(sciFiTemplate?.tags).toContain("futuristic");

      const config = sciFiTemplate?.config as any;
      expect(config.base.color_palette).toContain("cyan");
      expect(config.base.environment).toContain("futuristic");
    });

    it("should have Fantasy Epic template", () => {
      const fantasyTemplate = DEFAULT_STYLE_TEMPLATES.find(
        (t) => t.name === "Fantasy Epic",
      );

      expect(fantasyTemplate).toBeDefined();
      expect(fantasyTemplate?.category).toBe("fantasy");
      expect(fantasyTemplate?.tags).toContain("epic");

      const config = fantasyTemplate?.config as any;
      expect(config.base.mood).toContain("magical");
      expect(config.base.environment).toContain("fantasy");
    });
  });

  describe("Model Configurations", () => {
    it("should have flux-pro configurations in templates", () => {
      const templatesWithFlux = DEFAULT_STYLE_TEMPLATES.filter(
        (t) => (t.config as any).models?.["flux-pro"],
      );

      expect(templatesWithFlux.length).toBeGreaterThan(0);

      for (const template of templatesWithFlux) {
        const fluxConfig = (template.config as any).models["flux-pro"];
        expect(fluxConfig.additional_prompt).toBeDefined();
        expect(fluxConfig.negative_prompt).toBeDefined();
      }
    });

    it("should have imagen4 configurations in some templates", () => {
      const templatesWithImagen4 = DEFAULT_STYLE_TEMPLATES.filter(
        (t) => (t.config as any).models?.imagen4,
      );

      expect(templatesWithImagen4.length).toBeGreaterThan(0);

      for (const template of templatesWithImagen4) {
        const imagen4Config = (template.config as any).models.imagen4;
        expect(imagen4Config.style_preset).toBeDefined();
      }
    });

    it("should have runway configurations in video-oriented templates", () => {
      const musicVideoTemplate = DEFAULT_STYLE_TEMPLATES.find(
        (t) => t.name === "Music Video Dynamic",
      );

      expect(musicVideoTemplate).toBeDefined();

      const runwayConfig = (musicVideoTemplate?.config as any).models?.runway;
      expect(runwayConfig).toBeDefined();
      expect(runwayConfig.motion_strength).toBeDefined();
      expect(runwayConfig.camera_motion).toBeDefined();
    });
  });
});

describe("seedDefaultTemplates", () => {
  let mockSupabaseClient: any;

  beforeEach(() => {
    mockSupabaseClient = {
      from: mock(() => ({
        select: mock().mockReturnThis(),
        insert: mock().mockReturnThis(),
        eq: mock().mockReturnThis(),
        single: mock(),
      })),
    };
  });

  it("should create system team if it doesn't exist", async () => {
    // Mock team doesn't exist
    const mockTeamQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: null,
            error: { code: "PGRST116" },
          }),
        }),
      }),
    };

    // Mock team creation
    const mockTeamInsert = {
      insert: mock().mockReturnValue({
        select: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: { id: "system-team-123" },
            error: null,
          }),
        }),
      }),
    };

    // Mock existing templates check
    const mockTemplatesQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          eq: mock().mockResolvedValue({
            data: [],
            error: null,
          }),
        }),
      }),
    };

    // Mock template insertion
    const mockTemplatesInsert = {
      insert: mock().mockResolvedValue({
        error: null,
      }),
    };

    mockSupabaseClient.from
      .mockReturnValueOnce(mockTeamQuery) // Check if team exists
      .mockReturnValueOnce(mockTeamInsert) // Create team
      .mockReturnValueOnce(mockTemplatesQuery) // Check existing templates
      .mockReturnValueOnce(mockTemplatesInsert); // Insert templates

    await seedDefaultTemplates(mockSupabaseClient);

    expect(mockTeamInsert.insert).toHaveBeenCalledWith({
      name: "System Templates",
      slug: "system-templates",
    });
    expect(mockTemplatesInsert.insert).toHaveBeenCalled();
  });

  it("should use existing system team", async () => {
    // Mock team exists
    const mockTeamQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: { id: "existing-system-team" },
            error: null,
          }),
        }),
      }),
    };

    // Mock existing templates check
    const mockTemplatesQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          eq: mock().mockResolvedValue({
            data: [],
            error: null,
          }),
        }),
      }),
    };

    // Mock template insertion
    const mockTemplatesInsert = {
      insert: mock().mockResolvedValue({
        error: null,
      }),
    };

    mockSupabaseClient.from
      .mockReturnValueOnce(mockTeamQuery)
      .mockReturnValueOnce(mockTemplatesQuery)
      .mockReturnValueOnce(mockTemplatesInsert);

    await seedDefaultTemplates(mockSupabaseClient);

    expect(mockTemplatesInsert.insert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          team_id: "existing-system-team",
          is_template: true,
          is_public: true,
        }),
      ]),
    );
  });

  it("should skip existing templates", async () => {
    const existingTemplates = [
      { name: "Cinematic Noir" },
      { name: "Vibrant Pop Art" },
    ];

    // Mock team exists
    const mockTeamQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: { id: "system-team-123" },
            error: null,
          }),
        }),
      }),
    };

    // Mock existing templates
    const mockTemplatesQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          eq: mock().mockResolvedValue({
            data: existingTemplates,
            error: null,
          }),
        }),
      }),
    };

    // Mock template insertion
    const mockTemplatesInsert = {
      insert: mock().mockResolvedValue({
        error: null,
      }),
    };

    mockSupabaseClient.from
      .mockReturnValueOnce(mockTeamQuery)
      .mockReturnValueOnce(mockTemplatesQuery)
      .mockReturnValueOnce(mockTemplatesInsert);

    await seedDefaultTemplates(mockSupabaseClient);

    // Should only insert templates that don't already exist
    const insertCall = mockTemplatesInsert.insert.mock.calls[0][0];
    const insertedTemplateNames = insertCall.map((t: any) => t.name);

    expect(insertedTemplateNames).not.toContain("Cinematic Noir");
    expect(insertedTemplateNames).not.toContain("Vibrant Pop Art");
    expect(insertedTemplateNames.length).toBe(
      DEFAULT_STYLE_TEMPLATES.length - existingTemplates.length,
    );
  });

  it("should handle when all templates already exist", async () => {
    const allTemplateNames = DEFAULT_STYLE_TEMPLATES.map((t) => ({
      name: t.name,
    }));

    // Mock team exists
    const mockTeamQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: { id: "system-team-123" },
            error: null,
          }),
        }),
      }),
    };

    // Mock all templates exist
    const mockTemplatesQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          eq: mock().mockResolvedValue({
            data: allTemplateNames,
            error: null,
          }),
        }),
      }),
    };

    mockSupabaseClient.from
      .mockReturnValueOnce(mockTeamQuery)
      .mockReturnValueOnce(mockTemplatesQuery);

    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await seedDefaultTemplates(mockSupabaseClient);

    expect(consoleSpy).toHaveBeenCalledWith(
      "All default templates already exist",
    );
    consoleSpy.mockRestore();
  });

  it("should handle errors during seeding", async () => {
    // Mock team query error
    const mockTeamQuery = {
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: null,
            error: { message: "Database error" },
          }),
        }),
      }),
    };

    mockSupabaseClient.from.mockReturnValueOnce(mockTeamQuery);

    await expect(seedDefaultTemplates(mockSupabaseClient)).rejects.toThrow(
      "Failed to get system team: Database error",
    );
  });
});

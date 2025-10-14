import type { SupabaseClient } from "@supabase/supabase-js";
import type { StyleStackConfig } from "@/lib/schemas/style-stack";
import type { Database, StyleInsert } from "@/types/database";

// Default style templates that can be imported into any team
export const DEFAULT_STYLE_TEMPLATES: Array<
  Omit<
    StyleInsert,
    "id" | "team_id" | "created_at" | "updated_at" | "created_by"
  >
> = [
  {
    name: "Cinematic Noir",
    description:
      "Classic film noir style with high contrast lighting and dramatic shadows",
    category: "cinematic",
    tags: ["noir", "dramatic", "high-contrast", "vintage", "monochrome"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Cinematic Noir",
      base: {
        mood: "dark, mysterious, dramatic",
        lighting: "high contrast, sharp shadows, key lighting from side",
        color_palette: "black and white with selective color accents",
        camera: "low angles, dutch tilts, close-ups for intensity",
        composition:
          "strong diagonal lines, rule of thirds, negative space for drama",
        texture: "film grain, high contrast surfaces",
        environment: "urban nighttime, rain-slicked streets, neon reflections",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "film noir style, 1940s cinema, dramatic lighting, black and white photography",
          negative_prompt:
            "colorful, bright, cheerful, soft lighting, pastel colors",
          guidance_scale: 8.0,
          steps: 25,
        },
        imagen4: {
          style_preset: "cinematic",
          guidance_scale: 7.5,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Vibrant Pop Art",
    description:
      "Bold, colorful pop art aesthetic with high saturation and graphic elements",
    category: "artistic",
    tags: ["pop-art", "vibrant", "colorful", "bold", "graphic", "modern"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Vibrant Pop Art",
      base: {
        mood: "energetic, bold, playful",
        lighting: "even, bright, saturated colors",
        color_palette: "neon colors, high saturation, complementary contrasts",
        camera: "straight angles, centered compositions, graphic framing",
        composition:
          "bold geometric shapes, flat design elements, high contrast",
        texture: "smooth surfaces, graphic patterns, screen printing effects",
        environment: "studio setup, clean backgrounds, graphic elements",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "pop art style, Andy Warhol inspired, vibrant colors, graphic design, screen print aesthetic",
          negative_prompt:
            "muted colors, realistic textures, shadows, film grain",
          guidance_scale: 7.0,
          steps: 20,
        },
        imagen4: {
          style_preset: "artistic",
          guidance_scale: 8.0,
          aspect_ratio: "1:1",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Documentary Realism",
    description: "Natural, authentic documentary-style cinematography",
    category: "documentary",
    tags: ["realistic", "natural", "authentic", "handheld", "candid"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Documentary Realism",
      base: {
        mood: "authentic, observational, natural",
        lighting: "natural light, available light, soft shadows",
        color_palette: "natural color grading, slightly desaturated",
        camera: "handheld feel, natural movements, candid angles",
        composition:
          "organic framing, real-world environments, spontaneous moments",
        texture:
          "natural skin tones, realistic materials, environmental textures",
        environment: "real locations, natural settings, everyday environments",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "documentary photography, photojournalism, natural lighting, candid moments, realistic",
          negative_prompt:
            "stylized, artificial lighting, posed, overly processed, fantasy elements",
          guidance_scale: 6.5,
          steps: 20,
        },
        imagen4: {
          style_preset: "photographic",
          guidance_scale: 6.0,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Futuristic Sci-Fi",
    description:
      "High-tech sci-fi aesthetic with neon lights and futuristic elements",
    category: "sci-fi",
    tags: ["futuristic", "sci-fi", "neon", "cyberpunk", "high-tech"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Futuristic Sci-Fi",
      base: {
        mood: "futuristic, technological, mysterious",
        lighting: "neon lighting, blue/cyan tones, rim lighting",
        color_palette: "cyan, magenta, electric blue, neon accents",
        camera: "wide angles, dramatic perspectives, floating cameras",
        composition: "geometric patterns, leading lines, high-tech interfaces",
        texture: "metallic surfaces, glowing elements, holographic effects",
        environment: "futuristic cities, spaceships, high-tech laboratories",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "cyberpunk, futuristic, neon lighting, sci-fi, high technology, blade runner aesthetic",
          negative_prompt: "natural, organic, vintage, warm colors, rustic",
          guidance_scale: 8.5,
          steps: 30,
        },
        imagen4: {
          style_preset: "futuristic",
          guidance_scale: 8.0,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Vintage Film",
    description: "Classic vintage film look with warm tones and film grain",
    category: "vintage",
    tags: ["vintage", "retro", "film-grain", "warm", "nostalgic"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Vintage Film",
      base: {
        mood: "nostalgic, warm, dreamy",
        lighting: "golden hour, soft diffused light, warm tones",
        color_palette: "sepia tones, warm oranges, muted colors, faded look",
        camera: "classic film ratios, gentle movements, traditional framing",
        composition:
          "classic photography rules, balanced compositions, timeless feel",
        texture: "film grain, slight vignetting, analog imperfections",
        environment:
          "period-appropriate settings, natural locations, timeless scenes",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "vintage film photography, 35mm film, warm tones, film grain, retro aesthetic, golden hour",
          negative_prompt: "digital, sharp, modern, cold tones, high contrast",
          guidance_scale: 7.0,
          steps: 25,
        },
        imagen4: {
          style_preset: "vintage",
          guidance_scale: 7.5,
          aspect_ratio: "4:3",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Minimal Clean",
    description: "Clean, minimal aesthetic with plenty of white space",
    category: "minimal",
    tags: ["minimal", "clean", "white-space", "simple", "modern"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Minimal Clean",
      base: {
        mood: "calm, serene, focused",
        lighting: "soft even lighting, no harsh shadows",
        color_palette: "whites, grays, single accent color, high key",
        camera: "stable shots, centered compositions, clean framing",
        composition: "lots of negative space, simple geometry, uncluttered",
        texture: "smooth surfaces, clean materials, subtle textures",
        environment: "clean backgrounds, studio settings, organized spaces",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "minimal design, clean aesthetic, white background, simple composition, modern minimalism",
          negative_prompt:
            "cluttered, busy, complex patterns, dark colors, multiple elements",
          guidance_scale: 6.0,
          steps: 20,
        },
        imagen4: {
          style_preset: "minimal",
          guidance_scale: 6.5,
          aspect_ratio: "1:1",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Fantasy Epic",
    description:
      "Epic fantasy style with magical elements and dramatic landscapes",
    category: "fantasy",
    tags: ["fantasy", "epic", "magical", "dramatic", "otherworldly"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Fantasy Epic",
      base: {
        mood: "epic, magical, adventurous",
        lighting: "dramatic rim lighting, magical glows, golden hour",
        color_palette:
          "rich jewel tones, magical purples and golds, ethereal blues",
        camera: "sweeping movements, heroic low angles, epic wide shots",
        composition: "grand vistas, leading lines to horizons, rule of thirds",
        texture: "mystical particles, ethereal mists, ancient materials",
        environment: "fantasy landscapes, magical forests, ancient ruins",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "fantasy art, epic landscape, magical elements, dramatic lighting, Lord of the Rings style",
          negative_prompt: "modern, realistic, mundane, urban, contemporary",
          guidance_scale: 9.0,
          steps: 35,
        },
        imagen4: {
          style_preset: "fantasy",
          guidance_scale: 8.5,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Horror Dark",
    description: "Dark, atmospheric horror style with moody lighting",
    category: "horror",
    tags: ["horror", "dark", "moody", "atmospheric", "suspenseful"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Horror Dark",
      base: {
        mood: "ominous, suspenseful, unsettling",
        lighting:
          "harsh shadows, practical light sources, dramatic chiaroscuro",
        color_palette:
          "desaturated colors, sickly greens, blood reds, deep shadows",
        camera: "dutch angles, close-ups, unsettling framing, handheld tension",
        composition:
          "off-center subjects, negative space for unease, claustrophobic framing",
        texture: "gritty surfaces, decay, organic horror elements",
        environment: "abandoned places, fog, darkness, confined spaces",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "horror movie aesthetic, dark atmosphere, dramatic shadows, suspenseful lighting, eerie mood",
          negative_prompt:
            "bright, cheerful, colorful, safe, comfortable, well-lit",
          guidance_scale: 8.0,
          steps: 30,
        },
        imagen4: {
          style_preset: "dark",
          guidance_scale: 8.0,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Commercial Clean",
    description: "Professional commercial advertising style",
    category: "commercial",
    tags: ["commercial", "professional", "clean", "advertising", "product"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Commercial Clean",
      base: {
        mood: "professional, appealing, trustworthy",
        lighting:
          "perfect studio lighting, no harsh shadows, even illumination",
        color_palette:
          "brand-appropriate colors, high saturation, appealing tones",
        camera: "stable, professional angles, product-focused framing",
        composition: "centered products, rule of thirds, clean backgrounds",
        texture: "pristine surfaces, perfect materials, polished appearance",
        environment: "studio backgrounds, clean settings, professional setups",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "commercial photography, advertising style, studio lighting, professional quality, product shot",
          negative_prompt:
            "amateur, poor lighting, cluttered, unprofessional, grainy",
          guidance_scale: 7.0,
          steps: 25,
        },
        imagen4: {
          style_preset: "commercial",
          guidance_scale: 7.5,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Music Video Dynamic",
    description:
      "High-energy music video style with dynamic movement and effects",
    category: "music_video",
    tags: ["music-video", "dynamic", "energetic", "effects", "rhythmic"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Music Video Dynamic",
      base: {
        mood: "energetic, rhythmic, expressive",
        lighting: "dynamic colored lighting, strobes, stage lighting effects",
        color_palette: "bold contrasting colors, neon accents, dramatic shifts",
        camera: "dynamic movements, rhythm-based cuts, creative angles",
        composition:
          "rule-breaking framing, creative transitions, visual rhythm",
        texture: "high contrast, motion blur, light trails, particle effects",
        environment:
          "performance spaces, creative backdrops, dynamic environments",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "music video aesthetic, dynamic lighting, performance style, creative visuals, high energy",
          negative_prompt: "static, boring, conventional, muted, low energy",
          guidance_scale: 8.0,
          steps: 25,
        },
        runway: {
          motion_strength: 8,
          camera_motion: "zoom_in",
          duration: 4,
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Animation Stylized",
    description:
      "Stylized animation look with exaggerated features and vibrant colors",
    category: "animation",
    tags: ["animation", "stylized", "cartoon", "colorful", "exaggerated"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Animation Stylized",
      base: {
        mood: "playful, expressive, imaginative",
        lighting: "bright, even lighting with rim lighting for depth",
        color_palette: "saturated colors, appealing color schemes, contrast",
        camera: "animation-friendly angles, character-focused framing",
        composition:
          "strong silhouettes, clear character poses, visual hierarchy",
        texture: "cell-shaded appearance, clean lines, stylized materials",
        environment:
          "imaginative worlds, stylized backgrounds, creative settings",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "3D animation style, Pixar-like rendering, cell shading, cartoon aesthetic, colorful",
          negative_prompt:
            "realistic, photographic, gritty, muted colors, harsh shadows",
          guidance_scale: 7.5,
          steps: 25,
        },
        imagen4: {
          style_preset: "cartoon",
          guidance_scale: 7.0,
          aspect_ratio: "16:9",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },

  {
    name: "Golden Hour Portrait",
    description: "Warm, flattering portrait style with golden hour lighting",
    category: "cinematic",
    tags: ["portrait", "golden-hour", "warm", "flattering", "natural"],
    is_public: true,
    is_template: true,
    config: {
      version: "1.0",
      name: "Golden Hour Portrait",
      base: {
        mood: "warm, intimate, flattering",
        lighting: "golden hour backlighting, rim lighting, soft fill",
        color_palette: "warm golds, soft oranges, natural skin tones",
        camera:
          "portrait lenses, shallow depth of field, close to medium shots",
        composition: "subject-focused, rule of thirds, natural poses",
        texture: "soft skin tones, natural textures, gentle highlights",
        environment: "outdoor natural settings, sunset/sunrise timing",
      },
      models: {
        "flux-pro": {
          additional_prompt:
            "portrait photography, golden hour lighting, warm tones, professional headshot, natural beauty",
          negative_prompt:
            "harsh lighting, cold tones, unflattering angles, artificial",
          guidance_scale: 7.0,
          steps: 25,
        },
        imagen4: {
          style_preset: "portrait",
          guidance_scale: 6.5,
          aspect_ratio: "3:4",
        },
      },
    } as StyleStackConfig,
    usage_count: 0,
    preview_url: null,
  },
];

/**
 * Service function to seed default templates into the database
 * This should be run during app initialization or migration
 */
export async function seedDefaultTemplates(
  supabaseClient: SupabaseClient<Database>,
): Promise<void> {
  try {
    // Create a system team for templates if it doesn't exist
    const systemTeamSlug = "system-templates";

    let { data: systemTeam, error: teamError } = await supabaseClient
      .from("teams")
      .select("id")
      .eq("slug", systemTeamSlug)
      .single();

    if (teamError && teamError.code === "PGRST116") {
      // Team doesn't exist, create it
      const { data: newTeam, error: createTeamError } = await supabaseClient
        .from("teams")
        .insert({
          name: "System Templates",
          slug: systemTeamSlug,
        })
        .select()
        .single();

      if (createTeamError) {
        throw new Error(
          `Failed to create system team: ${createTeamError.message}`,
        );
      }

      systemTeam = newTeam;
    } else if (teamError) {
      throw new Error(`Failed to get system team: ${teamError.message}`);
    }

    if (!systemTeam) {
      throw new Error("System team is required but not found");
    }

    // Check which templates already exist
    const { data: existingTemplates, error: existingError } =
      await supabaseClient
        .from("styles")
        .select("name")
        .eq("team_id", systemTeam.id)
        .eq("is_template", true);

    if (existingError) {
      throw new Error(
        `Failed to check existing templates: ${existingError.message}`,
      );
    }

    const existingNames = new Set(existingTemplates?.map((t) => t.name) || []);

    // Filter out templates that already exist
    const templatesToInsert = DEFAULT_STYLE_TEMPLATES.filter(
      (template) => !existingNames.has(template.name),
    ).map((template) => ({
      ...template,
      team_id: systemTeam.id,
    }));

    if (templatesToInsert.length === 0) {
      console.log("All default templates already exist");
      return;
    }

    // Insert new templates
    const { error: insertError } = await supabaseClient
      .from("styles")
      .insert(templatesToInsert);

    if (insertError) {
      throw new Error(`Failed to insert templates: ${insertError.message}`);
    }

    console.log(
      `Successfully seeded ${templatesToInsert.length} default style templates`,
    );
  } catch (error) {
    console.error("Failed to seed default templates:", error);
    throw error;
  }
}

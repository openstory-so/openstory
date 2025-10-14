import type { Style } from "@/types/database";

/**
 * Predefined style presets for Storybook demonstrations
 * These represent different visual styles commonly used in video generation
 * All images are from Unsplash and verified to be working
 */
// Helper function to create complete Style objects
const createStylePreset = (baseStyle: Partial<Style>): Style =>
  ({
    category: null,
    description: null,
    is_template: null,
    parent_id: null,
    tags: null,
    usage_count: null,
    version: null,
    ...baseStyle,
  }) as Style;

export const stylePresets: Style[] = [
  createStylePreset({
    id: "style-cinematic",
    name: "Cinematic Epic",
    preview_url:
      "https://picsum.photos/seed/1536440136628-849c177e76a1/400/300",
    config: {
      colorPalette: ["#1a1a2e", "#16213e", "#0f3460", "#e94560", "#ff6b6b"],
      artStyle: "Cinematic",
      lighting: "Dramatic",
      composition: "Wide Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-anime",
    name: "Anime Adventure",
    preview_url:
      "https://picsum.photos/seed/1578321272176-b7bbc0679853/400/300",
    config: {
      colorPalette: ["#ffb6c1", "#ffc0cb", "#ff69b4", "#ff1493", "#c71585"],
      artStyle: "Anime",
      lighting: "Soft",
      composition: "Medium Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-noir",
    name: "Film Noir",
    preview_url:
      "https://picsum.photos/seed/1518005020951-eccb494ad742/400/300",
    config: {
      colorPalette: ["#000000", "#2b2b2b", "#4a4a4a", "#707070", "#ffffff"],
      artStyle: "Film Noir",
      lighting: "High Contrast",
      composition: "Low Angle",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-cyberpunk",
    name: "Cyberpunk Neon",
    preview_url: "https://picsum.photos/seed/1549490349-8643362247b5/400/300",
    config: {
      colorPalette: ["#00ffff", "#ff00ff", "#ffff00", "#0080ff", "#ff0080"],
      artStyle: "Cyberpunk",
      lighting: "Neon",
      composition: "Dutch Angle",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-watercolor",
    name: "Watercolor Dreams",
    preview_url: "https://picsum.photos/seed/1557672172-298e090bd0f1/400/300",
    config: {
      colorPalette: ["#a8dadc", "#457b9d", "#1d3557", "#f1faee", "#e63946"],
      artStyle: "Watercolor",
      lighting: "Natural",
      composition: "Wide Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-retro",
    name: "Retro 80s",
    preview_url: "https://picsum.photos/seed/1557682250-33bd709cbe85/400/300",
    config: {
      colorPalette: ["#ff6b9d", "#c44569", "#f8961e", "#f9844a", "#ee6c4d"],
      artStyle: "Retro",
      lighting: "Soft",
      composition: "Medium Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-minimalist",
    name: "Minimalist Clean",
    preview_url:
      "https://picsum.photos/seed/1567095761054-7a02e69e5c43/400/300",
    config: {
      colorPalette: ["#ffffff", "#f5f5f5", "#e0e0e0", "#424242", "#000000"],
      artStyle: "Minimalist",
      lighting: "Natural",
      composition: "Wide Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-fantasy",
    name: "Fantasy Epic",
    preview_url:
      "https://picsum.photos/seed/1618005198919-d3d4b5a92ead/400/300",
    config: {
      colorPalette: ["#6b5b95", "#88b0d3", "#82b74b", "#feb236", "#d64161"],
      artStyle: "Fantasy",
      lighting: "Golden Hour",
      composition: "Bird's Eye",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-documentary",
    name: "Documentary Real",
    preview_url:
      "https://picsum.photos/seed/1524985069026-dd778a71c7b4/400/300",
    config: {
      colorPalette: ["#8d5524", "#c68642", "#e0ac69", "#f1c27d", "#ffdbac"],
      artStyle: "Photorealistic",
      lighting: "Natural",
      composition: "Medium Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-comic",
    name: "Comic Book",
    preview_url:
      "https://picsum.photos/seed/1579783902614-a3fb3927b6a5/400/300",
    config: {
      colorPalette: ["#ff0000", "#0000ff", "#ffff00", "#00ff00", "#000000"],
      artStyle: "Comic",
      lighting: "High Contrast",
      composition: "Close-up",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-oil-painting",
    name: "Oil Painting",
    preview_url:
      "https://picsum.photos/seed/1579783928621-7a13d66a62d1/400/300",
    config: {
      colorPalette: ["#8b4513", "#cd853f", "#daa520", "#ffd700", "#fffacd"],
      artStyle: "Oil Painting",
      lighting: "Soft",
      composition: "Medium Shot",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
  createStylePreset({
    id: "style-horror",
    name: "Horror Dark",
    preview_url:
      "https://picsum.photos/seed/1566041510394-cf7c8fe21800/400/300",
    config: {
      colorPalette: ["#1a0000", "#330000", "#660000", "#990000", "#cc0000"],
      artStyle: "Dark",
      lighting: "Dramatic",
      composition: "Low Angle",
    },
    team_id: "team-1",
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  }),
];

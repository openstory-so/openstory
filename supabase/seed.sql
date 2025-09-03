-- Seed data for development
-- This file contains initial data for testing and development

-- First, check if system team exists and create if not
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM teams WHERE id = '00000000-0000-0000-0000-000000000000') THEN
    INSERT INTO teams (id, name, slug) VALUES 
      ('00000000-0000-0000-0000-000000000000', 'System Templates', 'system-templates');
  END IF;
END $$;

-- Clear existing template styles and insert fresh ones
DELETE FROM styles WHERE team_id = '00000000-0000-0000-0000-000000000000';

-- Insert template film styles
INSERT INTO styles (team_id, name, description, category, tags, config, is_public, is_template, preview_url) VALUES 
  (
    '00000000-0000-0000-0000-000000000000',
    'Cinematic Drama',
    'Deep, emotional storytelling with rich cinematography. Perfect for character-driven narratives.',
    'cinematic',
    ARRAY['drama', 'emotional', 'character-driven', 'cinematic'],
    jsonb_build_object(
      'artStyle', 'Cinematic drama with deep shadows and warm tones',
      'colorPalette', ARRAY['#8B4513', '#D2691E', '#F4A460', '#2F4F4F', '#708090'],
      'lighting', 'Dramatic chiaroscuro lighting with strong contrast',
      'cameraWork', 'Slow, deliberate movements with meaningful close-ups',
      'mood', 'Introspective and emotional',
      'referenceFilms', ARRAY['The Godfather', 'There Will Be Blood', 'Moonlight'],
      'aspectRatio', '2.35:1',
      'frameRate', '24fps',
      'colorGrading', 'Warm highlights with cool shadows'
    ),
    true,
    true,
    'https://picsum.photos/seed/cinematic-drama/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Neo-Noir Thriller',
    'Dark, stylized visuals with high contrast and urban settings. Ideal for mystery and crime stories.',
    'noir',
    ARRAY['noir', 'thriller', 'urban', 'mystery', 'crime'],
    jsonb_build_object(
      'artStyle', 'Neo-noir with stark contrasts and neon accents',
      'colorPalette', ARRAY['#000000', '#FF0000', '#00CED1', '#4B0082', '#FF1493'],
      'lighting', 'High contrast with venetian blind shadows and neon highlights',
      'cameraWork', 'Dutch angles and voyeuristic framing',
      'mood', 'Tense and mysterious',
      'referenceFilms', ARRAY['Blade Runner', 'Sin City', 'Drive'],
      'aspectRatio', '2.39:1',
      'frameRate', '24fps',
      'colorGrading', 'Desaturated with selective color pops'
    ),
    true,
    true,
    'https://picsum.photos/seed/neo-noir/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Wes Anderson Style',
    'Symmetrical compositions with pastel colors and whimsical aesthetics.',
    'artistic',
    ARRAY['whimsical', 'symmetrical', 'pastel', 'quirky', 'artistic'],
    jsonb_build_object(
      'artStyle', 'Perfectly symmetrical compositions with pastel palette',
      'colorPalette', ARRAY['#FFB6C1', '#87CEEB', '#F0E68C', '#DDA0DD', '#98FB98'],
      'lighting', 'Soft, even lighting with minimal shadows',
      'cameraWork', 'Centered framing, tracking shots, and planimetric composition',
      'mood', 'Whimsical and nostalgic',
      'referenceFilms', ARRAY['Grand Budapest Hotel', 'Moonrise Kingdom', 'The Royal Tenenbaums'],
      'aspectRatio', '2.35:1',
      'frameRate', '24fps',
      'colorGrading', 'Saturated pastels with vintage feel'
    ),
    true,
    true,
    'https://picsum.photos/seed/wes-anderson/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Documentary Realism',
    'Natural, observational style with authentic lighting and handheld movement.',
    'documentary',
    ARRAY['documentary', 'realistic', 'natural', 'authentic', 'observational'],
    jsonb_build_object(
      'artStyle', 'Natural documentary style with authentic environments',
      'colorPalette', ARRAY['#8B7355', '#CD853F', '#DEB887', '#F5DEB3', '#FFE4B5'],
      'lighting', 'Natural and available light only',
      'cameraWork', 'Handheld camera with observational framing',
      'mood', 'Authentic and immediate',
      'referenceFilms', ARRAY['Free Solo', 'The Act of Killing', 'Citizenfour'],
      'aspectRatio', '16:9',
      'frameRate', '30fps',
      'colorGrading', 'Natural color with slight desaturation'
    ),
    true,
    true,
    'https://picsum.photos/seed/documentary/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Sci-Fi Futuristic',
    'Clean, high-tech aesthetics with cool tones and sleek designs.',
    'scifi',
    ARRAY['scifi', 'futuristic', 'technology', 'space', 'cyberpunk'],
    jsonb_build_object(
      'artStyle', 'Futuristic sci-fi with clean lines and holographic elements',
      'colorPalette', ARRAY['#00FFFF', '#0000FF', '#C0C0C0', '#800080', '#00FF00'],
      'lighting', 'Cool LED lighting with lens flares',
      'cameraWork', 'Smooth camera movements with wide establishing shots',
      'mood', 'Futuristic and technological',
      'referenceFilms', ARRAY['Ex Machina', 'Arrival', 'Interstellar'],
      'aspectRatio', '2.39:1',
      'frameRate', '24fps',
      'colorGrading', 'Cool blues and teals with high contrast'
    ),
    true,
    true,
    'https://picsum.photos/seed/scifi/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Horror Gothic',
    'Dark, atmospheric visuals with Gothic elements and unsettling compositions.',
    'horror',
    ARRAY['horror', 'gothic', 'dark', 'atmospheric', 'supernatural'],
    jsonb_build_object(
      'artStyle', 'Gothic horror with dark shadows and eerie atmosphere',
      'colorPalette', ARRAY['#1C1C1C', '#8B0000', '#483D8B', '#2F4F4F', '#696969'],
      'lighting', 'Low-key lighting with harsh shadows',
      'cameraWork', 'Unsettling angles and slow zooms',
      'mood', 'Ominous and foreboding',
      'referenceFilms', ARRAY['The Witch', 'Hereditary', 'The Lighthouse'],
      'aspectRatio', '1.85:1',
      'frameRate', '24fps',
      'colorGrading', 'Desaturated with crushed blacks'
    ),
    true,
    true,
    'https://picsum.photos/seed/horror-gothic/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Action Blockbuster',
    'High-energy visuals with dynamic camera work and explosive color palette.',
    'action',
    ARRAY['action', 'blockbuster', 'explosive', 'dynamic', 'adventure'],
    jsonb_build_object(
      'artStyle', 'High-octane action with dynamic compositions',
      'colorPalette', ARRAY['#FF4500', '#FFD700', '#1E90FF', '#FF6347', '#FFA500'],
      'lighting', 'High contrast with dramatic rim lighting',
      'cameraWork', 'Fast cuts, sweeping crane shots, and dynamic angles',
      'mood', 'Exciting and adrenaline-pumping',
      'referenceFilms', ARRAY['Mad Max: Fury Road', 'John Wick', 'Mission Impossible'],
      'aspectRatio', '2.39:1',
      'frameRate', '24fps',
      'colorGrading', 'Saturated colors with orange and teal contrast'
    ),
    true,
    true,
    'https://picsum.photos/seed/action/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Romantic Comedy',
    'Bright, warm visuals with soft lighting and cheerful compositions.',
    'romance',
    ARRAY['romance', 'comedy', 'lighthearted', 'warm', 'feelgood'],
    jsonb_build_object(
      'artStyle', 'Warm and inviting with soft, romantic lighting',
      'colorPalette', ARRAY['#FFC0CB', '#FFDAB9', '#FFE4E1', '#F0FFFF', '#FFFACD'],
      'lighting', 'Soft, diffused lighting with warm tones',
      'cameraWork', 'Smooth movements with intimate framing',
      'mood', 'Light, romantic, and optimistic',
      'referenceFilms', ARRAY['La La Land', 'Amelie', 'When Harry Met Sally'],
      'aspectRatio', '1.85:1',
      'frameRate', '24fps',
      'colorGrading', 'Warm and saturated with soft contrast'
    ),
    true,
    true,
    'https://picsum.photos/seed/romantic/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Western Epic',
    'Wide vistas with dusty, golden hour lighting and classic Western aesthetics.',
    'western',
    ARRAY['western', 'epic', 'frontier', 'classic', 'americana'],
    jsonb_build_object(
      'artStyle', 'Classic Western with wide landscapes and golden hour lighting',
      'colorPalette', ARRAY['#D2691E', '#8B4513', '#DEB887', '#CD853F', '#F4A460'],
      'lighting', 'Magic hour lighting with long shadows',
      'cameraWork', 'Wide shots, slow zooms, and classic Western framing',
      'mood', 'Epic and frontier-inspired',
      'referenceFilms', ARRAY['The Good, The Bad and The Ugly', 'Once Upon a Time in the West', 'The Searchers'],
      'aspectRatio', '2.66:1',
      'frameRate', '24fps',
      'colorGrading', 'Warm, dusty tones with high contrast'
    ),
    true,
    true,
    'https://picsum.photos/seed/western/400/300'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'Animation Studio',
    'Vibrant, stylized visuals reminiscent of high-quality animation productions.',
    'animation',
    ARRAY['animation', 'cartoon', 'vibrant', 'stylized', 'family'],
    jsonb_build_object(
      'artStyle', 'High-quality animation style with vibrant colors',
      'colorPalette', ARRAY['#FF69B4', '#00CED1', '#FFD700', '#98FB98', '#DDA0DD'],
      'lighting', 'Bright, even lighting with soft shadows',
      'cameraWork', 'Dynamic camera movements with exaggerated perspectives',
      'mood', 'Playful and imaginative',
      'referenceFilms', ARRAY['Spider-Verse', 'Coco', 'How to Train Your Dragon'],
      'aspectRatio', '1.85:1',
      'frameRate', '24fps',
      'colorGrading', 'Hyper-saturated with vibrant colors'
    ),
    true,
    true,
    'https://picsum.photos/seed/animation/400/300'
  );
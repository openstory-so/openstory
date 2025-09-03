-- Add style_id column to sequences table
-- This allows sequences to reference a specific style from the styles library

ALTER TABLE sequences 
ADD COLUMN style_id UUID REFERENCES styles(id) ON DELETE SET NULL;

-- Create index for better query performance
CREATE INDEX idx_sequences_style_id ON sequences(style_id);

-- Update existing sequences to set style_id from metadata if it exists
-- This is for any sequences that might have stored style_id in metadata
UPDATE sequences 
SET style_id = (metadata->>'style_id')::UUID
WHERE metadata->>'style_id' IS NOT NULL
  AND metadata->>'style_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
-- Remove email column from users table as it duplicates auth.users data
-- Update trigger to generate team names without requiring email

-- First, drop the existing trigger
DROP TRIGGER IF EXISTS create_team_on_user_signup ON users;

-- Update the function to not depend on email
CREATE OR REPLACE FUNCTION create_default_team_for_user()
RETURNS TRIGGER AS $$
DECLARE
    new_team_id UUID;
    team_slug VARCHAR(255);
    team_name VARCHAR(255);
BEGIN
    -- Generate a unique slug based on user ID (not email)
    team_slug := 'team-' || SUBSTR(NEW.id::TEXT, 1, 8) || '-' || SUBSTR(MD5(RANDOM()::TEXT), 1, 6);
    
    -- Generate team name - will be updated when user adds their details
    team_name := COALESCE(NEW.full_name, 'My Team');
    
    -- Create a new team
    INSERT INTO teams (name, slug)
    VALUES (team_name, team_slug)
    RETURNING id INTO new_team_id;
    
    -- Add the user as owner of the team
    INSERT INTO team_members (team_id, user_id, role)
    VALUES (new_team_id, NEW.id, 'owner');
    
    -- Initialize user credits
    INSERT INTO credits (user_id, balance)
    VALUES (NEW.id, 10.00); -- Start with $10 free credits
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger
CREATE TRIGGER create_team_on_user_signup
    AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION create_default_team_for_user();

-- Now drop the email column since it's no longer needed
ALTER TABLE users DROP COLUMN email;

-- Add a comment explaining the design
COMMENT ON TABLE users IS 'Profile data for users. Email is stored in auth.users and should be accessed from there. This table only stores additional profile information.';
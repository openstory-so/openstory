import { NextResponse } from "next/server";
import { createSessionAwareClient } from "@/lib/supabase/server";
import type { UserProfile } from "@/types/database";

export async function GET() {
  try {
    const supabase = await createSessionAwareClient();

    // Get the authenticated user (verifies with Supabase Auth server)
    const {
      data: { user },
      error: sessionError,
    } = await supabase.auth.getUser();

    // Handle refresh token errors
    if (sessionError) {
      // Check if this is a refresh token error
      if (
        sessionError.message?.includes("refresh_token_not_found") ||
        sessionError.message?.includes("Invalid Refresh Token") ||
        sessionError.code === "refresh_token_not_found"
      ) {
        // Create a new anonymous session
        const { data, error: anonError } =
          await supabase.auth.signInAnonymously();

        if (anonError) {
          return NextResponse.json(
            {
              success: false,
              error: "Failed to create anonymous session",
            },
            { status: 500 },
          );
        }

        if (!data.user) {
          return NextResponse.json(
            {
              success: false,
              error: "No user returned from anonymous sign-in",
            },
            { status: 500 },
          );
        }

        // Create a team for this anonymous user
        const teamSlug = `user-${data.user.id.substring(0, 8)}-${Date.now()}`;
        const { data: team, error: teamError } = await supabase
          .from("teams")
          .insert({
            name: "My Team",
            slug: teamSlug,
          })
          .select()
          .single();

        if (teamError) {
          return NextResponse.json(
            {
              success: false,
              error: `Failed to create team: ${teamError.message}`,
            },
            { status: 500 },
          );
        }

        // Create user record
        const { error: userError } = await supabase.from("users").insert({
          id: data.user.id,
        });

        if (userError && userError.code !== "23505") {
          // Ignore duplicate key errors
          await supabase.from("teams").delete().eq("id", team.id);
          return NextResponse.json(
            {
              success: false,
              error: `Failed to create user record: ${userError.message}`,
            },
            { status: 500 },
          );
        }

        // Add anonymous user as owner of their team
        const { error: memberError } = await supabase
          .from("team_members")
          .insert({
            user_id: data.user.id,
            team_id: team.id,
            role: "owner",
          });

        if (memberError && memberError.code !== "23505") {
          // Ignore duplicate key errors
          await supabase.from("teams").delete().eq("id", team.id);
          await supabase.from("users").delete().eq("id", data.user.id);
          return NextResponse.json(
            {
              success: false,
              error: `Failed to create team membership: ${memberError.message}`,
            },
            { status: 500 },
          );
        }

        // Return the new anonymous user
        const userProfile: UserProfile = {
          ...data.user,
          full_name: null,
          avatar_url: null,
          onboarding_completed: false,
        };

        return NextResponse.json({
          success: true,
          data: {
            user: userProfile,
            isAuthenticated: false,
            isAnonymous: true,
          },
        });
      }

      // For other session errors, return a generic error
      return NextResponse.json(
        {
          success: false,
          error: sessionError.message || "Failed to get session",
        },
        { status: 500 },
      );
    }

    // If no authenticated user exists, create an anonymous user
    if (!user) {
      const { data, error: anonError } =
        await supabase.auth.signInAnonymously();

      if (anonError) {
        return NextResponse.json(
          {
            success: false,
            error: "Failed to create anonymous session",
          },
          { status: 500 },
        );
      }

      if (!data.user) {
        return NextResponse.json(
          {
            success: false,
            error: "No user returned from anonymous sign-in",
          },
          { status: 500 },
        );
      }

      // Create a team for this anonymous user
      const teamSlug = `user-${data.user.id.substring(0, 8)}-${Date.now()}`;
      const { data: team, error: teamError } = await supabase
        .from("teams")
        .insert({
          name: "My Team",
          slug: teamSlug,
        })
        .select()
        .single();

      if (teamError) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create team: ${teamError.message}`,
          },
          { status: 500 },
        );
      }

      // Create user record
      const { error: userError } = await supabase.from("users").insert({
        id: data.user.id,
      });

      if (userError && userError.code !== "23505") {
        // Ignore duplicate key errors
        await supabase.from("teams").delete().eq("id", team.id);
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create user record: ${userError.message}`,
          },
          { status: 500 },
        );
      }

      // Add anonymous user as owner of their team
      const { error: memberError } = await supabase
        .from("team_members")
        .insert({
          user_id: data.user.id,
          team_id: team.id,
          role: "owner",
        });

      if (memberError && memberError.code !== "23505") {
        // Ignore duplicate key errors
        await supabase.from("teams").delete().eq("id", team.id);
        await supabase.from("users").delete().eq("id", data.user.id);
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create team membership: ${memberError.message}`,
          },
          { status: 500 },
        );
      }

      // Return the new anonymous user
      const userProfile: UserProfile = {
        ...data.user,
        full_name: null,
        avatar_url: null,
        onboarding_completed: false,
      };

      return NextResponse.json({
        success: true,
        data: {
          user: userProfile,
          isAuthenticated: false,
          isAnonymous: true,
        },
      });
    }

    // We have a valid authenticated user
    // First, ensure they have a team
    const { data: teamMembership } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", user.id)
      .eq("role", "owner")
      .single();

    if (!teamMembership) {
      // User exists but has no team - create one for them
      const teamSlug = `user-${user.id.substring(0, 8)}-${Date.now()}`;
      const { data: team, error: teamError } = await supabase
        .from("teams")
        .insert({
          name: "My Team",
          slug: teamSlug,
        })
        .select()
        .single();

      if (teamError) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create team for existing user: ${teamError.message}`,
          },
          { status: 500 },
        );
      }

      // Ensure user record exists in users table
      const { error: userInsertError } = await supabase.from("users").insert({
        id: user.id,
      });

      // Ignore duplicate key errors (user already exists)
      if (userInsertError && userInsertError.code !== "23505") {
        await supabase.from("teams").delete().eq("id", team.id);
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create user record: ${userInsertError.message}`,
          },
          { status: 500 },
        );
      }

      // Add user as team owner
      const { error: memberError } = await supabase
        .from("team_members")
        .insert({
          user_id: user.id,
          team_id: team.id,
          role: "owner",
        });

      if (memberError) {
        // Clean up team if membership creation fails
        await supabase.from("teams").delete().eq("id", team.id);
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create team membership: ${memberError.message}`,
          },
          { status: 500 },
        );
      }
    }

    const userProfile: UserProfile = {
      ...user,
      full_name: user.user_metadata?.full_name || null,
      avatar_url: user.user_metadata?.avatar_url || null,
      onboarding_completed: user.user_metadata?.onboarding_completed || false,
    };

    const isAnonymous = user.is_anonymous === true;

    return NextResponse.json({
      success: true,
      data: {
        user: userProfile,
        isAuthenticated: !isAnonymous,
        isAnonymous,
      },
    });
  } catch (error) {
    console.error("Error in user API:", error);

    // Handle any auth errors specifically
    if (error instanceof Error) {
      if (
        error.message?.includes("refresh_token_not_found") ||
        error.message?.includes("Invalid Refresh Token")
      ) {
        // Try to create a new anonymous session
        try {
          const supabase = await createSessionAwareClient();
          const { data, error: anonError } =
            await supabase.auth.signInAnonymously();

          if (!anonError && data.user) {
            // Create a team for this anonymous user
            const teamSlug = `user-${data.user.id.substring(0, 8)}-${Date.now()}`;
            const { data: team } = await supabase
              .from("teams")
              .insert({
                name: "My Team",
                slug: teamSlug,
              })
              .select()
              .single();

            if (team) {
              // Create user record and team membership
              await supabase.from("users").insert({ id: data.user.id });
              await supabase.from("team_members").insert({
                user_id: data.user.id,
                team_id: team.id,
                role: "owner",
              });

              const userProfile: UserProfile = {
                ...data.user,
                full_name: null,
                avatar_url: null,
                onboarding_completed: false,
              };

              return NextResponse.json({
                success: true,
                data: {
                  user: userProfile,
                  isAuthenticated: false,
                  isAnonymous: true,
                },
              });
            }
          }
        } catch {
          // Fall through to generic error
        }
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: "Failed to get user data",
      },
      { status: 500 },
    );
  }
}

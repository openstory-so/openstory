import { createClient } from "@supabase/supabase-js";
import type { Database } from "./gen.types";

interface BrowserEnvironmentVariables {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}

const validateBrowserEnvironmentVariables = (): BrowserEnvironmentVariables => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missingVars: string[] = [];

  if (!supabaseUrl) {
    missingVars.push("NEXT_PUBLIC_SUPABASE_URL");
  }

  if (!supabaseAnonKey) {
    missingVars.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}. ` +
        `Please check your .env file and ensure all Supabase variables are set.`,
    );
  }

  return {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl as string,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey as string,
  };
};

export const createBrowserClient = () => {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } =
    validateBrowserEnvironmentVariables();

  const client = createClient<Database>(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );

  // Handle auth state changes including refresh token errors
  client.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED" && !session) {
      // Token refresh failed, clear invalid tokens
      if (typeof window !== "undefined") {
        localStorage.removeItem("supabase.auth.token");
        sessionStorage.removeItem("supabase.auth.token");
      }
    }
  });

  return client;
};

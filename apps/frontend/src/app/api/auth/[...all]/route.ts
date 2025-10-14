/**
 * BetterAuth API route handler
 * Handles all authentication requests at /api/auth/*
 */

import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/config";

export const { GET, POST } = toNextJsHandler(auth);

import "@testing-library/jest-dom";
import { afterEach, mock } from "bun:test";
import type { ImageProps } from "next/image";
import React from "react";

// Make React available globally for component tests
globalThis.React = React;

// Mock environment variables for testing
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

// Mock Next.js Image component
mock.module("next/image", () => ({
  default: (props: ImageProps) => {
    // eslint-disable-next-line @next/next/no-img-element
    return React.createElement("img", {
      ...props,
      src:
        typeof props.src === "string"
          ? props.src
          : "default" in props.src
            ? props.src.default.src
            : props.src,
      loading: props.priority ? undefined : "lazy",
    });
  },
}));

// Reset mocks after each test
afterEach(() => {
  mock.restore();
});

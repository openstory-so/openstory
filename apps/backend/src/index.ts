import { cors } from "@elysiajs/cors";
import { fromTypes, openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
// Plugins
import { errorPlugin } from "@/plugins/error";
import { loggingPlugin } from "@/plugins/logging";
import { aiRoutes } from "@/routes/ai";
// Routes
import { authRoutes } from "@/routes/auth";
import { frameRoutes } from "@/routes/frames";
import { jobsRoutes } from "@/routes/jobs";
import { sequenceRoutes } from "@/routes/sequences";
import { styleRoutes } from "@/routes/styles";
import { teamRoutes } from "@/routes/teams";
import { userRoutes } from "@/routes/users";

const app = new Elysia()
  // Core plugins
  .use(
    cors({
      origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  )
  .use(
    openapi({
      references: fromTypes(),
    }),
  )
  .use(loggingPlugin)
  .use(errorPlugin)

  // Health check
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  }))

  // API routes
  .use(authRoutes)
  .use(sequenceRoutes)
  .use(frameRoutes)
  .use(styleRoutes)
  .use(teamRoutes)
  .use(userRoutes)
  .use(aiRoutes)
  .use(jobsRoutes)

  .listen(process.env.PORT ?? 3030);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
console.log(
  `📚 OpenAPI docs at http://${app.server?.hostname}:${app.server?.port}/openapi`,
);

export type App = typeof app;

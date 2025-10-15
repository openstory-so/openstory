/**
 * Team routes
 * API endpoints for team management
 */

import { type } from "arktype";
import { Elysia, t } from "elysia";
import { requireAuth } from "@/plugins/auth";
import {
  type AddTeamMemberInput,
  addTeamMemberSchema,
  type CreateTeamInput,
  type CreateTeamInvitationInput,
  createTeamInvitationSchema,
  createTeamSchema,
  type UpdateTeamInput,
  type UpdateTeamMemberRoleInput,
  updateTeamMemberRoleSchema,
  updateTeamSchema,
} from "@/schemas/teams";
import { TeamService } from "@/services/teams";

/**
 * Team routes plugin
 */
export const teamRoutes = new Elysia({ prefix: "/teams" })
  .use(requireAuth)

  // GET /teams - List user's teams
  .get("/", async (context) => {
    const { user } = context as any;
    const teams = await TeamService.listByUser(user);

    return {
      success: true,
      data: teams,
    };
  })

  // POST /teams - Create a new team
  .post(
    "/",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createTeamSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateTeamInput;
      const team = await TeamService.create(input, user);

      return {
        success: true,
        data: team,
      };
    },
    {
      body: t.Object({
        name: t.String(),
        slug: t.String(),
      }),
    },
  )

  // GET /teams/:id - Get team by ID
  .get("/:id", async (context) => {
    const { params, user } = context as any;
    const team = await TeamService.getById(params.id, user);

    return {
      success: true,
      data: team,
    };
  })

  // PUT /teams/:id - Update team
  .put(
    "/:id",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = updateTeamSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as UpdateTeamInput;
      const team = await TeamService.update(params.id, input, user);

      return {
        success: true,
        data: team,
      };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        slug: t.Optional(t.String()),
      }),
    },
  )

  // DELETE /teams/:id - Delete team
  .delete("/:id", async (context) => {
    const { params, user } = context as any;
    const result = await TeamService.delete(params.id, user);

    return {
      success: true,
      data: result,
    };
  })

  // POST /teams/:id/members - Add a member to the team
  .post(
    "/:id/members",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = addTeamMemberSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as AddTeamMemberInput;
      const member = await TeamService.addMember(params.id, input, user);

      return {
        success: true,
        data: member,
      };
    },
    {
      body: t.Object({
        userId: t.String(),
        role: t.String(),
      }),
    },
  )

  // DELETE /teams/:id/members/:userId - Remove a member from the team
  .delete("/:id/members/:userId", async (context) => {
    const { params, user } = context as any;
    const result = await TeamService.removeMember(
      params.id,
      params.userId,
      user,
    );

    return {
      success: true,
      data: result,
    };
  })

  // PUT /teams/:id/members/:userId - Update a member's role
  .put(
    "/:id/members/:userId",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = updateTeamMemberRoleSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as UpdateTeamMemberRoleInput;
      const member = await TeamService.updateMemberRole(
        params.id,
        params.userId,
        input,
        user,
      );

      return {
        success: true,
        data: member,
      };
    },
    {
      body: t.Object({
        role: t.String(),
      }),
    },
  )

  // POST /teams/:id/invitations - Create a team invitation
  .post(
    "/:id/invitations",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = createTeamInvitationSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateTeamInvitationInput;
      const invitation = await TeamService.createInvitation(
        params.id,
        input,
        user,
      );

      return {
        success: true,
        data: invitation,
      };
    },
    {
      body: t.Object({
        email: t.String(),
        role: t.String(),
        expiresAt: t.Optional(t.Date()),
      }),
    },
  )

  // GET /teams/:id/invitations - List team invitations
  .get("/:id/invitations", async (context) => {
    const { params, user } = context as any;
    const invitations = await TeamService.listInvitations(params.id, user);

    return {
      success: true,
      data: invitations,
    };
  });

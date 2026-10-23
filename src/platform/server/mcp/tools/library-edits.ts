/**
 * Library writes (#2155): a team's styles, the same create / update /
 * delete the Styles page and `POST /api/v1/styles` do. A style is the
 * team's, not a sequence's; `regenerate_storyboard` applies one to a
 * sequence and `list_styles` / `get_style` read them.
 */
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { requireTeamAdminAccess } from '@/platform/server/auth/action-utils';
import { apiCreateStyleSchema } from '@/platform/server/api-v1/style-input-schema';
import {
  styleDocument,
  styleDocumentSchema,
} from '@/platform/server/api-v1/styles';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { openstoryTool } from '../tool-context';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const styleId = ulidSchema.describe('Style ID (list_styles).');

const createStyleTool = openstoryTool({
  name: 'create_style',
  description:
    'Create a library style for the team from a complete v2 config (look + motion), the same body as POST /api/v1/styles. The name must be unique in the team. Starts no generation; regenerate_storyboard applies a style to a sequence.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: apiCreateStyleSchema.strict(),
  outputSchema: styleDocumentSchema,
  run: async (input, { scopedDb }) => {
    const style = await scopedDb.styles.create(input);
    return {
      data: styleDocumentSchema.parse(styleDocument(style)),
      summary: `Created style ${style.name}.`,
    };
  },
});

const updateStyleTool = openstoryTool({
  name: 'update_style',
  description:
    'Edit a team library style: any of its fields; config is replaced whole when sent. At least one field. A public Gallery style cannot be edited. Sequences already using the style keep their stored snapshot.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: apiCreateStyleSchema.partial().extend({ styleId }).strict(),
  outputSchema: styleDocumentSchema,
  run: async ({ styleId: id, ...changes }, { scopedDb }) => {
    if (Object.keys(changes).length === 0) {
      throw new ValidationError('Send at least one field to change.');
    }
    const style = await scopedDb.styles.update(id, changes);
    if (!style) throw new NotFoundError('Style not found');
    return {
      data: styleDocumentSchema.parse(styleDocument(style)),
      summary: `Updated style ${style.name}.`,
    };
  },
});

const deleteStyleTool = openstoryTool({
  name: 'delete_style',
  description:
    'Delete a team library style. Needs an admin or owner of the team. Sequences that used it keep their stored snapshot. Cannot be undone.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, destructiveHint: true },
  inputSchema: z.strictObject({ styleId }),
  outputSchema: z.object({ styleId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const style = await scopedDb.styles.getById(input.styleId);
    if (!style) throw new NotFoundError('Style not found');
    await requireTeamAdminAccess(userId, style.teamId);
    await scopedDb.styles.delete(style.id);
    return {
      data: { styleId: style.id },
      summary: `Deleted style ${style.name}.`,
    };
  },
});

export const libraryEditTools = [
  createStyleTool,
  updateStyleTool,
  deleteStyleTool,
];

/**
 * User service layer
 * Business logic for user operations
 */

import { getUserById, isAnonymousUser, updateUser } from "@/db/queries/users";
import type { User } from "@/lib/auth/config";
import { AuthorizationError, NotFoundError } from "@/plugins/error";

export interface UpdateUserInput {
  fullName?: string;
  avatarUrl?: string | null;
  onboardingCompleted?: boolean;
}

export class UserService {
  /**
   * Get user by ID
   * Users can only access their own profile
   */
  static async getById(userId: string, currentUser: User) {
    // Users can only access their own profile
    if (userId !== currentUser.id) {
      throw new AuthorizationError("You can only access your own profile");
    }

    const user = await getUserById(userId);

    if (!user) {
      throw new NotFoundError("User not found");
    }

    return user;
  }

  /**
   * Get current user profile
   */
  static async getCurrentUser(user: User) {
    const profile = await getUserById(user.id);

    if (!profile) {
      throw new NotFoundError("User not found");
    }

    // Check if user is anonymous
    const isAnonymous = await isAnonymousUser(user.id);

    return {
      ...profile,
      isAnonymous,
    };
  }

  /**
   * Update user profile
   * Users can only update their own profile
   */
  static async update(
    userId: string,
    input: UpdateUserInput,
    currentUser: User,
  ) {
    // Users can only update their own profile
    if (userId !== currentUser.id) {
      throw new AuthorizationError("You can only update your own profile");
    }

    // Update user
    const updated = await updateUser(userId, {
      fullName: input.fullName,
      avatarUrl: input.avatarUrl,
    });

    return updated;
  }
}

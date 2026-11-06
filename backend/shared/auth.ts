import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface User {
  id: string;
  email?: string;
  groups?: string[];
}

/**
 * LOGIN HOOK — every request is anonymous for now.
 *
 * When login is added (e.g. Cognito):
 *   1. Read the bearer token from event.headers.authorization
 *   2. Verify it (aws-jwt-verify works well for Cognito tokens)
 *   3. Return the User, or null if the token is missing/invalid
 *
 * Routes marked `requireAuth: true` in api/routes.ts will then reject anonymous callers.
 */
export async function getUser(_event: APIGatewayProxyEventV2): Promise<User | null> {
  return null;
}

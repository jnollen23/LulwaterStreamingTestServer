import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUser } from '../shared/auth.js';
import { json, matchRoute } from './routes.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const match = matchRoute(event.requestContext.http.method, event.rawPath);
  if (!match) return json(404, { error: 'Not found' });

  try {
    const user = await getUser(event);
    if (match.route.requireAuth && !user) return json(401, { error: 'Login required' });
    return await match.route.handler({ event, params: match.params, user });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Internal error' });
  }
}

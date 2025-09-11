import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccess } from '../lib/jwt';

export function requireAuth() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.cookies?.at as string) || '';
    try {
      const payload = verifyAccess(token);
      (req as any).user = payload; // attach user
    } catch {
      reply.code(302).header('Location', '/login.html').send();
      return;
    }
  };
}

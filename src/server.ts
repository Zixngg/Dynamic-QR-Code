import 'dotenv/config'; // 👈 load .env first
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import formBody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import path from 'node:path';
import { verifyAccess } from './lib/jwt';
import authRoutes from './routes/auth';
import qrRoutes from './routes/qr';

async function start() {
  const app = Fastify({ logger: true });

  await app.register(cookie, {
    hook: 'onRequest',
    parseOptions: { httpOnly: true, sameSite: 'lax' }
  });
  await app.register(formBody);
  await app.register(multipart, { limits: { fileSize: 500_000 } });

  // Serve static files (html, css, uploads, etc.)
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/',
    decorateReply: false,
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/me', async (req, reply) => {
    const at = (req.cookies as any)?.at as string | undefined;
    if (!at) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const p = verifyAccess(at);
      return { id: p.sub, email: p.email };
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await authRoutes(app);
  await qrRoutes(app);

  app.get('/', async (_req, reply) => reply.redirect('/login.html'));

  const port = Number(process.env.PORT || 8080);
  try {
    await app.listen({ port });
    app.log.info(`API running at http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

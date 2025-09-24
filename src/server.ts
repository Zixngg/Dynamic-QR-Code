import 'dotenv/config'; // load .env first
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import formBody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs/promises';
import { verifyAccess } from './lib/jwt';
import authRoutes from './routes/auth';
import qrRoutes from './routes/qr';

async function start() {
  const app = Fastify({ logger: true });

  // cookies
  await app.register(cookie, {
    hook: 'onRequest',
    parseOptions: { httpOnly: true, sameSite: 'lax' }
  });

  // parse form bodies (x-www-form-urlencoded)
  await app.register(formBody);

  // multipart for logo uploads (limit ~500 KB)
  await app.register(multipart, { limits: { fileSize: 500_000 } });

  // serve static files (html, css, uploads, etc.)
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // health check
  app.get('/health', async () => ({ ok: true }));

  // uploads endpoint for logo images
  app.post('/uploads', async (req, reply) => {
    const parts = req.parts();
    let filePart: any = null;
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        filePart = part;
        break;
      }
    }
    if (!filePart) return reply.code(400).send({ error: 'No file' });

    const buf = await filePart.toBuffer();
    const ext = (filePart.filename || '').toLowerCase().split('.').pop() || 'png';
    const allowed = ['png','jpg','jpeg','svg'];
    if (!allowed.includes(ext)) return reply.code(400).send({ error: 'Invalid type' });

    const name = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}.${ext}`;
    const outDir = path.join(process.cwd(), 'public', 'uploads');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, name);
    await fs.writeFile(outPath, buf);

    const url = `/uploads/${name}`;
    const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'application/octet-stream';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    reply.send({ url, dataUrl });
  });

  // who am I
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

  // register routes
  await authRoutes(app);
  await qrRoutes(app);

  // default redirect to login
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
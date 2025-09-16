import { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { getPool, SQL } from '../db';
import { verifyAccess } from '../lib/jwt';
import type { AccessPayload } from '../lib/jwt';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:8080';

// ---------- helpers ----------
function getUserOrThrow(req: FastifyRequest): AccessPayload {
  const at = (req.cookies as any)?.at as string | undefined;
  if (!at) throw new Error('unauthorized');
  try { return verifyAccess(at); } catch { throw new Error('unauthorized'); }
}

function normalizeUrl(u: string) {
  try {
    const url = new URL(u);
    if (!/^https?:$/i.test(url.protocol)) throw new Error('Only http/https allowed');
    return url.toString();
  } catch { throw new Error('Invalid URL'); }
}

function injectLogoIntoSvg(svg: string, logoUrl: string, sizePct = 22): string {
  const size = 512;
  const logoSize = Math.round((sizePct / 100) * size);
  const x = Math.round((size - logoSize) / 2);
  const y = Math.round((size - logoSize) / 2);
  const imageTag = `<image href="${logoUrl}" x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet" />`;
  return svg.replace('</svg>', `${imageTag}</svg>`);
}

export default async function qrRoutes(app: FastifyInstance) {
  // ---------- List my QR codes ----------
  app.get('/api/my/qr', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const pool = await getPool();
    const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, user.sub)
      .query(`
        SELECT q.Id, q.Name, q.Slug, t.Url AS CurrentUrl, q.CreatedAt
        FROM dbo.[QR_Code] q
        LEFT JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
        WHERE q.User_Id = @uid
        ORDER BY q.CreatedAt DESC
      `);
    reply.send(r.recordset);
  });

  // ---------- Create QR ----------
  app.post('/qr/create', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const body = req.body as any;
    const pool = await getPool();

    try {
      const name = String(body.name || '').trim();
      const url = normalizeUrl(String(body.url || ''));

      const slug = Math.random().toString(36).substring(2, 9);

      // default design object
      const design = JSON.stringify({
        fg: '#0b3d91',
        bg: '#ffffff',
        ec: 'M',
        format: 'svg',
        logoUrl: null,
        logoSizePct: 22
      });

      // insert QR code with design
      const qrIns = await pool.request()
        .input('uid', SQL.UniqueIdentifier, user.sub)
        .input('name', SQL.NVarChar(200), name)
        .input('slug', SQL.NVarChar(64), slug)
        .input('design', SQL.NVarChar(SQL.MAX), design)
        .query(`
          INSERT INTO dbo.[QR_Code] (User_Id, Name, Slug, Design)
          OUTPUT inserted.Id
          VALUES (@uid, @name, @slug, @design);
        `);

      const qrId = qrIns.recordset[0].Id as string;

      // create first target
      const trgIns = await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .input('url', SQL.NVarChar(2048), url)
        .input('ver', SQL.Int, 1)
        .query(`
          INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, [Version])
          OUTPUT inserted.Id
          VALUES (@qid, @url, @ver);
        `);

      const targetId = trgIns.recordset[0].Id as string;

      await pool.request()
        .input('tid', SQL.UniqueIdentifier, targetId)
        .input('qid', SQL.UniqueIdentifier, qrId)
        .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid;');

      return reply.redirect(`/qr.html?success=QR+created&slug=${encodeURIComponent(slug)}`);
    } catch (e: any) {
      return reply.redirect(`/generateQR.html?error=${encodeURIComponent(e.message || 'Failed to create')}`);
    }
  });

  // ---------- Retarget (update URL) ----------
  app.post('/qr/:slug/retarget', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const { slug } = req.params as any;
    const body = req.body as any;

    try {
      const url = normalizeUrl(String(body.url || ''));

      const pool = await getPool();
      const q = await pool.request()
        .input('slug', SQL.NVarChar(64), slug)
        .input('uid', SQL.UniqueIdentifier, user.sub)
        .query('SELECT TOP 1 Id FROM dbo.[QR_Code] WHERE Slug=@slug AND User_Id=@uid;');

      if (!q.recordset.length) return reply.redirect(`/qr.html?error=Not+found`);
      const qrId = q.recordset[0].Id as string;

      const verRes = await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .query('SELECT ISNULL(MAX([Version]),0) AS v FROM dbo.[QR_Target] WHERE QR_Code_Id=@qid;');
      const nextVer = (verRes.recordset[0].v as number) + 1;

      const trg = await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .input('url', SQL.NVarChar(2048), url)
        .input('ver', SQL.Int, nextVer)
        .query(`
          INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, [Version])
          OUTPUT inserted.Id
          VALUES (@qid, @url, @ver);
        `);

      const targetId = trg.recordset[0].Id as string;

      await pool.request()
        .input('tid', SQL.UniqueIdentifier, targetId)
        .input('qid', SQL.UniqueIdentifier, qrId)
        .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid;');

      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&success=Target+updated`);
    } catch (e: any) {
      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=${encodeURIComponent(e.message || 'Failed to update')}`);
    }
  });

  // ---------- Delete QR ----------
  app.post('/qr/:slug/delete', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const { slug } = req.params as any;

    const pool = await getPool();
    await pool.request()
      .input('slug', SQL.NVarChar(64), slug)
      .input('uid', SQL.UniqueIdentifier, user.sub)
      .query('DELETE FROM dbo.[QR_Code] WHERE Slug=@slug AND User_Id=@uid;');

    return reply.redirect('/qr.html?success=QR+deleted');
  });

  // ---------- Get single QR details ----------
  app.get('/api/qr/:slug', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const { slug } = req.params as any;

    const pool = await getPool();
    const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, user.sub)
      .input('slug', SQL.NVarChar(64), slug)
      .query(`
        SELECT q.Id, q.Name, q.Slug, t.Url AS CurrentUrl, q.CreatedAt
        FROM dbo.[QR_Code] q
        LEFT JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
        WHERE q.User_Id=@uid AND q.Slug=@slug
      `);

    if (!r.recordset.length) return reply.code(404).send({ error: 'Not found' });

    reply.send(r.recordset[0]);
  });

  // ---------- Serve QR as SVG ----------
  app.get('/qr/:slug.svg', async (req, reply) => {
    const { slug } = req.params as any;
    const pool = await getPool();
    const r = await pool.request()
      .input('slug', SQL.NVarChar(64), slug)
      .query(`SELECT TOP 1 Design FROM dbo.[QR_Code] WHERE Slug=@slug`);
    if (!r.recordset.length) return reply.code(404).send('Not found');

    const design = JSON.parse(r.recordset[0].Design || '{}');
    const fg = design.fg || '#0b3d91';
    const bg = design.bg || '#ffffff';
    const ecMap: any = { L: 'low', M: 'medium', Q: 'quartile', H: 'high' };
    const errorCorrectionLevel = ecMap[(design.ec || 'M')] || 'medium';

    const content = `${PUBLIC_BASE_URL}/r/${slug}`;

    let svg = await QRCode.toString(content, {
      type: 'svg',
      color: { dark: fg, light: bg },
      errorCorrectionLevel,
      margin: 2,
      width: 512
    });
    if (design.logoUrl) svg = injectLogoIntoSvg(svg, design.logoUrl, Number(design.logoSizePct) || 22);

    reply.header('Content-Type', 'image/svg+xml').send(svg);
  });

  // ---------- Redirect ----------
  app.get('/r/:slug', async (req, reply) => {
    const { slug } = req.params as any;
    const pool = await getPool();
    const q = await pool.request()
      .input('slug', SQL.NVarChar(64), slug)
      .query(`
        SELECT TOP 1 t.Url
        FROM dbo.[QR_Code] q
        JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
        WHERE q.Slug = @slug
      `);
    if (!q.recordset.length) return reply.code(404).send('Not found');
    return reply.redirect(q.recordset[0].Url);
  });
}
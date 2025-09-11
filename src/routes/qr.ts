import { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { getPool, SQL } from '../db';
import { verifyAccess } from '../lib/jwt';
import type { AccessPayload } from '../lib/jwt';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:8080';

function getUserOrThrow(req: FastifyRequest): AccessPayload {
  const at = (req.cookies as any)?.at as string | undefined;
  if (!at) throw new Error('unauthorized');
  try { return verifyAccess(at); } catch { throw new Error('unauthorized'); }
}

function base62(n: number) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  while (n > 0) { s = chars[n % 62] + s; n = Math.floor(n / 62); }
  return s || '0';
}
function randomSlug(len = 7) {
  const n = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  let s = base62(n);
  if (s.length < len) s = (s + '0000000').slice(0, len);
  return s.slice(0, len);
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
  const imageTag = `<image href="${logoUrl.replace(/"/g, '&quot;')}" x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet" />`;
  return svg.replace('</svg>', `${imageTag}</svg>`);
}

export default async function qrRoutes(app: FastifyInstance) {
  // ---------- Upload logo ----------
  app.post('/uploads', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); } catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const data = await (req as any).file?.();
    if (!data) return reply.code(400).send({ error: 'No file' });
    const allowed = ['image/png', 'image/jpeg', 'image/svg+xml'];
    if (!allowed.includes(data.mimetype)) return reply.code(400).send({ error: 'Only PNG/JPEG/SVG allowed' });

    const ext = data.mimetype === 'image/png' ? '.png' : data.mimetype === 'image/jpeg' ? '.jpg' : '.svg';
    const fname = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    const dest = path.join(process.cwd(), 'public', 'uploads', fname);
    await fs.promises.writeFile(dest, await data.toBuffer());
    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:8080';
    return reply.send({ url: `${base}/uploads/${fname}` });
  });

  // ---------- Preview (GET with query) ----------
  app.get('/qr/preview', async (req, reply) => {
    const q = (req.query as any) || {};
    const fg = String(q.fg || '#0b3d91');
    const bg = String(q.bg || '#ffffff');
    const ec = String(q.ec || 'M').toUpperCase();
    const logoUrl = String(q.logoUrl || '').trim();
    const logoSizePct = Math.min(40, Math.max(10, Number(q.logoSizePct || 22)));
    const ecMap: any = { L: 'low', M: 'medium', Q: 'quartile', H: 'high' };
    const errorCorrectionLevel = ecMap[ec] || 'medium';

    const content = 'https://example.com/preview';

    let svg = await QRCode.toString(content, {
      type: 'svg',
      color: { dark: fg, light: bg },
      errorCorrectionLevel,
      margin: 2,
      width: 512
    });
    if (logoUrl) svg = injectLogoIntoSvg(svg, logoUrl, logoSizePct);

    reply.header('Content-Type', 'image/svg+xml').send(svg);
  });

  // ---------- Create QR ----------
  app.post('/qr/create', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const body = req.body as any;
    try {
      const name = String(body.name || '').trim();
      const inputSlug = String(body.slug || '').trim().replace(/[^a-z0-9\-]/gi, '').slice(0, 64);
      const url = normalizeUrl(String(body.url || ''));
      const utm_source = String(body.utm_source || '').trim();
      const utm_medium = String(body.utm_medium || '').trim();
      const utm_campaign = String(body.utm_campaign || '').trim();
      const fg = String(body.fg || '#0b3d91');
      const bg = String(body.bg || '#ffffff');
      const ec = (String(body.ec || 'M').toUpperCase());
      const fmt = (String(body.format || 'svg').toLowerCase() === 'png') ? 'png' : 'svg';
      const logoUrl = String(body.logoUrl || '').trim();
      const logoSizePct = Math.min(40, Math.max(10, Number(body.logoSizePct || 22)));

      if (!name) return reply.redirect('/generateQR.html?error=Name+is+required');

      const pool = await getPool();

      // unique slug
      let slug = inputSlug || randomSlug(7);
      for (let i=0;i<3;i++){
        const exists = await pool.request().input('slug', SQL.NVarChar(64), slug)
          .query('SELECT 1 FROM dbo.[QR_Code] WHERE Slug=@slug');
        if (!exists.recordset.length) break;
        slug = randomSlug(7);
      }

      const design = JSON.stringify({ fg, bg, ec, format: fmt, logoUrl: logoUrl || null, logoSizePct });

      const qrIns = await pool.request()
        .input('uid', SQL.UniqueIdentifier, user.sub)
        .input('name', SQL.NVarChar(200), name)
        .input('slug', SQL.NVarChar(64), slug)
        .input('design', SQL.NVarChar(SQL.MAX), design)
        .input('fmt', SQL.NVarChar(8), fmt)
        .input('ec', SQL.NVarChar(2), ec)
        .query(`
          INSERT INTO dbo.[QR_Code] (User_Id, Name, Slug, Design, [Format], EC_Level)
          OUTPUT inserted.Id
          VALUES (@uid, @name, @slug, @design, @fmt, @ec);
        `);
      const qrId = qrIns.recordset[0].Id as string;

      const utm: any = {};
      if (utm_source) utm.source = utm_source;
      if (utm_medium) utm.medium = utm_medium;
      if (utm_campaign) utm.campaign = utm_campaign;
      const utmJson = Object.keys(utm).length ? JSON.stringify(utm) : null;

      const trgIns = await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .input('url', SQL.NVarChar(2048), url)
        .input('utm', SQL.NVarChar(SQL.MAX), utmJson)
        .input('ver', SQL.Int, 1)
        .query(`
          INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, UTM, [Version])
          OUTPUT inserted.Id
          VALUES (@qid, @url, @utm, @ver);
        `);
      const targetId = trgIns.recordset[0].Id as string;

      await pool.request()
        .input('tid', SQL.UniqueIdentifier, targetId)
        .input('qid', SQL.UniqueIdentifier, qrId)
        .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid;');

      return reply.redirect(`/qr.html?success=QR+created&slug=${encodeURIComponent(slug)}`);
    } catch (e:any) {
      return reply.redirect(`/generateQR.html?error=${encodeURIComponent(e.message || 'Failed to create')}`);
    }
  });

  // ---------- Render saved QR SVG ----------
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
        SELECT TOP 1 q.Id AS qrId, t.Id AS targetId, t.Url, t.UTM
        FROM dbo.[QR_Code] q
        JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
        WHERE q.Slug = @slug
      `);
    if (!q.recordset.length) return reply.code(404).send('Not found');

    const row = q.recordset[0];
    const dest = new URL(row.Url);
    const utm = row.UTM ? JSON.parse(row.UTM) : {};
    for (const [k, v] of Object.entries(utm)) dest.searchParams.set(`utm_${k}`, String(v));

    return reply.redirect(dest.toString());
  });

  // ---------- List my QR ----------
  app.get('/api/my/qr', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const pool = await getPool();
    const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, user.sub)
      .query(`
        SELECT q.Id, q.Name, q.Slug, q.CreatedAt
        FROM dbo.[QR_Code] q
        WHERE q.User_Id = @uid
        ORDER BY q.CreatedAt DESC
      `);
    reply.send(r.recordset);
  });

  // ---------- Get one QR ----------
  app.get('/api/qr/:slug', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); } catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const { slug } = req.params as any;
    const pool = await getPool();
    const r = await pool.request()
      .input('slug', SQL.NVarChar(64), slug)
      .input('uid',  SQL.UniqueIdentifier, user.sub)
      .query(`
        SELECT TOP 1 q.Id, q.Name, q.Slug, t.Url AS CurrentUrl, t.UTM
        FROM dbo.[QR_Code] q
        LEFT JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
        WHERE q.Slug = @slug AND q.User_Id = @uid
      `);
    if (!r.recordset.length) return reply.code(404).send({ error: 'not found' });

    const row = r.recordset[0];
    return reply.send({
      Id: row.Id,
      Name: row.Name,
      Slug: row.Slug,
      CurrentUrl: row.CurrentUrl,
      UTM: row.UTM ? JSON.parse(row.UTM) : null
    });
  });

  // ---------- Retarget ----------
  app.post('/qr/:slug/retarget', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); } catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const { slug } = req.params as any;
    const body = req.body as any;
    try {
      const url = normalizeUrl(String(body.url || ''));
      const utm_source = String(body.utm_source || '').trim();
      const utm_medium = String(body.utm_medium || '').trim();
      const utm_campaign = String(body.utm_campaign || '').trim();

      const pool = await getPool();
      const q = await pool.request()
        .input('slug', SQL.NVarChar(64), slug)
        .input('uid',  SQL.UniqueIdentifier, user.sub)
        .query('SELECT TOP 1 Id FROM dbo.[QR_Code] WHERE Slug=@slug AND User_Id=@uid;');
      if (!q.recordset.length) return reply.redirect(`/qr.html?error=Not+found`);

      const qrId = q.recordset[0].Id as string;
      const verRes = await pool.request().input('qid', SQL.UniqueIdentifier, qrId)
        .query('SELECT ISNULL(MAX([Version]), 0) AS v FROM dbo.[QR_Target] WHERE QR_Code_Id=@qid;');
      const nextVer = (verRes.recordset[0].v as number) + 1;

      const utm: Record<string,string> = {};
      if (utm_source) utm.source = utm_source;
      if (utm_medium) utm.medium = utm_medium;
      if (utm_campaign) utm.campaign = utm_campaign;
      const utmJson = Object.keys(utm).length ? JSON.stringify(utm) : null;

      const trg = await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .input('url', SQL.NVarChar(2048), url)
        .input('utm', SQL.NVarChar(SQL.MAX), utmJson)
        .input('ver', SQL.Int, nextVer)
        .query(`
          INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, UTM, [Version])
          OUTPUT inserted.Id
          VALUES (@qid, @url, @utm, @ver);
        `);
      const targetId = trg.recordset[0].Id as string;

      await pool.request()
        .input('tid', SQL.UniqueIdentifier, targetId)
        .input('qid', SQL.UniqueIdentifier, qrId)
        .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid;');

      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&success=${encodeURIComponent('Target updated')}`);
    } catch (e:any) {
      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=${encodeURIComponent(e.message || 'Failed to update')}`);
    }
  });
}

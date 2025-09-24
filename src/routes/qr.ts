import { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { getPool, SQL } from '../db';
import { verifyAccess } from '../lib/jwt';
import type { AccessPayload } from '../lib/jwt';
// Zehua
import useragent from 'useragent';
import geoip from 'geoip-lite';
import fs from 'node:fs/promises';
import path from 'node:path';

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

function injectLogoIntoSvg(
  svg: string,
  logoUrl: string,
  sizePct = 22,
  debug = false,
  backgroundColor = '#ffffff',
  borderColor = '#000000'
): string {
  // Determine canvas size from SVG attributes (width/height or viewBox)
  let size = 512;
  const whMatch = svg.match(/<svg[^>]*\bwidth=\"(\d+)\"[^>]*\bheight=\"(\d+)\"/i);
  const vbMatch = svg.match(/viewBox=\"\s*0\s+0\s+(\d+)\s+(\d+)\s*\"/i);
  if (whMatch) {
    size = Math.min(parseInt(whMatch[1], 10) || 512, parseInt(whMatch[2], 10) || 512);
  } else if (vbMatch) {
    size = Math.min(parseInt(vbMatch[1], 10) || 512, parseInt(vbMatch[2], 10) || 512);
  }
  const logoSize = Math.round((sizePct / 100) * size);
  const x = Math.round((size - logoSize) / 2);
  const y = Math.round((size - logoSize) / 2);

  // Ensure xlink namespace exists for broader browser support
  if (!/xmlns:xlink=/i.test(svg)) {
    svg = svg.replace(
      /<svg(\s[^>]*)?>/i,
      (m) => m.replace('>', ' xmlns:xlink="http://www.w3.org/1999/xlink">')
    );
  }

  const debugRect = debug ? `<rect x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" fill="none" stroke="red" stroke-width="4" />` : '';
  const debugText = debug ? `<text x="8" y="24" fill="red" font-size="18">logoSize=${logoSize} x=${x} y=${y}</text>` : '';
  // Knockout rectangle to improve contrast (expand slightly beyond logo)
  const pad = Math.max(2, Math.round(logoSize * 0.06));
  const kx = Math.max(0, x - pad);
  const ky = Math.max(0, y - pad);
  const kw = Math.min(size, logoSize + pad * 2);
  const kh = Math.min(size, logoSize + pad * 2);
  const knockout = `<rect x="${kx}" y="${ky}" width="${kw}" height="${kh}" rx="${Math.round(pad)}" ry="${Math.round(pad)}" fill="${backgroundColor}" />`;
  const imageTag = `<image href="${logoUrl}" x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet" />`;
  const borderRect = `<rect x="${kx}" y="${ky}" width="${kw}" height="${kh}" rx="${Math.round(pad)}" ry="${Math.round(pad)}" fill="none" stroke="${borderColor}" stroke-width="2" />`;
  return svg.replace('</svg>', `${debugRect}${debugText}${knockout}${imageTag}${borderRect}</svg>`);
}

export default async function qrRoutes(app: FastifyInstance) {
  async function resolveLogoHref(logoUrl: string): Promise<string> {
    try {
      if (!logoUrl) return logoUrl;
      // Inline uploaded files as data URLs to ensure they render inside <img src=SVG>
      let pathname: string | null = null;
      if (logoUrl.startsWith('/uploads/')) {
        pathname = decodeURIComponent(logoUrl);
      } else if (/^https?:\/\//i.test(logoUrl)) {
        try {
          const u = new URL(logoUrl);
          if (u.pathname.startsWith('/uploads/')) pathname = decodeURIComponent(u.pathname);
        } catch {}
      }
      if (pathname) {
        const abs = path.join(process.cwd(), 'public', pathname.replace(/^\//, ''));
        const buf = await fs.readFile(abs).catch((e) => {
          console.error('Logo read failed', { abs, e: String(e) });
          throw e;
        });
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
        return `data:${mime};base64,${buf.toString('base64')}`;
      }
      return logoUrl;
    } catch {
      console.error('resolveLogoHref failed', { logoUrl });
      return logoUrl;
    }
  }
  // ---------- Live preview (SVG) ----------
  app.get('/qr/preview', async (req, reply) => {
    const q = (req.query as any) || {};
    const fg = String(q.fg || '#0b3d91');
    const bg = String(q.bg || '#ffffff');
    const ec = String(q.ec || 'M').toUpperCase();
    const logoUrl = q.logoUrl ? await resolveLogoHref(String(q.logoUrl)) : '';
    const logoSizePct = Number(q.logoSizePct || 22);
    const debug = String(q.debug || '0') === '1';

    console.log('Preview request:', { fg, bg, ec, logoUrl: logoUrl ? 'data:...' : 'none', logoSizePct, debug });

    const ecMap: any = { L: 'low', M: 'medium', Q: 'quartile', H: 'high' };
    const errorCorrectionLevel = ecMap[ec] || 'medium';

    const content = 'https://preview.local/qr';

    let svg = await QRCode.toString(content, {
      type: 'svg',
      color: { dark: fg, light: bg },
      errorCorrectionLevel,
      margin: 2,
      width: 512
    });
    if (logoUrl) {
      console.log('Injecting logo:', { logoUrl: logoUrl.substring(0, 50) + '...', logoSizePct });
      svg = injectLogoIntoSvg(svg, logoUrl, Number.isFinite(logoSizePct) ? logoSizePct : 22, debug, bg, fg);
    }

    reply.header('Content-Type', 'image/svg+xml').send(svg);
  });
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
  // app.post('/qr/create', async (req, reply) => {
  //   let user: AccessPayload;
  //   try { user = getUserOrThrow(req); }
  //   catch { return reply.redirect('/login.html?error=Please+log+in'); }

  //   const body = req.body as any;
  //   const pool = await getPool();

  //   try {
  //     const name = String(body.name || '').trim();
  //     const url = normalizeUrl(String(body.url || ''));

  //     const slug = Math.random().toString(36).substring(2, 9);

  //     // default design object
  //     const design = JSON.stringify({
  //       fg: '#0b3d91',
  //       bg: '#ffffff',
  //       ec: 'M',
  //       format: 'svg',
  //       logoUrl: null,
  //       logoSizePct: 22
  //     });

  //     // insert QR code with design
  //     const qrIns = await pool.request()
  //       .input('uid', SQL.UniqueIdentifier, user.sub)
  //       .input('name', SQL.NVarChar(200), name)
  //       .input('slug', SQL.NVarChar(64), slug)
  //       .input('design', SQL.NVarChar(SQL.MAX), design)
  //       .query(`
  //         INSERT INTO dbo.[QR_Code] (User_Id, Name, Slug, Design)
  //         OUTPUT inserted.Id
  //         VALUES (@uid, @name, @slug, @design);
  //       `);

  //     const qrId = qrIns.recordset[0].Id as string;

  //     // create first target
  //     const trgIns = await pool.request()
  //       .input('qid', SQL.UniqueIdentifier, qrId)
  //       .input('url', SQL.NVarChar(2048), url)
  //       .input('ver', SQL.Int, 1)
  //       .query(`
  //         INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, [Version])
  //         OUTPUT inserted.Id
  //         VALUES (@qid, @url, @ver);
  //       `);

  //     const targetId = trgIns.recordset[0].Id as string;

  //     await pool.request()
  //       .input('tid', SQL.UniqueIdentifier, targetId)
  //       .input('qid', SQL.UniqueIdentifier, qrId)
  //       .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid;');

  //     return reply.redirect(`/qr.html?success=QR+created&slug=${encodeURIComponent(slug)}`);
  //   } catch (e: any) {
  //     return reply.redirect(`/generateQR.html?error=${encodeURIComponent(e.message || 'Failed to create')}`);
  //   }
  // });
  //Zehua
  app.post('/qr/create', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const body = req.body as any;
    const pool = await getPool();

    try {
      const name = String(body.name || '').trim();
      const url = normalizeUrl(String(body.url || ''));

      // Extract UTM parameters from the request body
      const utmSource = String(body.utm_source || '').trim();
      const utmMedium = String(body.utm_medium || '').trim();
      const utmCampaign = String(body.utm_campaign || '').trim();

      // Combine UTM parameters into a single JSON string for the UTM column
      const utmData = JSON.stringify({
        source: utmSource || null,
        medium: utmMedium || null,
        campaign: utmCampaign || null
      });

      const slug = Math.random().toString(36).substring(2, 9);

      // capture design from form selections (fallbacks match UI defaults)
      const fg = String(body.fg || '#0b3d91');
      const bg = String(body.bg || '#ffffff');
      const ec = String(body.ec || 'M').toUpperCase();
      const format = String(body.format || 'svg').toLowerCase();
      const rawLogoUrl = String(body.logoUrl || '').trim();
      const logoUrl = rawLogoUrl.length ? rawLogoUrl : null;
      const logoSizePct = Math.max(10, Math.min(40, Number(body.logoSizePct || 22)));

      const design = JSON.stringify({ fg, bg, ec, format, logoUrl, logoSizePct });

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

      // create first target with UTM parameters
      const trgIns = await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .input('url', SQL.NVarChar(2048), url)
        .input('ver', SQL.Int, 1)
        .input('utm', SQL.NVarChar(SQL.MAX), utmData)
        .query(`
          INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, [Version], UTM)
          OUTPUT inserted.Id
          VALUES (@qid, @url, @ver, @utm);
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
  // app.post('/qr/:slug/retarget', async (req, reply) => {
  //   let user: AccessPayload;
  //   try { user = getUserOrThrow(req); }
  //   catch { return reply.redirect('/login.html?error=Please+log+in'); }

  //   const { slug } = req.params as any;
  //   const body = req.body as any;

  //   try {
  //     const url = normalizeUrl(String(body.url || ''));

  //     const pool = await getPool();
  //     const q = await pool.request()
  //       .input('slug', SQL.NVarChar(64), slug)
  //       .input('uid', SQL.UniqueIdentifier, user.sub)
  //       .query('SELECT TOP 1 Id FROM dbo.[QR_Code] WHERE Slug=@slug AND User_Id=@uid;');

  //     if (!q.recordset.length) return reply.redirect(`/qr.html?error=Not+found`);
  //     const qrId = q.recordset[0].Id as string;

  //     const verRes = await pool.request()
  //       .input('qid', SQL.UniqueIdentifier, qrId)
  //       .query('SELECT ISNULL(MAX([Version]),0) AS v FROM dbo.[QR_Target] WHERE QR_Code_Id=@qid;');
  //     const nextVer = (verRes.recordset[0].v as number) + 1;

  //     const trg = await pool.request()
  //       .input('qid', SQL.UniqueIdentifier, qrId)
  //       .input('url', SQL.NVarChar(2048), url)
  //       .input('ver', SQL.Int, nextVer)
  //       .query(`
  //         INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, [Version])
  //         OUTPUT inserted.Id
  //         VALUES (@qid, @url, @ver);
  //       `);

  //     const targetId = trg.recordset[0].Id as string;

  //     await pool.request()
  //       .input('tid', SQL.UniqueIdentifier, targetId)
  //       .input('qid', SQL.UniqueIdentifier, qrId)
  //       .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid;');

  //     return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&success=Target+updated`);
  //   } catch (e: any) {
  //     return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=${encodeURIComponent(e.message || 'Failed to update')}`);
  //   }
  // });
  //Zehua
  app.post('/qr/:slug/retarget', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const { slug } = req.params as any;
    const body = req.body as any;

    try {
      const url = normalizeUrl(String(body.url || ''));
      
      // Extract UTM parameters from the request body
      const utmSource = String(body.utm_source || '').trim();
      const utmMedium = String(body.utm_medium || '').trim();
      const utmCampaign = String(body.utm_campaign || '').trim();

      // Combine UTM parameters into a single JSON string for the UTM column
      const utmData = JSON.stringify({
        source: utmSource || null,
        medium: utmMedium || null,
        campaign: utmCampaign || null
      });

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
        .input('utm', SQL.NVarChar(SQL.MAX), utmData)
        .query(`
          INSERT INTO dbo.[QR_Target] (QR_Code_Id, Url, [Version], UTM)
          OUTPUT inserted.Id
          VALUES (@qid, @url, @ver, @utm);
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

  // ---------- Update design (colors/logo) ----------
  app.post('/qr/:slug/design', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.redirect('/login.html?error=Please+log+in'); }

    const { slug } = req.params as any;
    const body = req.body as any;

    // sanitize inputs; keep defaults if missing
    const fg = String(body.fg || '#0b3d91');
    const bg = String(body.bg || '#ffffff');
    const ec = String(body.ec || 'M').toUpperCase();
    const format = String(body.format || 'svg').toLowerCase();
    const rawLogoUrl = String(body.logoUrl || '').trim();
    // decode if client pre-encoded the data URL to survive x-www-form-urlencoded
    const decodedLogo = rawLogoUrl.startsWith('data:') ? rawLogoUrl : decodeURIComponent(rawLogoUrl);
    const logoUrl = decodedLogo && decodedLogo.length ? decodedLogo : null;
    const logoSizePct = Math.max(10, Math.min(40, Number(body.logoSizePct || 22)));

    const design = JSON.stringify({ fg, bg, ec, format, logoUrl, logoSizePct });

    const pool = await getPool();
    const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, user.sub)
      .input('slug', SQL.NVarChar(64), slug)
      .input('design', SQL.NVarChar(SQL.MAX), design)
      .query('UPDATE dbo.[QR_Code] SET Design=@design WHERE Slug=@slug AND User_Id=@uid;');

    if ((r.rowsAffected?.[0] || 0) === 0) {
      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=Not+found`);
    }
    return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&success=Design+updated`);
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
    const debug = (req.query as any)?.debug === '1';
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
    const href = design.logoUrl ? await resolveLogoHref(design.logoUrl) : '';
    if (href) svg = injectLogoIntoSvg(svg, href, Number(design.logoSizePct) || 22, debug, bg, fg);

    reply.header('Content-Type', 'image/svg+xml').send(svg);
  });

  // ---------- Redirect ----------
  // app.get('/r/:slug', async (req, reply) => {
  //   const { slug } = req.params as any;
  //   const pool = await getPool();
  //   const q = await pool.request()
  //     .input('slug', SQL.NVarChar(64), slug)
  //     .query(`
  //       SELECT TOP 1 t.Url
  //       FROM dbo.[QR_Code] q
  //       JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
  //       WHERE q.Slug = @slug
  //     `);
  //   if (!q.recordset.length) return reply.code(404).send('Not found');
  //   return reply.redirect(q.recordset[0].Url);
  // });

  //Zehua
  // ---------- Redirect and log scan ----------
  app.get<{ Querystring: { utm?: string } }>('/r/:slug', async (req, reply) => {
    const { slug } = req.params as any;
    const pool = await getPool();

    // Get QR code and current target WITH UTM data
    const q = await pool.request()
      .input('slug', SQL.NVarChar(64), slug)
      .query(`
        SELECT TOP 1 q.Id AS QR_Code_Id, t.Id AS Target_Id, t.Url, t.UTM
        FROM dbo.[QR_Code] q
        JOIN dbo.[QR_Target] t ON t.Id = q.CurrentTargetId
        WHERE q.Slug = @slug
      `);

    if (!q.recordset.length) return reply.code(404).send('Not found');

    const { QR_Code_Id, Target_Id, Url, UTM } = q.recordset[0];

    // Gather scan info
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const uaRaw = req.headers['user-agent'] || '';
    const agent = useragent.parse(uaRaw);
    const geo = geoip.lookup(ip) || {};

    // Insert scan asynchronously (don't block redirect)
    // Use UTM data from the QR_Target table instead of query string
    pool.request()
      .input('QR_Code_Id', SQL.UniqueIdentifier, QR_Code_Id)
      .input('Target_Id', SQL.UniqueIdentifier, Target_Id)
      .input('OccurredAt', SQL.DateTime2, new Date())
      .input('IP', SQL.NVarChar(45), ip)
      .input('Country', SQL.NVarChar(5), geo.country || null)
      .input('Region', SQL.NVarChar(100), geo.region || null)
      .input('City', SQL.NVarChar(100), geo.city || null)
      .input('Lat', SQL.Float, geo.ll ? geo.ll[0] : null)
      .input('Lon', SQL.Float, geo.ll ? geo.ll[1] : null)
      .input('UA_Raw', SQL.NVarChar(SQL.MAX), uaRaw)
      .input('UA_Hints', SQL.NVarChar(SQL.MAX), JSON.stringify({
        device: agent.device.toString(),
        os: agent.os.toString(),
        browser: agent.toAgent()
      }))
      .input('DeviceType', SQL.NVarChar(50), agent.device.toString())
      .input('OS', SQL.NVarChar(50), agent.os.toString())
      .input('Browser', SQL.NVarChar(50), agent.toAgent())
      .input('Lang', SQL.NVarChar(SQL.MAX), req.headers['accept-language'] || null)
      .input('Referer', SQL.NVarChar(SQL.MAX), req.headers['referer'] || null)
      .input('UTM', SQL.NVarChar(SQL.MAX), UTM || null)  // Use UTM from QR_Target table
      .input('Is_Prefetch', SQL.Bit, req.headers['x-moz'] === 'prefetch' || req.headers['purpose'] === 'prefetch' ? 1 : 0)
      .query(`
        INSERT INTO dbo.[QR_Scan]
        (QR_Code_Id, Target_Id, OccurredAt, IP, Country, Region, City, Lat, Lon, UA_Raw, UA_Hints, DeviceType, OS, Browser, Lang, Referer, UTM, Is_Prefetch)
        VALUES
        (@QR_Code_Id, @Target_Id, @OccurredAt, @IP, @Country, @Region, @City, @Lat, @Lon, @UA_Raw, @UA_Hints, @DeviceType, @OS, @Browser, @Lang, @Referer, @UTM, @Is_Prefetch)
      `).catch(console.error); // log errors but don't block redirect

    // Redirect immediately
    return reply.redirect(Url);
  });

}
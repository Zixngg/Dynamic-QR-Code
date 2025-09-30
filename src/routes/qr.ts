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
  const token = (req.cookies?.at as string) || '';
  if (!token) throw new Error('Unauthorized');
  try {
    const user = verifyAccess(token);
    return user;
  } catch {
    throw new Error('Unauthorized');
  }
}

function injectLogoIntoSvg(svg: string, logoHref: string, logoSizePct: number, debug: boolean, bg: string, fg: string): string {
  const logoSize = Math.max(10, Math.min(40, logoSizePct));
  const logoX = 50 - logoSize / 2;
  const logoY = 50 - logoSize / 2;
  
  // Find the viewBox and extract dimensions
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  if (!viewBoxMatch) {
    console.warn('No viewBox found in SVG, skipping logo injection');
    return svg;
  }
  
  const viewBoxParts = viewBoxMatch[1].split(/\s+/).map(Number);
  if (viewBoxParts.length < 4) {
    console.warn('Invalid viewBox format:', viewBoxMatch[1]);
    return svg;
  }
  
  const [, , width, height] = viewBoxParts;
  if (!width || !height || isNaN(width) || isNaN(height)) {
    console.warn('Invalid viewBox dimensions:', { width, height });
    return svg;
  }
  
  const logoSizePx = (height * logoSize) / 100;
  const logoXpx = (height * logoX) / 100;
  const logoYpx = (height * logoY) / 100;
  
  // Add white background circle/rect behind logo
  const bgElement = debug 
    ? `<rect x="${logoXpx - logoSizePx * 0.1}" y="${logoYpx - logoSizePx * 0.1}" width="${logoSizePx * 1.2}" height="${logoSizePx * 1.2}" fill="${bg}" stroke="${fg}" stroke-width="1"/>`
    : `<circle cx="${logoXpx + logoSizePx/2}" cy="${logoYpx + logoSizePx/2}" r="${logoSizePx * 0.6}" fill="${bg}"/>`;
  
  // Add logo image
  const logoElement = `<image href="${logoHref}" x="${logoXpx}" y="${logoYpx}" width="${logoSizePx}" height="${logoSizePx}"/>`;
  
  // Insert before closing </svg>
  return svg.replace('</svg>', `${bgElement}${logoElement}</svg>`);
}

function getSingaporeRegion(lat: number, lon: number): string | null {
  // Singapore bounding box
  const singaporeBounds = {
    north: 1.478,
    south: 1.149,
    east: 104.1,
    west: 103.6
  };

  if (lat >= singaporeBounds.south && lat <= singaporeBounds.north &&
      lon >= singaporeBounds.west && lon <= singaporeBounds.east) {
    return 'Singapore';
  }

  return 'Singapore';
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
  // ---------- Generic QR Preview (for generation form) ----------
  app.get('/qr/preview', async (req, reply) => {
    const query = req.query as any;
    const debug = query?.debug === '1';

    console.log('Preview request received:', query);

    const fg = query.fg || '#0b3d91';
    const bg = query.bg || '#ffffff';
    const ecMap: any = { L: 'low', M: 'medium', Q: 'quartile', H: 'high' };
    const errorCorrectionLevel = ecMap[(query.ec || 'M')] || 'medium';
    const logoUrl = query.logoUrl || '';
    const logoSizePct = Number(query.logoSizePct || 22);
    const previewUrl = query.url || 'https://example.com/preview';

    const content = previewUrl;

    try {
      console.log('Generating QR with:', { fg, bg, errorCorrectionLevel, logoUrl: logoUrl ? 'present' : 'none', logoSizePct, content });

    let svg = await QRCode.toString(content, {
      type: 'svg',
      color: { dark: fg, light: bg },
      errorCorrectionLevel,
      margin: 2,
      width: 512
    });

    if (logoUrl) {
        const href = await resolveLogoHref(logoUrl);
        if (href) svg = injectLogoIntoSvg(svg, href, logoSizePct, debug, bg, fg);
    }

      console.log('QR generated successfully, SVG length:', svg.length);
    reply.header('Content-Type', 'image/svg+xml').send(svg);
    } catch (error) {
      console.error('Preview generation failed:', error);
      return reply.code(500).send('Preview generation failed');
    }
  });

  // ---------- Live preview (SVG) ----------
  app.get('/qr/:slug/preview', async (req, reply) => {
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

    try {
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
    } catch (error) {
      console.error('SVG generation failed:', error);
      return reply.code(500).send('SVG generation failed');
    }
  });

  // ---------- Create QR Code ----------
  app.post('/qr/create', async (req, reply) => {
    let user: AccessPayload;
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.redirect('/login.html');
    }

    const body = req.body as any;
    const name = String(body.name || '').trim();
    const url = String(body.url || '').trim();

    if (!name || !url) {
      return reply.redirect('/generateQR.html?error=Name+and+URL+are+required');
    }

    try {
      const pool = await getPool();

      // Handle UTM parameters
      const utmSource = String(body.utm_source || '').trim();
      const utmMedium = String(body.utm_medium || '').trim();
      const utmCampaign = String(body.utm_campaign || '').trim();

      const utmData = JSON.stringify({
        utm_source: utmSource || null,
        utm_medium: utmMedium || null,
        utm_campaign: utmCampaign || null
      });

      // Handle custom slug from form
      let slug = String(body.slug || '').trim();
      
      // If no custom slug provided, generate a random one
      if (!slug) {
        slug = Math.random().toString(36).substring(2, 9);
      } else {
        // Validate custom slug format
        if (!/^[a-zA-Z0-9\-]+$/.test(slug)) {
          throw new Error('Slug can only contain letters, numbers, and hyphens');
        }
        if (slug.length < 3 || slug.length > 50) {
          throw new Error('Slug must be between 3 and 50 characters');
        }
        if (slug.startsWith('-') || slug.endsWith('-')) {
          throw new Error('Slug cannot start or end with a hyphen');
        }
        
        // Check if slug is already taken
        const existingSlug = await pool.request()
          .input('slug', SQL.NVarChar(64), slug)
          .query('SELECT TOP 1 Id FROM dbo.[QR_Code] WHERE Slug=@slug');
        
        if (existingSlug.recordset.length > 0) {
          throw new Error('This custom short link is already taken. Please choose a different one.');
        }
      }

      // capture design from form selections (fallbacks match UI defaults)
      const fg = String(body.fg || '#0b3d91');
      const bg = String(body.bg || '#ffffff');
      const ec = String(body.ec || 'M').toUpperCase();
      const format = String(body.format || 'svg').toLowerCase();
      const rawLogoUrl = String(body.logoUrl || '').trim();
      const logoUrl = rawLogoUrl.length ? rawLogoUrl : null;
      const logoSizePct = Math.max(10, Math.min(40, Number(body.logoSizePct || 22)));

      const design = JSON.stringify({ fg, bg, ec, format, logoUrl, logoSizePct });
      
      // parse tags from form data
      console.log('Raw tags from form:', body.tags);
      const tags = body.tags ? JSON.parse(body.tags) : [];
      console.log('Parsed tags:', tags);
      const tagsJson = JSON.stringify(tags);

      // insert QR code with design and tags
      const qrIns = await pool.request()
        .input('uid', SQL.UniqueIdentifier, user.sub)
        .input('name', SQL.NVarChar(200), name)
        .input('slug', SQL.NVarChar(64), slug)
        .input('design', SQL.NVarChar(SQL.MAX), design)
        .input('tags', SQL.NVarChar(SQL.MAX), tagsJson)
        .query(`
          INSERT INTO dbo.[QR_Code] (User_Id, Name, Slug, Design, Tags)
          OUTPUT inserted.Id
          VALUES (@uid, @name, @slug, @design, @tags);
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

      // link QR code to this target
      await pool.request()
        .input('qid', SQL.UniqueIdentifier, qrId)
        .input('tid', SQL.UniqueIdentifier, targetId)
        .query('UPDATE dbo.[QR_Code] SET CurrentTargetId=@tid WHERE Id=@qid');

      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&success=QR+Code+created`);
    } catch (error) {
      console.error('QR creation failed:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return reply.redirect(`/generateQR.html?error=${encodeURIComponent(errorMsg)}`);
    }
  });

  // ---------- Update Target URL/UTM ----------
  app.post('/qr/:slug/retarget', async (req, reply) => {
    let user: AccessPayload;
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.redirect('/login.html');
    }

    const { slug } = req.params as any;
    const body = req.body as any;
    const url = String(body.url || '').trim();

    if (!url) {
      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=URL+is+required`);
    }

    try {
      const pool = await getPool();
      
      // Handle UTM parameters
      const utmSource = String(body.utm_source || '').trim();
      const utmMedium = String(body.utm_medium || '').trim();
      const utmCampaign = String(body.utm_campaign || '').trim();

      const utmData = JSON.stringify({
        utm_source: utmSource || null,
        utm_medium: utmMedium || null,
        utm_campaign: utmCampaign || null
      });

      // Get current target ID
      const currentTarget = await pool.request()
        .input('slug', SQL.NVarChar(64), slug)
        .input('uid', SQL.UniqueIdentifier, user.sub)
        .query('SELECT TOP 1 CurrentTargetId FROM dbo.[QR_Code] WHERE Slug=@slug AND User_Id=@uid');

      if (!currentTarget.recordset.length) {
        return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=Not+found`);
      }

      const currentTargetId = currentTarget.recordset[0].CurrentTargetId;

      // Update the existing target instead of creating a new one
      await pool.request()
        .input('targetId', SQL.UniqueIdentifier, currentTargetId)
        .input('url', SQL.NVarChar(2048), url)
        .input('utm', SQL.NVarChar(SQL.MAX), utmData)
        .query('UPDATE dbo.[QR_Target] SET Url=@url, UTM=@utm WHERE Id=@targetId');

      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&success=Target+updated`);
    } catch (error) {
      console.error('Target update failed:', error);
      return reply.redirect(`/editQR.html?slug=${encodeURIComponent(slug)}&error=Update+failed`);
    }
  });

  // ---------- Update Design ----------
  app.post('/qr/:slug/design', async (req, reply) => {
    let user: AccessPayload;
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.redirect('/login.html');
    }

    const { slug } = req.params as any;
    const body = req.body as any;

    const fg = String(body.fg || '#0b3d91');
    const bg = String(body.bg || '#ffffff');
    const ec = String(body.ec || 'M').toUpperCase();
    const rawLogoUrl = String(body.logoUrl || '').trim();
    
    // decode if client pre-encoded the data URL to survive x-www-form-urlencoded
    const decodedLogo = rawLogoUrl.startsWith('data:') ? rawLogoUrl : decodeURIComponent(rawLogoUrl);
    const logoUrl = decodedLogo && decodedLogo.length ? decodedLogo : null;
    const logoSizePct = Math.max(10, Math.min(40, Number(body.logoSizePct || 22)));

    const design = JSON.stringify({ fg, bg, ec, logoUrl, logoSizePct });

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
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.redirect('/login.html');
    }

    const { slug } = req.params as any;

    try {
    const pool = await getPool();
    await pool.request()
        .input('uid', SQL.UniqueIdentifier, user.sub)
      .input('slug', SQL.NVarChar(64), slug)
        .query('UPDATE dbo.[QR_Code] SET Archived=1 WHERE Slug=@slug AND User_Id=@uid');

      return reply.redirect('/qr.html?success=QR+Code+deleted');
    } catch (error) {
      console.error('Delete failed:', error);
      return reply.redirect('/qr.html?error=Delete+failed');
    }
  });

  // ---------- Get User's QR Codes List ----------
  app.get('/api/my/qr', async (req, reply) => {
    let user: AccessPayload;
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.code(401).send('Unauthorized');
    }

    try {
      const pool = await getPool();
      console.log('Fetching QR codes for user:', user.sub);
      
      const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, user.sub)
        .query(`
          SELECT c.Name, c.Slug, c.CreatedAt, c.Tags
          FROM dbo.[QR_Code] c
          WHERE c.User_Id = @uid AND c.Archived = 0
          ORDER BY c.CreatedAt DESC
        `);

      console.log('QR codes found:', r.recordset.length);
      return reply.send(r.recordset);
    } catch (error) {
      console.error('QR list fetch failed:', error);
      return reply.code(500).send('Failed to fetch QR codes');
    }
  });

  // ---------- Update QR Name/Slug ----------
  app.post('/api/qr/:slug/update', async (req, reply) => {
    let user: AccessPayload;
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.code(401).send('Unauthorized');
    }

    const { slug } = req.params as any;
    const { name, slug: newSlug } = req.body as any;

    try {
      const pool = await getPool();

      // Check if QR exists and belongs to user
      const checkResult = await pool.request()
        .input('slug', SQL.NVarChar, slug)
        .input('uid', SQL.UniqueIdentifier, user.sub)
        .query(`
          SELECT Id FROM dbo.[QR_Code] 
          WHERE Slug = @slug AND User_Id = @uid AND Archived = 0
        `);

      if (!checkResult.recordset.length) {
        return reply.code(404).send('QR code not found');
      }

      // If updating slug, check if new slug is unique
      if (newSlug && newSlug !== slug) {
        const slugCheck = await pool.request()
          .input('newSlug', SQL.NVarChar, newSlug)
          .input('uid', SQL.UniqueIdentifier, user.sub)
          .query(`
            SELECT Id FROM dbo.[QR_Code] 
            WHERE Slug = @newSlug AND User_Id = @uid AND Archived = 0
          `);

        if (slugCheck.recordset.length > 0) {
          return reply.code(409).send('Slug already exists');
        }
      }

      // Build update query
      const updates: string[] = [];
      const inputs: any = { 
        uid: { type: SQL.UniqueIdentifier, value: user.sub }, 
        originalSlug: { type: SQL.NVarChar, value: slug } 
      };

      if (name) {
        updates.push('Name = @name');
        inputs.name = { type: SQL.NVarChar, value: name };
      }

      if (newSlug) {
        updates.push('Slug = @newSlug');
        inputs.newSlug = { type: SQL.NVarChar, value: newSlug };
      }

      const body = req.body as any;
      if (body.tags !== undefined) {
        console.log('Raw tags from update:', body.tags);
        const tags = Array.isArray(body.tags) ? body.tags : [];
        console.log('Processed tags for update:', tags);
        updates.push('Tags = @tags');
        inputs.tags = { type: SQL.NVarChar(SQL.MAX), value: JSON.stringify(tags) };
      }

      if (updates.length === 0) {
        return reply.code(400).send('No updates provided');
      }

      const updateQuery = `
        UPDATE dbo.[QR_Code] 
        SET ${updates.join(', ')}
        WHERE Slug = @originalSlug AND User_Id = @uid AND Archived = 0
      `;

      const request = pool.request();
      Object.keys(inputs).forEach(key => {
        request.input(key, inputs[key].type, inputs[key].value);
      });

      await request.query(updateQuery);

      return reply.send({ success: true });
    } catch (error) {
      console.error('QR update failed:', error);
      return reply.code(500).send('Update failed');
    }
  });

  // ---------- Get QR Data for Edit Page ----------
  app.get('/qr/:slug/data', async (req, reply) => {
    let user: AccessPayload;
    try {
      user = getUserOrThrow(req);
    } catch {
      return reply.code(401).send('Unauthorized');
    }

    const { slug } = req.params as any;

    try {
    const pool = await getPool();
    const r = await pool.request()
        .input('slug', SQL.NVarChar(64), slug)
      .input('uid', SQL.UniqueIdentifier, user.sub)
      .query(`
          SELECT TOP 1 c.Name, c.Slug, c.Design, c.Tags, t.Url, t.UTM
          FROM dbo.[QR_Code] c
          INNER JOIN dbo.[QR_Target] t ON c.CurrentTargetId = t.Id
          WHERE c.Slug = @slug AND c.User_Id = @uid AND c.Archived = 0
        `);

      if (!r.recordset.length) {
        return reply.code(404).send('Not found');
      }

      const { Name, Slug, Design, Tags, Url, UTM } = r.recordset[0];
      const design = JSON.parse(Design || '{}');
      const utm = JSON.parse(UTM || '{}');

      console.log('QR data from database:', {
        Name,
        Slug,
        Tags,
        TagsType: typeof Tags
      });

      return reply.send({
        Name,
        Slug,
        Url,
        Design: design,
        Tags: Tags,
        UTM: utm
      });
    } catch (error) {
      console.error('Data fetch failed:', error);
      return reply.code(500).send('Data fetch failed');
    }
  });

  // ---------- Serve QR as SVG ----------
  app.get('/qr/:slug/svg', async (req, reply) => {
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

    try {
    let svg = await QRCode.toString(content, {
      type: 'svg',
      color: { dark: fg, light: bg },
      errorCorrectionLevel,
      margin: 2,
      width: 512
    });

    const href = design.logoUrl ? await resolveLogoHref(design.logoUrl) : '';
    if (href) svg = injectLogoIntoSvg(svg, href, Number(design.logoSizePct) || 22, debug, bg, fg);

      reply.header('Content-Type', 'image/svg+xml')
          .header('Content-Disposition', `attachment; filename="${slug}.svg"`)
          .send(svg);
    } catch (error) {
      console.error('SVG generation failed:', error);
      return reply.code(500).send('SVG generation failed');
    }
  });

  // ---------- Redirect to target URL ----------
  app.get('/r/:slug', async (req, reply) => {
    const { slug } = req.params as any;
    const userAgent = req.headers['user-agent'] || '';
    const ip = req.ip || req.socket.remoteAddress || '';

  const pool = await getPool();
    const r = await pool.request()
    .input('slug', SQL.NVarChar(64), slug)
    .query(`
        SELECT TOP 1 t.Url, t.UTM, c.Name, c.Tags
        FROM dbo.[QR_Code] c
        INNER JOIN dbo.[QR_Target] t ON c.CurrentTargetId = t.Id
        WHERE c.Slug = @slug AND c.Archived = 0
      `);
    
    if (!r.recordset.length) {
      return reply.code(404).send('QR Code not found');
    }

    const { Url, UTM, Name } = r.recordset[0];
    let finalUrl = Url;

    // Parse UTM parameters if they exist
    if (UTM) {
      try {
        const utmParams = JSON.parse(UTM);
        const urlObj = new URL(Url);
        
        if (utmParams.utm_source) urlObj.searchParams.set('utm_source', utmParams.utm_source);
        if (utmParams.utm_medium) urlObj.searchParams.set('utm_medium', utmParams.utm_medium);
        if (utmParams.utm_campaign) urlObj.searchParams.set('utm_campaign', utmParams.utm_campaign);
        
        finalUrl = urlObj.toString();
      } catch (error) {
        console.error('UTM parsing failed:', error);
      }
    }

    // Log the click
    try {
      const agent = useragent.parse(userAgent);
      const geo = geoip.lookup(ip);
      
      await pool.request()
        .input('slug', SQL.NVarChar(64), slug)
        .input('ip', SQL.NVarChar(45), ip)
        .input('userAgent', SQL.NVarChar(500), userAgent)
        .input('browser', SQL.NVarChar(100), agent.family)
        .input('os', SQL.NVarChar(100), agent.os.family)
        .input('device', SQL.NVarChar(100), agent.device.family)
        .input('country', SQL.NVarChar(100), geo?.country || 'Unknown')
        .input('region', SQL.NVarChar(100), geo?.region || 'Unknown')
        .input('city', SQL.NVarChar(100), geo?.city || 'Unknown')
        .query(`
          INSERT INTO dbo.[QR_Click] (QR_Code_Slug, IP, UserAgent, Browser, OS, Device, Country, Region, City, ClickedAt)
          VALUES (@slug, @ip, @userAgent, @browser, @os, @device, @country, @region, @city, GETDATE())
        `);
    } catch (error) {
      console.error('Click logging failed:', error);
    }

    return reply.redirect(Url);
  });

  // Get QR code name for dashboard filter
  app.get<{ Params: { userId: string } }>('/api/user/:userId/qrcodes', async (req, reply) => {
    const { userId } = req.params; // Now TypeScript knows userId exists
    const pool = await getPool();

    const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, userId)
      .query(`
        SELECT CAST(Id AS NVARCHAR(36)) AS __value, Name AS __text
        FROM dbo.QR_Code
        WHERE User_Id = @uid
        UNION
        SELECT 'all' AS __value, 'All QR Codes' AS __text
      `);

    reply.send(r.recordset);
  });

  // CSV export
  app.get('/api/export/scans', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const { qrCodeId, from, to } = req.query as any;
    const pool = await getPool();

    // Build the query with proper column names and joins
    let query = `
      SELECT 
        s.OccurredAt,
        q.Name AS QRName,
        s.Country,
        s.Region,
        s.City,
        s.IP,
        s.DeviceType,
        s.OS,
        s.Browser,
        s.Referer,
        q.Slug AS QRSlug,
        t.Url AS TargetUrl
      FROM dbo.[QR_Scan] s
      INNER JOIN dbo.[QR_Code] q ON s.QR_Code_Id = q.Id
      INNER JOIN dbo.[QR_Target] t ON s.Target_Id = t.Id
      WHERE q.User_Id = @uid
    `;

    const request = pool.request().input('uid', SQL.UniqueIdentifier, user.sub);

    // Add QR code filter if specified
    if (qrCodeId && qrCodeId !== 'all') {
      query += ` AND q.Id = @qrid`;
      request.input('qrid', SQL.UniqueIdentifier, qrCodeId);
    }

    // Add date range filter if specified
    if (from && to) {
      query += ` AND s.OccurredAt BETWEEN @from AND @to`;
      request.input('from', SQL.DateTime2, new Date(parseInt(from)));
      request.input('to', SQL.DateTime2, new Date(parseInt(to)));
    }

    query += ` ORDER BY s.OccurredAt DESC`;

    try {
      const r = await request.query(query);

      if (!r.recordset || r.recordset.length === 0) {
        // Return empty CSV with headers if no data
        const csv = 'Id,OccurredAt,IP,Country,Region,City,DeviceType,OS,Browser,Referer,QRName,QRSlug,TargetUrl\n';
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', 'attachment; filename="scan-history.csv"');
        return reply.send(csv);
      }

      // Helper function to escape CSV values
      function escapeCsvValue(value: any): string {
        if (value === null || value === undefined) return '';
        const str = String(value);
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }

      // Get column headers from first record
      const headers = Object.keys(r.recordset[0]);
      const headerRow = headers.join(',');

      // Convert data rows to CSV format
      const dataRows = r.recordset.map(row => 
        headers.map(header => escapeCsvValue(row[header])).join(',')
      );

      const csv = headerRow + '\n' + dataRows.join('\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="scan-history.csv"');
      reply.send(csv);

    } catch (error) {
      console.error('CSV Export Error:', error);
      reply.code(500).send({ error: 'Failed to export data' });
    }
  });

  // Get first scan date for user
  app.get('/api/user/:userId/first-scan-date', async (req, reply) => {
    let user: AccessPayload;
    try { user = getUserOrThrow(req); }
    catch { return reply.code(401).send({ error: 'unauthorized' }); }

    const { userId } = req.params as any;
    
    // Verify the requested userId matches the authenticated user
    if (userId !== user.sub) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const pool = await getPool();
    const r = await pool.request()
      .input('uid', SQL.UniqueIdentifier, userId)
      .query(`
        SELECT MIN(s.OccurredAt) AS FirstScanDate
        FROM dbo.[QR_Scan] s
        INNER JOIN dbo.[QR_Code] q ON s.QR_Code_Id = q.Id
        WHERE q.User_Id = @uid AND s.Is_Prefetch = 0
      `);

    const firstScanDate = r.recordset[0]?.FirstScanDate;
    
    reply.send({ 
      firstScanDate: firstScanDate ? firstScanDate.toISOString() : null 
    });
  });

}
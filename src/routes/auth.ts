import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, SQL } from '../db';
import { hashPassword, verifyPassword, randomToken, sha256Hex } from '../lib/crypto';
import { signAccess } from '../lib/jwt';
import { env } from '../config';

const Signup = z.object({
  email: z.string()
    .trim()
    .min(1, { message: 'Email is required' })
    .email({ message: 'Enter a valid email' }),
  password: z.string()
    .min(8, { message: 'Password must be at least 8 characters' })
});

const Login = z.object({
  email: z.string()
    .trim()
    .min(1, { message: 'Email is required' })
    .email({ message: 'Enter a valid email' }),
  password: z.string()
    .min(8, { message: 'Password must be at least 8 characters' })
});

function cookieOpts(maxAgeSec: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: false, // true in production (HTTPS)
    path: '/',
    maxAge: maxAgeSec
    // no 'domain' for localhost; host-only cookies are more reliable
  };
}

export default async function authRoutes(app: FastifyInstance) {
  // SIGNUP (redirects back with messages)
  app.post('/auth/signup', async (req, reply) => {
    const parsed = Signup.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(e => e.message).join(', ');
      return reply.redirect(`/signup.html?error=${encodeURIComponent(msg)}`);
    }

    const { email, password } = parsed.data;
    const pool = await getPool();

    const exists = await pool.request()
      .input('email', SQL.NVarChar(320), email)
      .query('SELECT 1 FROM dbo.[User] WHERE Email=@email');
    if (exists.recordset.length) return reply.redirect('/signup.html?error=Email+already+used');

    const passHash = await hashPassword(password);
    await pool.request()
      .input('email', SQL.NVarChar(320), email)
      .input('hash',  SQL.NVarChar(300), passHash)
      .query('INSERT INTO dbo.[User] (Email, Password_Hash, Email_Verified) VALUES (@email, @hash, 1);');

    return reply.redirect('/login.html?success=Account+created,+please+log+in');
  });

  // LOGIN (sets cookies, redirects to dashboard)
  app.post('/auth/login', async (req, reply) => {
    // Optional: quick debug to see the parsed body in your server logs
    app.log.info({ body: req.body }, 'login form body');

    const parsed = Login.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(e => e.message).join(', ');
      return reply.redirect(`/login.html?error=${encodeURIComponent(msg)}`);
    }

    // Normalize inputs
    const email = parsed.data.email.toLowerCase();
    const password = parsed.data.password;

    const pool = await getPool();

    const u = await pool.request()
      .input('email', SQL.NVarChar(320), email)
      .query('SELECT TOP 1 Id, Email, Password_Hash FROM dbo.[User] WHERE Email=@email');

    // If user not found OR password mismatch -> same generic message
    if (!u.recordset.length) {
      return reply.redirect('/login.html?error=Invalid+email+or+password');
    }
    const user = u.recordset[0];

    const ok = await verifyPassword(user.Password_Hash, password);
    if (!ok) {
      return reply.redirect('/login.html?error=Invalid+email+or+password');
    }

    // Create refresh session row
    const rawRefresh = randomToken(32);
    const hash = sha256Hex(rawRefresh);
    const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 3600 * 1000);

    await pool.request()
      .input('uid',  SQL.UniqueIdentifier, user.Id)
      .input('hash', SQL.NVarChar(128), hash)
      .input('exp',  SQL.DateTime2, expiresAt)
      .query('INSERT INTO dbo.[Session] (User_Id, Refresh_Token_Hash, ExpiresAt) VALUES (@uid, @hash, @exp);');

    const at = signAccess({ sub: user.Id, email: user.Email });

    reply
      .setCookie('at', at,        { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: env.ACCESS_TTL_MIN * 60 })
      .setCookie('rt', rawRefresh,{ httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: env.REFRESH_TTL_DAYS * 24 * 3600 })
      .redirect('/dashboard.html'); 
  });

  // REFRESH (rotate)
  app.post('/auth/refresh', async (req, reply) => {
    const raw = (req.cookies?.rt as string) || '';
    if (!raw) return reply.code(401).send({ error: 'No refresh token' });

    const pool = await getPool();
    const hash = sha256Hex(raw);

    const s = await pool.request()
      .input('hash', SQL.NVarChar(128), hash)
      .query(`
        SELECT TOP 1 s.Id, s.User_Id, u.Email
        FROM dbo.[Session] s
        JOIN dbo.[User] u ON u.Id = s.User_Id
        WHERE s.Refresh_Token_Hash = @hash AND s.ExpiresAt > SYSUTCDATETIME()
      `);
    if (!s.recordset.length) return reply.code(401).send({ error: 'Invalid refresh token' });

    const sess = s.recordset[0];
    await pool.request().input('id', SQL.UniqueIdentifier, sess.Id)
      .query('DELETE FROM dbo.[Session] WHERE Id=@id;');

    const newRaw = randomToken(32);
    const newHash = sha256Hex(newRaw);
    const newExp = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 3600 * 1000);

    await pool.request()
      .input('uid',  SQL.UniqueIdentifier, sess.User_Id)
      .input('hash', SQL.NVarChar(128), newHash)
      .input('exp',  SQL.DateTime2, newExp)
      .query('INSERT INTO dbo.[Session] (User_Id, Refresh_Token_Hash, ExpiresAt) VALUES (@uid, @hash, @exp);');

    const newAt = signAccess({ sub: sess.User_Id, email: sess.Email });

    reply
      .setCookie('at', newAt, cookieOpts(env.ACCESS_TTL_MIN * 60))
      .setCookie('rt', newRaw, cookieOpts(env.REFRESH_TTL_DAYS * 24 * 3600))
      .send({ ok: true });
  });

  // LOGOUT
  app.post('/auth/logout', async (req, reply) => {
    const raw = (req.cookies?.rt as string) || '';
    if (raw) {
      const hash = sha256Hex(raw);
      const pool = await getPool();
      await pool.request().input('hash', SQL.NVarChar(128), hash)
        .query('DELETE FROM dbo.[Session] WHERE Refresh_Token_Hash=@hash;');
    }
    reply.clearCookie('at', { path: '/' }).clearCookie('rt', { path: '/' }).redirect('/login.html?success=Logged+out');
  });
}

import jwt from 'jsonwebtoken';
import { env } from '../config';

export type AccessPayload = { sub: string; email: string };

export function signAccess(p: AccessPayload) {
  return jwt.sign(p, env.JWT_SECRET, { expiresIn: `${env.ACCESS_TTL_MIN}m` });
}
export function verifyAccess(token: string): AccessPayload {
  return jwt.verify(token, env.JWT_SECRET) as AccessPayload;
}

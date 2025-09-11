import argon2 from 'argon2';
import crypto from 'node:crypto';

export async function hashPassword(plain: string) {
  return argon2.hash(plain, { type: argon2.argon2id, timeCost: 3, memoryCost: 64 * 1024 });
}
export async function verifyPassword(hash: string, plain: string) {
  return argon2.verify(hash, plain);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex'); // raw token to give client
}
export function sha256Hex(s: string) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); // stored in DB
}

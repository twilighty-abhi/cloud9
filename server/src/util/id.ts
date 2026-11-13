import { randomBytes } from 'node:crypto';

/** Short URL-safe random id with a prefix, e.g. q_Ab3x... */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

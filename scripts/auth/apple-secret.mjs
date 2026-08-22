#!/usr/bin/env node
/**
 * Generate the "Sign in with Apple" client secret Supabase needs.
 *
 * Apple does not issue a static secret: the secret is a JWT you sign yourself
 * with the .p8 key from Apple Developer → Keys, and Apple caps its lifetime at
 * six months. Supabase stores it as `external_apple_secret`. When it lapses,
 * ONLY Apple sign-in on the web breaks (native uses signInWithIdToken and
 * never needs the secret) — regenerate with this script and re-PATCH.
 *
 * Usage (nothing is printed except the JWT, so it can be piped):
 *   node scripts/auth/apple-secret.mjs \
 *     --key "C:\Durbin Enterprises\config\secrets\apple-signin-AuthKey_ZFPHJ32K5K.p8" \
 *     --key-id ZFPHJ32K5K --team-id E4B2Y6BWCH \
 *     --client-id com.dcsolarkc.fieldapp.web [--days 180]
 *
 * `--client-id` is the Services ID (the WEB client). The JWT's `sub` must equal
 * it exactly; the App ID is only listed in Supabase's client-id list.
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
    .filter(Boolean),
);

const required = ['key', 'key-id', 'team-id', 'client-id'];
for (const r of required) {
  if (!args[r]) {
    console.error(`missing --${r}`);
    process.exit(2);
  }
}
const days = Math.min(Number(args.days ?? 180), 182); // Apple's max is 6 months

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'ES256', kid: args['key-id'], typ: 'JWT' };
const payload = {
  iss: args['team-id'],
  iat: now,
  exp: now + days * 86400,
  aud: 'https://appleid.apple.com',
  sub: args['client-id'],
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
const key = createPrivateKey(readFileSync(args.key, 'utf8'));
// Apple/JWS want the raw r||s signature, not DER.
const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });

process.stdout.write(`${signingInput}.${b64url(signature)}`);

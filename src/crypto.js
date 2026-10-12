import crypto from 'node:crypto';

// AES-256-GCM for X tokens at rest. Output: iv.tag.ciphertext (base64url).
export function makeCipher(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return {
    encrypt(plain) {
      if (plain == null) return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
    },
    decrypt(packed) {
      if (packed == null) return null;
      const [iv, tag, body] = packed.split('.').map((s) => Buffer.from(s, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    },
  };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

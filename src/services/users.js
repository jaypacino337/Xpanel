import crypto from 'node:crypto';
import { audit } from '../db.js';
import { ValidationError } from './posts.js';

export const ROLES = ['admin', 'editor'];
const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new ValidationError('Passwords need at least 8 characters');
}

export function createUserService({ db }) {
  const publicFields = 'id, username, role, created_at';
  const get = (id) => db.prepare(`SELECT ${publicFields} FROM users WHERE id = ?`).get(id);
  const list = () => db.prepare(`SELECT ${publicFields} FROM users ORDER BY username`).all();

  // First start: create the "admin" user from PANEL_PASSWORD.
  function bootstrap(password) {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
    db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run('admin', hashPassword(password), 'admin', Date.now());
  }

  function authenticate(username, password) {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim().toLowerCase());
    // Hash anyway when the user is unknown so timing does not reveal which usernames exist.
    const ok = checkPassword(password ?? '', row?.pass_hash ?? hashPassword('x'));
    return ok && row ? get(row.id) : null;
  }

  function create({ username, password, role }) {
    const name = String(username ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) throw new ValidationError('Usernames are 2-32 characters: letters, numbers, . _ -');
    if (!ROLES.includes(role)) throw new ValidationError('Role must be admin or editor');
    validatePassword(password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw new ValidationError('That username is taken');
    const id = Number(db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hashPassword(password), role, Date.now()).lastInsertRowid);
    audit(db, 'user.created', `${name} (${role})`);
    return get(id);
  }

  function admins() {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  }

  function update(id, { role, password }) {
    const user = get(id);
    if (!user) throw new ValidationError('User not found');
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw new ValidationError('Role must be admin or editor');
      if (user.role === 'admin' && role !== 'admin' && admins() === 1) throw new ValidationError('Keep at least one admin');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (password !== undefined) {
      validatePassword(password);
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), id);
    }
    audit(db, 'user.updated', `${user.username}${role ? ` role=${role}` : ''}${password ? ' password changed' : ''}`);
    return get(id);
  }

  function remove(id) {
    const user = get(id);
    if (!user) throw new ValidationError('User not found');
    if (user.role === 'admin' && admins() === 1) throw new ValidationError('Keep at least one admin');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(db, 'user.deleted', user.username);
  }

  return { get, list, bootstrap, authenticate, create, update, remove };
}

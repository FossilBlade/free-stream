/**
 * Family profiles, the parent PIN, and age limits for kids' profiles.
 * FreeStream runs on the home network without accounts: the web app says which profile it is
 * (X-Profile header). The parent PIN guards Settings and profile management.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db, profileData, save, type MediaType, type Profile } from './store.ts';
import * as tmdb from './tmdb.ts';

export class ProfileError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

// --- which profile is asking ------------------------------------------------------------------

export function resolveProfile(id: string | undefined): Profile {
  const p = (id && db.profiles[id]) || Object.values(db.profiles).find((x) => x.kind === 'adult') || Object.values(db.profiles)[0];
  if (!p) throw new ProfileError('No profiles exist.', 500);
  return p;
}

export function profileMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.locals.profile = resolveProfile(req.get('x-profile') || undefined);
  next();
}

export const profileOf = (res: Response): Profile => res.locals.profile as Profile;
export const isKid = (res: Response) => profileOf(res).kind === 'kid';

/** Rejects requests from kids' profiles (source lists, downloads, settings…). */
export function adultsOnly(_req: Request, res: Response, next: NextFunction): void {
  if (isKid(res)) return next(new ProfileError('Not available on a kids’ profile.', 403, 'kids'));
  next();
}

// --- parent PIN -----------------------------------------------------------------------------

const hashPin = (pin: string, salt: string) => createHash('sha256').update(`${salt}:${pin}`).digest('hex');
export const hasPin = () => !!db.settings.parentPinHash;

function pinMatches(pin: string): boolean {
  const { parentPinHash, parentPinSalt } = db.settings;
  if (!parentPinHash || !parentPinSalt) return false;
  const a = Buffer.from(hashPin(pin, parentPinSalt), 'hex');
  const b = Buffer.from(parentPinHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const tokens = new Map<string, number>(); // token -> expiry
const TOKEN_TTL = 30 * 60 * 1000;
let failures = 0;
let lockedUntil = 0;

export function unlock(pin: string): string {
  if (Date.now() < lockedUntil) throw new ProfileError('Too many wrong PINs. Try again in a minute.', 429, 'locked');
  if (!pinMatches(String(pin))) {
    if (++failures >= 5) {
      lockedUntil = Date.now() + 60 * 1000;
      failures = 0;
    }
    throw new ProfileError('Wrong PIN.', 403, 'pin');
  }
  failures = 0;
  const token = randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL);
  return token;
}

export function isParent(req: Request): boolean {
  if (!hasPin()) return true; // no PIN set yet: everything is open (Settings prompts to create one)
  const t = req.get('x-parent-token');
  const exp = t ? tokens.get(t) : undefined;
  return !!exp && exp > Date.now();
}

/** Guards Settings and profile management. Kids' profiles are always refused. */
export function parentOnly(req: Request, res: Response, next: NextFunction): void {
  if (isKid(res)) return next(new ProfileError('Ask a parent to change settings.', 403, 'kids'));
  if (!isParent(req)) return next(new ProfileError('Enter the parent PIN.', 401, 'pin'));
  next();
}

export function setPin(req: Request, pin: string): void {
  if (hasPin() && !isParent(req)) throw new ProfileError('Enter the current parent PIN first.', 401, 'pin');
  if (!/^\d{4,8}$/.test(pin)) throw new ProfileError('The PIN must be 4 to 8 digits.');
  const salt = randomBytes(16).toString('hex');
  db.settings.parentPinSalt = salt;
  db.settings.parentPinHash = hashPin(pin, salt);
  tokens.clear();
  save();
}

// --- managing profiles ----------------------------------------------------------------------------

const COLORS = ['#2ec4b6', '#ffb547', '#f472b6', '#60a5fa', '#a78bfa', '#4ade80', '#f87171', '#facc15'];

export function cleanProfileInput(b: Partial<Profile>, existing?: Profile): Profile {
  const name = String(b.name ?? existing?.name ?? '').trim().slice(0, 24);
  if (!name) throw new ProfileError('Give the profile a name.');
  const kind = b.kind === 'kid' || b.kind === 'adult' ? b.kind : existing?.kind || 'adult';
  const maxAge = kind === 'kid' ? ([7, 12, 16].includes(Number(b.maxAge)) ? (Number(b.maxAge) as 7 | 12 | 16) : existing?.maxAge || 7) : undefined;
  const languages = Array.isArray(b.languages) ? b.languages.filter((l) => /^[a-z]{2}$/.test(l)).slice(0, 8) : existing?.languages || ['en', 'hi'];
  return {
    id: existing?.id || randomBytes(6).toString('hex'),
    name,
    color: typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : existing?.color || COLORS[Object.keys(db.profiles).length % COLORS.length],
    emoji: typeof b.emoji === 'string' ? [...b.emoji].slice(0, 2).join('') : existing?.emoji || '',
    kind,
    ...(maxAge ? { maxAge } : {}),
    languages: languages.length ? languages : ['en'],
    createdAt: existing?.createdAt || Date.now(),
  };
}

export function createProfile(b: Partial<Profile>): Profile {
  if (Object.keys(db.profiles).length >= 8) throw new ProfileError('Up to 8 profiles.');
  const p = cleanProfileInput(b);
  db.profiles[p.id] = p;
  profileData(p.id);
  save();
  return p;
}

export function updateProfile(id: string, b: Partial<Profile>): Profile {
  const existing = db.profiles[id];
  if (!existing) throw new ProfileError('No such profile.', 404);
  const p = cleanProfileInput(b, existing);
  const adultsLeft = Object.values(db.profiles).filter((x) => x.kind === 'adult' && x.id !== id).length;
  if (p.kind === 'kid' && !adultsLeft) throw new ProfileError('Keep at least one adult profile.');
  db.profiles[id] = p;
  save();
  return p;
}

export function deleteProfile(id: string): void {
  const p = db.profiles[id];
  if (!p) throw new ProfileError('No such profile.', 404);
  if (p.kind === 'adult' && Object.values(db.profiles).filter((x) => x.kind === 'adult').length <= 1) throw new ProfileError('Keep at least one adult profile.');
  delete db.profiles[id];
  delete db.profileData[id];
  save();
}

// --- age limits -------------------------------------------------------------------------------

const RATING_TTL = 14 * 24 * 3600 * 1000;

/** Age rating for a title, cached on disk (each title is looked up once a fortnight). */
export async function ageOf(type: MediaType, id: number): Promise<number | null> {
  const key = `${type}:${id}`;
  const hit = db.ratings[key];
  if (hit && Date.now() - hit.at < RATING_TTL) return hit.age;
  const age = await tmdb.ageRating(type, id).catch(() => undefined);
  if (age === undefined) return hit ? hit.age : null; // lookup failed: keep old value, else treat as unrated
  db.ratings[key] = { age, at: Date.now() };
  save();
  return age;
}

/** Adults see everything; kids only titles with a known rating within their limit. */
export async function allowed(profile: Profile, type: MediaType, id: number): Promise<boolean> {
  if (profile.kind !== 'kid') return true;
  const age = await ageOf(type, id);
  return age != null && age <= (profile.maxAge || 7);
}

/** Filters a list of titles for a profile (rating lookups run 8 at a time). */
export async function filterAllowed<T extends { mediaType: MediaType; id: number }>(profile: Profile, items: T[]): Promise<T[]> {
  if (profile.kind !== 'kid') return items;
  const ok: boolean[] = new Array(items.length).fill(false);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < items.length) {
        const i = next++;
        ok[i] = await allowed(profile, items[i].mediaType, items[i].id);
      }
    }),
  );
  return items.filter((_, i) => ok[i]);
}

export async function requireAllowed(res: Response, type: MediaType, id: number): Promise<void> {
  if (!(await allowed(profileOf(res), type, id))) throw new ProfileError('This title isn’t available on this profile.', 403, 'age');
}

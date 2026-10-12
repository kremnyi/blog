import type { MiddlewareHandler } from 'hono'
import { type AppEnv, type UserRow, fail, now, randomHex } from './core'

// The free plan gives 10 ms of CPU per request. Django's default 1M rounds would not fit,
// so the iteration count is stored in the hash and can go up after the first paycheck.
const ITERATIONS = 20_000

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)))

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations },
        key,
        256
    )
    return b64(bits)
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomHex(12)
    return `pbkdf2_sha256$${ITERATIONS}$${salt}$${await pbkdf2(password, salt, ITERATIONS)}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
    const [algo, iter, salt, expected] = encoded.split('$')
    if (algo !== 'pbkdf2_sha256' || !salt || !expected) return false
    const actual = new TextEncoder().encode(await pbkdf2(password, salt, Number(iter)))
    const wanted = new TextEncoder().encode(expected)
    return actual.length === wanted.length && crypto.subtle.timingSafeEqual(actual, wanted)
}

export async function issueToken(db: D1Database, userId: string): Promise<string> {
    const existing = await db.prepare('SELECT key FROM tokens WHERE user_id = ?').bind(userId).first<{ key: string }>()
    if (existing) return existing.key
    const key = randomHex(20)
    await db.prepare('INSERT INTO tokens (key, user_id, created_at) VALUES (?, ?, ?)').bind(key, userId, now()).run()
    return key
}

/** DRF TokenAuthentication: `Authorization: Token <key>`. A bad token is a 401 even on public endpoints. */
export const tokenAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set('user', null)
    const header = c.req.header('Authorization') ?? ''
    const [scheme, key] = header.split(' ')
    if (scheme?.toLowerCase() === 'token' && key) {
        const user = await c.env.DB.prepare(
            'SELECT users.* FROM tokens JOIN users ON users.id = tokens.user_id WHERE tokens.key = ?'
        )
            .bind(key)
            .first<UserRow>()
        if (!user) fail(401, { detail: 'Invalid token.' })
        c.set('user', user)
    }
    await next()
}

export async function hasActiveSubscription(db: D1Database, userId: string): Promise<boolean> {
    const row = await db
        .prepare(
            "SELECT 1 FROM subscriptions WHERE user_id = ? AND status = 'active' AND (valid_until IS NULL OR valid_until >= ?)"
        )
        .bind(userId, now())
        .first()
    return !!row
}

export async function canAccessPost(
    db: D1Database,
    user: UserRow | null,
    post: { id: number; is_paid: number; author_id: string },
    isSubscribed: () => Promise<boolean> = () => hasActiveSubscription(db, user!.id)
): Promise<boolean> {
    if (!post.is_paid) return true
    if (!user) return false
    if (post.author_id === user.id) return true
    if (await isSubscribed()) return true
    const bought = await db
        .prepare("SELECT 1 FROM post_purchases WHERE user_id = ? AND post_id = ? AND status = 'succeeded'")
        .bind(user.id, post.id)
        .first()
    return !!bought
}

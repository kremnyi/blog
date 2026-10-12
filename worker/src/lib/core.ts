import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

export interface Env {
    DB: D1Database
    MEDIA: KVNamespace
    ASSETS: Fetcher
    DEFAULT_FROM_EMAIL: string
}

export interface UserRow {
    id: string
    email: string
    password_hash: string
    first_name: string
    last_name: string
    bio: string
    profile_picture: string | null
    website: string
    is_admin: number
    date_joined: string
}

export type AppEnv = { Bindings: Env; Variables: { user: UserRow | null } }
export type Ctx = Context<AppEnv>

export const PAGE_SIZE = 10

export const now = (): string => new Date().toISOString()

export const randomHex = (bytes: number): string =>
    [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** DRF-style error: `fail(400, { email: ['This field is required.'] })`. */
export const fail = (status: number, body: Record<string, unknown>): never => {
    throw new HTTPException(status as 400, { res: Response.json(body, { status }) })
}

export const requireUser = (c: Ctx): UserRow =>
    c.get('user') ?? fail(401, { detail: 'Authentication credentials were not provided.' })

export const requireFound = <T>(row: T | null | undefined): T => row ?? fail(404, { detail: 'Not found.' })

export async function readJson(c: Ctx): Promise<Record<string, any>> {
    try {
        const body = await c.req.json()
        return body && typeof body === 'object' ? body : {}
    } catch {
        return {}
    }
}

/** Same envelope as DRF PageNumberPagination, so the React app does not notice the swap. */
export async function paginate<T>(
    c: Ctx,
    countSql: string,
    listSql: string,
    binds: unknown[],
    map: (rows: any[]) => Promise<T[]> | T[]
) {
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1)
    const total = (await c.env.DB.prepare(countSql).bind(...binds).first<{ n: number }>())?.n ?? 0
    if (page > 1 && (page - 1) * PAGE_SIZE >= total) fail(404, { detail: 'Invalid page.' })
    const { results } = await c.env.DB.prepare(`${listSql} LIMIT ? OFFSET ?`)
        .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all()
    const link = (p: number) => {
        const url = new URL(c.req.url)
        url.searchParams.set('page', String(p))
        return url.toString()
    }
    return {
        count: total,
        next: page * PAGE_SIZE < total ? link(page + 1) : null,
        previous: page > 1 ? link(page - 1) : null,
        results: await map(results),
    }
}

export function slugify(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[-\s_]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

export async function uniqueSlug(db: D1Database, table: 'posts' | 'categories', base: string): Promise<string> {
    const root = slugify(base) || randomHex(4)
    for (let i = 0; ; i++) {
        const slug = i === 0 ? root : `${root}-${i + 1}`
        const hit = await db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`).bind(slug).first()
        if (!hit) return slug
    }
}

export const asBool = (v: unknown): boolean => v === true || v === 1 || v === 'true' || v === '1' || v === 'on'

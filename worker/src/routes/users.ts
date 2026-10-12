import { Hono } from 'hono'
import { hashPassword, issueToken, verifyPassword } from '../lib/auth'
import { type AppEnv, type Ctx, type UserRow, fail, now, readJson, requireFound, requireUser } from '../lib/core'
import { userMe, userRead } from '../lib/serializers'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PROFILE_FIELDS = ['first_name', 'last_name', 'bio', 'website'] as const
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp']
const PREF_FIELDS = [
    'comment_on_post',
    'post_reaction',
    'payment_successful',
    'payment_failed',
    'subscription_activated',
    'subscription_expiring',
    'subscription_cancelled',
] as const

async function createUser(c: Ctx): Promise<UserRow> {
    const data = await readJson(c)
    const errors: Record<string, string[]> = {}
    const email = String(data.email ?? '').trim().toLowerCase()
    if (!email) errors.email = ['This field is required.']
    else if (!EMAIL_RE.test(email)) errors.email = ['Enter a valid email address.']
    if (!data.password) errors.password = ['This field is required.']
    else if (data.confirm_password !== undefined && data.password !== data.confirm_password)
        errors.password = ["Passwords don't match."]
    if (!errors.email && (await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()))
        errors.email = ['user with this email address already exists.']
    if (Object.keys(errors).length) fail(400, errors)

    const user: UserRow = {
        id: crypto.randomUUID(),
        email,
        password_hash: await hashPassword(String(data.password)),
        first_name: String(data.first_name ?? '').slice(0, 30),
        last_name: String(data.last_name ?? '').slice(0, 30),
        bio: '',
        profile_picture: null,
        website: '',
        is_admin: 0,
        date_joined: now(),
    }
    await c.env.DB.batch([
        c.env.DB.prepare(
            'INSERT INTO users (id, email, password_hash, first_name, last_name, date_joined) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(user.id, user.email, user.password_hash, user.first_name, user.last_name, user.date_joined),
        c.env.DB.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').bind(user.id),
    ])
    return user
}

/** /api/login/ */
export const auth = new Hono<AppEnv>()
    .post('/login', async (c) => {
        const data = await readJson(c)
        if (!data.email || !data.password) fail(400, { email: ['This field is required.'] })
        const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
            .bind(String(data.email).trim().toLowerCase())
            .first<UserRow>()
        if (!user || !(await verifyPassword(String(data.password), user.password_hash)))
            return c.json({ error: 'Invalid credentials' }, 401)
        return c.json({ token: await issueToken(c.env.DB, user.id), user: await userRead(c.env.DB, user) })
    })

async function preferences(c: Ctx) {
    const user = requireUser(c)
    if (c.req.method !== 'GET') {
        const data = await readJson(c)
        const fields = PREF_FIELDS.filter((f) => f in data)
        if (fields.length) {
            await c.env.DB.prepare(
                `INSERT INTO notification_preferences (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING`
            )
                .bind(user.id)
                .run()
            await c.env.DB.prepare(
                `UPDATE notification_preferences SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE user_id = ?`
            )
                .bind(...fields.map((f) => (data[f] ? 1 : 0)), user.id)
                .run()
        }
    }
    const row = await c.env.DB.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').bind(user.id).first()
    return c.json(Object.fromEntries(PREF_FIELDS.map((f) => [f, row ? !!row[f] : true])))
}

async function updateProfile(c: Ctx, user: UserRow) {
    const contentType = c.req.header('Content-Type') ?? ''
    const updates: Record<string, string | null> = {}
    let data: Record<string, unknown>
    if (contentType.startsWith('multipart/form-data')) {
        const form = await c.req.formData()
        data = Object.fromEntries(form.entries())
        const file = form.get('profile_picture')
        if (file && typeof file !== 'string') {
            if (file.size > 5 * 1024 * 1024) fail(400, { profile_picture: ['Image file size must be less than 5MB'] })
            if (!IMAGE_TYPES.includes(file.type))
                fail(400, { profile_picture: [`Invalid image type. Allowed types: ${IMAGE_TYPES.join(', ')}`] })
            // KV instead of S3: free, no credit card, and nobody has to mock it with LocalStack.
            const key = `profile_pics/${user.id}/${crypto.randomUUID()}`
            await c.env.MEDIA.put(key, await file.arrayBuffer(), { metadata: { type: file.type } })
            updates.profile_picture = `${new URL(c.req.url).origin}/media/${key}`
        }
    } else {
        data = await readJson(c)
        if ('profile_picture' in data && data.profile_picture === null) updates.profile_picture = null
    }
    for (const f of PROFILE_FIELDS) if (typeof data[f] === 'string') updates[f] = data[f] as string
    if (typeof data.password === 'string' && data.password) {
        if (data.confirm_password !== undefined && data.confirm_password !== data.password)
            fail(400, { password: ["Passwords don't match."] })
        updates.password_hash = await hashPassword(data.password)
    }
    const keys = Object.keys(updates)
    if (keys.length) {
        await c.env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
            .bind(...keys.map((k) => updates[k]), user.id)
            .run()
    }
    return requireFound(await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<UserRow>())
}

/** /api/v0/users/ */
export const users = new Hono<AppEnv>()
    .get('/me', async (c) => c.json(await userMe(c.env.DB, requireUser(c))))
    .patch('/me', async (c) => c.json(await userMe(c.env.DB, await updateProfile(c, requireUser(c)))))
    .post('/logout', async (c) => {
        await c.env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(requireUser(c).id).run()
        return c.body(null, 204)
    })
    .on(['GET', 'PUT', 'PATCH'], '/notification-preferences', preferences)
    .post('/', async (c) => {
        const user = await createUser(c)
        const { has_active_subscription: _, ...out } = await userRead(c.env.DB, user)
        return c.json(out, 201)
    })

export { preferences }

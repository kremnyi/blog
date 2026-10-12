import { Hono } from 'hono'
import { canAccessPost, hasActiveSubscription } from '../lib/auth'
import {
    type AppEnv,
    type Ctx,
    type UserRow,
    asBool,
    fail,
    now,
    paginate,
    randomHex,
    readJson,
    requireFound,
    requireUser,
    uniqueSlug,
} from '../lib/core'
import { notify } from '../lib/notify'
import {
    COMMENT_SELECT,
    POST_ORDER,
    POST_SELECT,
    categoryOut,
    commentOut,
    postDetail,
    postList,
} from '../lib/serializers'

const publishedPost = (c: Ctx, slug: string) =>
    c.env.DB.prepare(`${POST_SELECT} WHERE p.slug = ? AND p.is_published = 1`).bind(slug).first<any>()

const listPosts = (c: Ctx, where: string, binds: unknown[]) =>
    paginate(
        c,
        `SELECT COUNT(*) AS n FROM posts p WHERE ${where}`,
        `${POST_SELECT} WHERE ${where} ${POST_ORDER}`,
        binds,
        (rows) => postList(c.env.DB, c.get('user'), rows)
    )

const authorOf = (db: D1Database, id: string) =>
    db.prepare('SELECT id, email, first_name FROM users WHERE id = ?').bind(id).first<{ id: string; email: string; first_name: string }>()

/** Elasticsearch `multi_match` with `bool_prefix`, rebuilt as an FTS5 prefix query. */
function ftsQuery(q: string): string | null {
    const terms = q.match(/[\p{L}\p{N}_]+/gu)
    return terms?.length ? terms.map((t) => `"${t}"*`).join(' ') : null
}

/** /api/v0/ — public blog API */
export const posts = new Hono<AppEnv>()
    .get('/posts', (c) => listPosts(c, 'p.is_published = 1', []).then((r) => c.json(r)))
    .get('/posts/by_category', async (c) => {
        const slug = c.req.query('slug')
        if (!slug) return c.json({ error: 'Category slug is required' }, 400)
        const cat = requireFound(await c.env.DB.prepare('SELECT id FROM categories WHERE slug = ?').bind(slug).first<{ id: number }>())
        return c.json(await listPosts(c, 'p.is_published = 1 AND p.category_id = ?', [cat.id]))
    })
    .get('/posts/:slug', async (c) => {
        const post = requireFound(await publishedPost(c, c.req.param('slug')))
        return c.json(await postDetail(c.env.DB, c.get('user'), post))
    })
    .post('/posts/:slug/react', async (c) => {
        const user = requireUser(c)
        const { reaction_type } = await readJson(c)
        if (reaction_type !== 'like' && reaction_type !== 'dislike')
            fail(400, { reaction_type: [`"${reaction_type ?? ''}" is not a valid choice.`] })
        const post = requireFound(await c.env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(c.req.param('slug')).first<any>())
        const existing = await c.env.DB.prepare('SELECT id, reaction_type FROM reactions WHERE post_id = ? AND user_id = ?')
            .bind(post.id, user.id)
            .first<{ id: number; reaction_type: string }>()
        let action: 'added' | 'changed' | 'removed'
        if (existing && existing.reaction_type === reaction_type) {
            await c.env.DB.prepare('DELETE FROM reactions WHERE id = ?').bind(existing.id).run()
            action = 'removed'
        } else if (existing) {
            await c.env.DB.prepare('UPDATE reactions SET reaction_type = ? WHERE id = ?').bind(reaction_type, existing.id).run()
            action = 'changed'
        } else {
            await c.env.DB.prepare('INSERT INTO reactions (post_id, user_id, reaction_type, created_at) VALUES (?, ?, ?, ?)')
                .bind(post.id, user.id, reaction_type, now())
                .run()
            action = 'added'
            const author = await authorOf(c.env.DB, post.author_id)
            if (author) c.executionCtx.waitUntil(notify.reaction(c.env, author, post.title, user.email, reaction_type))
        }
        const counts = await c.env.DB.prepare(
            `SELECT SUM(reaction_type = 'like') AS likes, SUM(reaction_type = 'dislike') AS dislikes FROM reactions WHERE post_id = ?`
        )
            .bind(post.id)
            .first<{ likes: number | null; dislikes: number | null }>()
        return c.json({
            status: 'success',
            action,
            likes_count: counts?.likes ?? 0,
            dislikes_count: counts?.dislikes ?? 0,
            user_reaction: action === 'removed' ? null : reaction_type,
        })
    })
    .post('/posts/:slug/add-comment', async (c) => {
        const user = requireUser(c)
        const { body } = await readJson(c)
        if (typeof body !== 'string' || !body.trim()) fail(400, { body: ['This field may not be blank.'] })
        const post = requireFound(await c.env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(c.req.param('slug')).first<any>())
        const name = `${user.first_name} ${user.last_name}`.trim() || user.email
        const { meta } = await c.env.DB.prepare(
            'INSERT INTO comments (post_id, author_id, name, email, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
            .bind(post.id, user.id, name, user.email, body, now())
            .run()
        const comment = await c.env.DB.prepare(`${COMMENT_SELECT} WHERE cm.id = ?`).bind(meta.last_row_id).first()
        const author = await authorOf(c.env.DB, post.author_id)
        if (author) c.executionCtx.waitUntil(notify.comment(c.env, author, post.title, name, body))
        return c.json(commentOut(comment), 201)
    })
    .post('/posts/:slug/purchase', async (c) => {
        const user = requireUser(c)
        const post = requireFound(await c.env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(c.req.param('slug')).first<any>())
        if (!post.is_paid) return c.json({ error: 'Post is not paywalled.' }, 400)
        if (post.price_cents <= 0) return c.json({ error: 'Post is missing a valid price.' }, 400)
        if (await canAccessPost(c.env.DB, user, post)) return c.json({ status: 'already_owned' })

        const pending = await c.env.DB.prepare(
            `SELECT pp.id, pp.payment_id, pp.status, pay.client_secret FROM post_purchases pp
             JOIN payments pay ON pay.id = pp.payment_id
             WHERE pp.user_id = ? AND pp.post_id = ? AND pp.status = 'pending' ORDER BY pp.id DESC`
        )
            .bind(user.id, post.id)
            .first<any>()
        if (pending)
            return c.json({ purchase_id: pending.id, payment_id: pending.payment_id, client_secret: pending.client_secret, status: pending.status })

        const ts = now()
        const intent = `pi_${randomHex(12)}`
        const secret = `${intent}_secret_${randomHex(12)}`
        const payment = await c.env.DB.prepare(
            `INSERT INTO payments (user_id, post_id, amount, currency, stripe_payment_intent_id, client_secret, idempotency_key, created_at, updated_at)
             VALUES (?, ?, ?, 'usd', ?, ?, ?, ?, ?) RETURNING id`
        )
            .bind(user.id, post.id, post.price_cents, intent, secret, randomHex(16), ts, ts)
            .first<{ id: number }>()
        const purchase = await c.env.DB.prepare(
            'INSERT INTO post_purchases (user_id, post_id, payment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
        )
            .bind(user.id, post.id, payment!.id, ts, ts)
            .first<{ id: number }>()
        return c.json(
            { purchase_id: purchase!.id, payment_id: payment!.id, client_secret: secret, amount: post.price_cents, currency: 'usd', status: 'pending' },
            201
        )
    })
    .get('/categories', async (c) =>
        c.json(
            await paginate(c, 'SELECT COUNT(*) AS n FROM categories', 'SELECT * FROM categories ORDER BY name', [], (rows) =>
                rows.map(categoryOut)
            )
        )
    )
    .get('/categories/:slug', async (c) =>
        c.json(categoryOut(requireFound(await c.env.DB.prepare('SELECT * FROM categories WHERE slug = ?').bind(c.req.param('slug')).first())))
    )
    .get('/search', async (c) => {
        const q = (c.req.query('q') ?? '').slice(0, 255)
        if (!q.trim()) fail(400, { q: ['This field may not be blank.'] })
        const match = ftsQuery(q)
        if (!match) return c.json({ count: 0, next: null, previous: null, results: [] })
        const where = 'p.is_published = 1 AND p.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)'
        return c.json(await listPosts(c, where, [match]))
    })

// ---------------------------------------------------------------- /api/v0/manage/

async function requireWriter(c: Ctx): Promise<UserRow> {
    const user = requireUser(c)
    if (!user.is_admin && !(await hasActiveSubscription(c.env.DB, user.id)))
        fail(403, { detail: 'You do not have permission to perform this action.' })
    return user
}

function requireAdmin(c: Ctx): UserRow {
    const user = requireUser(c)
    if (!user.is_admin) fail(403, { detail: 'You do not have permission to perform this action.' })
    return user
}

/** The Django version let any subscriber edit or delete anyone's post. Authors and admins only here. */
async function ownedPost(c: Ctx) {
    const user = await requireWriter(c)
    const post = requireFound(await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(Number(c.req.param('id'))).first<any>())
    if (post.author_id !== user.id && !user.is_admin) fail(403, { detail: 'You do not have permission to perform this action.' })
    return post
}

const writeOut = (p: any) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    content: p.content,
    featured_image: p.featured_image,
    excerpt: p.excerpt,
    category: p.category_id,
    is_published: !!p.is_published,
    published_at: p.published_at,
    is_paid: !!p.is_paid,
    price_cents: p.price_cents,
})

async function savePost(c: Ctx, existing: any | null) {
    const user = c.get('user')!
    const data = await readJson(c)
    const partial = c.req.method === 'PATCH'
    const pick = <T>(key: string, fallback: T): T => (key in data ? data[key] : existing ? existing[key] : fallback)
    const errors: Record<string, string[]> = {}
    if (!partial || 'title' in data) if (!data.title?.toString().trim()) errors.title = ['This field is required.']
    if (!partial || 'content' in data) if (!data.content?.toString().trim()) errors.content = ['This field is required.']
    if (Object.keys(errors).length) fail(400, errors)

    const title = String(pick('title', '')).slice(0, 200)
    const categoryId = 'category' in data ? (data.category === null || data.category === '' ? null : Number(data.category)) : existing?.category_id ?? null
    if (categoryId !== null && !(await c.env.DB.prepare('SELECT 1 FROM categories WHERE id = ?').bind(categoryId).first()))
        fail(400, { category: [`Invalid pk "${categoryId}" - object does not exist.`] })

    let isPublished = asBool(pick('is_published', false))
    let publishedAt: string | null = pick('published_at', null)
    if (publishedAt) {
        const parsed = new Date(publishedAt)
        if (Number.isNaN(parsed.getTime())) fail(400, { published_at: ['Datetime has wrong format.'] })
        publishedAt = parsed.toISOString()
    }
    if (isPublished && !publishedAt) publishedAt = now()
    let priceCents = Math.max(0, Number.parseInt(String(pick('price_cents', 0)), 10) || 0)
    let isPaid = asBool(pick('is_paid', false))
    if (priceCents > 0) isPaid = true
    else if (!isPaid) priceCents = 0

    const ts = now()
    const row = {
        title,
        content: String(pick('content', '')),
        excerpt: String(pick('excerpt', '') ?? '').slice(0, 400),
        featured_image: pick<string | null>('featured_image', null) || null,
        category_id: categoryId,
        is_published: isPublished ? 1 : 0,
        published_at: publishedAt,
        is_paid: isPaid ? 1 : 0,
        price_cents: priceCents,
        updated_at: ts,
    }
    if (existing) {
        const cols = Object.keys(row)
        await c.env.DB.prepare(`UPDATE posts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
            .bind(...Object.values(row), existing.id)
            .run()
        return existing.id as number
    }
    const slug = await uniqueSlug(c.env.DB, 'posts', title)
    const created = await c.env.DB.prepare(
        `INSERT INTO posts (title, content, excerpt, featured_image, category_id, is_published, published_at, is_paid, price_cents, updated_at, slug, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
        .bind(...Object.values(row), slug, user.id, ts)
        .first<{ id: number }>()
    return created!.id
}

const postById = (c: Ctx, id: number) => c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(id).first<any>()

export const manage = new Hono<AppEnv>()
    .get('/posts', async (c) => {
        await requireWriter(c)
        return c.json(
            await paginate(c, 'SELECT COUNT(*) AS n FROM posts', `${POST_SELECT} ${POST_ORDER}`, [], (rows) =>
                postList(c.env.DB, c.get('user'), rows)
            )
        )
    })
    .post('/posts', async (c) => {
        await requireWriter(c)
        return c.json(writeOut(await postById(c, await savePost(c, null))), 201)
    })
    .get('/posts/:id', async (c) => c.json(await postDetail(c.env.DB, c.get('user'), await ownedPost(c))))
    .on(['PUT', 'PATCH'], '/posts/:id', async (c) => c.json(writeOut(await postById(c, await savePost(c, await ownedPost(c))))))
    .delete('/posts/:id', async (c) => {
        await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind((await ownedPost(c)).id).run()
        return c.body(null, 204)
    })
    .get('/categories', async (c) => {
        requireAdmin(c)
        return c.json(
            await paginate(c, 'SELECT COUNT(*) AS n FROM categories', 'SELECT * FROM categories ORDER BY name', [], (rows) =>
                rows.map(categoryOut)
            )
        )
    })
    .post('/categories', async (c) => {
        requireAdmin(c)
        const name = String((await readJson(c)).name ?? '').trim().slice(0, 120)
        if (!name) fail(400, { name: ['This field is required.'] })
        if (await c.env.DB.prepare('SELECT 1 FROM categories WHERE name = ?').bind(name).first())
            fail(400, { name: ['category with this name already exists.'] })
        const slug = await uniqueSlug(c.env.DB, 'categories', name)
        const row = await c.env.DB.prepare('INSERT INTO categories (name, slug) VALUES (?, ?) RETURNING *').bind(name, slug).first()
        return c.json(categoryOut(row), 201)
    })
    .get('/categories/:id', async (c) => {
        requireAdmin(c)
        return c.json(categoryOut(requireFound(await c.env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(Number(c.req.param('id'))).first())))
    })
    .on(['PUT', 'PATCH'], '/categories/:id', async (c) => {
        requireAdmin(c)
        const name = String((await readJson(c)).name ?? '').trim().slice(0, 120)
        if (!name) fail(400, { name: ['This field is required.'] })
        const row = await c.env.DB.prepare('UPDATE categories SET name = ? WHERE id = ? RETURNING *').bind(name, Number(c.req.param('id'))).first()
        return c.json(categoryOut(requireFound(row)))
    })
    .delete('/categories/:id', async (c) => {
        requireAdmin(c)
        await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(Number(c.req.param('id'))).run()
        return c.body(null, 204)
    })

import { canAccessPost, hasActiveSubscription } from './auth'
import type { UserRow } from './core'

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`

export const userBrief = (u: Pick<UserRow, 'id' | 'email' | 'first_name' | 'last_name'>) => ({
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    full_name: fullName(u),
})

export const emailOut = (e: any) => ({
    id: e.id,
    subject: e.subject,
    body: e.body,
    from_email: e.from_email,
    to_email: e.to_email,
    created_at: e.created_at,
    read: !!e.read,
})

export async function userMe(db: D1Database, u: UserRow) {
    return {
        ...userBrief(u),
        bio: u.bio,
        profile_picture: u.profile_picture,
        website: u.website,
        is_admin: !!u.is_admin,
        has_active_subscription: await hasActiveSubscription(db, u.id),
    }
}

export async function userRead(db: D1Database, u: UserRow) {
    const { results } = await db
        .prepare('SELECT * FROM emails WHERE user_id = ? ORDER BY created_at DESC')
        .bind(u.id)
        .all()
    return { ...(await userMe(db, u)), emails: results.map(emailOut) }
}

export const categoryOut = (c: any) => ({ id: c.id, name: c.name, slug: c.slug })

/** Every post query selects the same columns, so the serializers can trust the row shape. */
export const POST_SELECT = `
    SELECT p.*,
        u.email AS a_email, u.first_name AS a_first_name, u.last_name AS a_last_name,
        c.name AS c_name, c.slug AS c_slug,
        (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.reaction_type = 'like') AS likes_count,
        (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.reaction_type = 'dislike') AS dislikes_count
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN categories c ON c.id = p.category_id`

export const POST_ORDER = 'ORDER BY p.published_at IS NULL, p.published_at DESC, p.created_at DESC'

/** Asks D1 about the viewer's subscription at most once per request, not once per paid post. */
function subscriptionCheck(db: D1Database, viewer: UserRow | null) {
    let cached: Promise<boolean> | undefined
    return () => (cached ??= viewer ? hasActiveSubscription(db, viewer.id) : Promise.resolve(false))
}

async function viewerState(db: D1Database, viewer: UserRow | null, p: any, isSubscribed: () => Promise<boolean>) {
    const reaction = viewer
        ? await db
              .prepare('SELECT reaction_type FROM reactions WHERE post_id = ? AND user_id = ?')
              .bind(p.id, viewer.id)
              .first<{ reaction_type: string }>()
        : null
    const hasAccess = await canAccessPost(db, viewer, p, isSubscribed)
    return {
        user_reaction: reaction?.reaction_type ?? null,
        user_has_access: hasAccess,
        show_purchase_button: !!p.is_paid && !!viewer && p.author_id !== viewer.id && !hasAccess,
    }
}

function postBase(p: any) {
    return {
        id: p.id,
        title: p.title,
        slug: p.slug,
        excerpt: p.excerpt,
        author: userBrief({ id: p.author_id, email: p.a_email, first_name: p.a_first_name, last_name: p.a_last_name }),
        featured_image: p.featured_image,
        category: p.category_id ? { id: p.category_id, name: p.c_name, slug: p.c_slug } : null,
        created_at: p.created_at,
        published_at: p.published_at,
        likes_count: p.likes_count ?? 0,
        dislikes_count: p.dislikes_count ?? 0,
        is_paid: !!p.is_paid,
        price_cents: p.price_cents,
    }
}

export async function postList(db: D1Database, viewer: UserRow | null, rows: any[]) {
    const isSubscribed = subscriptionCheck(db, viewer)
    return Promise.all(
        rows.map(async (p) => {
            const { user_reaction, show_purchase_button } = await viewerState(db, viewer, p, isSubscribed)
            return { ...postBase(p), user_reaction, show_purchase_button }
        })
    )
}

export const commentOut = (c: any) => ({
    id: c.id,
    body: c.body,
    created_at: c.created_at,
    author: c.author_id,
    author_details: userBrief({ id: c.author_id, email: c.u_email, first_name: c.u_first_name, last_name: c.u_last_name }),
})

export const COMMENT_SELECT = `
    SELECT cm.*, u.email AS u_email, u.first_name AS u_first_name, u.last_name AS u_last_name
    FROM comments cm JOIN users u ON u.id = cm.author_id`

export async function postDetail(db: D1Database, viewer: UserRow | null, p: any) {
    const state = await viewerState(db, viewer, p, subscriptionCheck(db, viewer))
    const { results: comments } = await db
        .prepare(`${COMMENT_SELECT} WHERE cm.post_id = ? AND cm.is_approved = 1 ORDER BY cm.created_at`)
        .bind(p.id)
        .all()
    return {
        ...postBase(p),
        content: state.user_has_access ? p.content : null,
        updated_at: p.updated_at,
        comments: comments.map(commentOut),
        ...state,
    }
}

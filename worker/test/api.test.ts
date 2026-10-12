import { env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

async function api(path: string, token?: string, method = 'GET', body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Token ${token}`
    const res = await exports.default.fetch(`http://blog.test/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, data: res.status === 204 ? null : ((await res.json()) as any) }
}

async function signup(email: string): Promise<string> {
    await api('/v0/users/', undefined, 'POST', { email, password: 'pw', confirm_password: 'pw', first_name: 'T', last_name: 'U' })
    return (await api('/login/', undefined, 'POST', { email, password: 'pw' })).data.token
}

async function admin(email: string): Promise<string> {
    const token = await signup(email)
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').bind(email).run()
    return token
}

async function subscribe(token: string) {
    await api('/v0/subscriptions/', token, 'POST', { plan: 'day' })
    return api('/v0/subscriptions/confirm/', token, 'POST', {})
}

const newPost = (token: string, title: string, priceCents = 0) =>
    api('/v0/manage/posts/', token, 'POST', {
        title,
        content: '<p>secret</p>',
        is_published: true,
        is_paid: priceCents > 0,
        price_cents: priceCents,
    })

describe('paywall', () => {
    it('hides paid content until the reader buys the post', async () => {
        const author = await admin('author1@test.dev')
        const { data: post } = await newPost(author, 'Paid', 199)
        const reader = await signup('reader1@test.dev')

        let { data } = await api(`/v0/posts/${post.slug}/`, reader)
        expect([data.content, data.user_has_access, data.show_purchase_button]).toEqual([null, false, true])

        const purchase = await api(`/v0/posts/${post.slug}/purchase/`, reader, 'POST')
        expect(purchase.status).toBe(201)
        expect((await api(`/v0/payments/${purchase.data.payment_id}/confirm/`, reader, 'POST')).data.status).toBe('succeeded')

        ;({ data } = await api(`/v0/posts/${post.slug}/`, reader))
        expect([data.content, data.user_has_access, data.show_purchase_button]).toEqual(['<p>secret</p>', true, false])
        expect((await api(`/v0/posts/${post.slug}/purchase/`, reader, 'POST')).data.status).toBe('already_owned')
    })

    it('opens every paid post in a list for a subscriber', async () => {
        const author = await admin('author2@test.dev')
        for (const title of ['A', 'B', 'C']) await newPost(author, title, 100)
        const reader = await signup('reader2@test.dev')
        const buttons = async () =>
            (await api('/v0/posts/', reader)).data.results
                .filter((p: any) => p.author.email === 'author2@test.dev')
                .map((p: any) => p.show_purchase_button)

        expect(await buttons()).toEqual([true, true, true])
        await subscribe(reader)
        expect(await buttons()).toEqual([false, false, false])
    })
})

describe('manage posts', () => {
    it('lets only the author or an admin edit a post', async () => {
        const author = await signup('author3@test.dev')
        await subscribe(author)
        const { data: post } = await newPost(author, 'Mine')
        const other = await signup('other3@test.dev')
        await subscribe(other)

        expect((await api(`/v0/manage/posts/${post.id}/`, other, 'PATCH', { title: 'pwned' })).status).toBe(403)
        expect((await api(`/v0/manage/posts/${post.id}/`, other, 'DELETE')).status).toBe(403)
        expect((await api(`/v0/manage/posts/${post.id}/`, author, 'PATCH', { title: 'Still mine' })).data.title).toBe('Still mine')
    })
})

describe('subscriptions', () => {
    it('rejects Object.prototype keys as plans and keeps the active subscription', async () => {
        const reader = await signup('reader4@test.dev')
        await subscribe(reader)
        for (const plan of ['toString', 'constructor', '__proto__']) {
            expect((await api('/v0/subscriptions/', reader, 'POST', { plan })).status).toBe(400)
        }
        expect((await api('/v0/subscriptions/current/', reader)).data.status).toBe('active')
    })
})

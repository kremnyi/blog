// Kafka, a FastAPI microservice, two consumers, two producers and LocalStripe used to live here.
// The frontend already validates the (fake) test card itself, so "confirm" is now one transaction.
import { Hono } from 'hono'
import { type AppEnv, type Ctx, fail, now, paginate, randomHex, readJson, requireFound, requireUser } from '../lib/core'
import { notify } from '../lib/notify'
import { emailOut } from '../lib/serializers'

export const PLANS = {
    day: { key: 'day', label: 'Day Pass (24h)', price_cents: 399, currency: 'usd', duration_seconds: 86_400 },
    week: { key: 'week', label: 'Weekly Access', price_cents: 1299, currency: 'usd', duration_seconds: 604_800 },
    month: { key: 'month', label: 'Monthly Membership', price_cents: 2499, currency: 'usd', duration_seconds: 2_592_000 },
} as const
type PlanKey = keyof typeof PLANS

// Object.hasOwn: a plain PLANS[key] lookup accepts 'toString' and other Object.prototype keys.
const planFor = (key: string) => (Object.hasOwn(PLANS, key) ? PLANS[key as PlanKey] : undefined)

const fakeIntent = () => {
    const id = `pi_${randomHex(12)}`
    return { id, secret: `${id}_secret_${randomHex(12)}` }
}

const subscriptionOut = (s: any) => ({
    status: s.status,
    plan: s.plan,
    price_id: s.price_id,
    valid_until: s.valid_until,
    error_message: s.error_message,
})

const mySubscription = (c: Ctx, userId: string) =>
    c.env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ?').bind(userId).first<any>()

/** /api/v0/payments/ */
export const payments = new Hono<AppEnv>()
    .get('/:id', async (c) => {
        const user = requireUser(c)
        const p = requireFound(
            await c.env.DB.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').bind(Number(c.req.param('id')), user.id).first<any>()
        )
        return c.json({
            payment_id: p.id,
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            client_secret: p.client_secret,
            stripe_payment_intent_id: p.stripe_payment_intent_id,
            error_message: p.error_message,
        })
    })
    .post('/:id/confirm', async (c) => {
        const user = requireUser(c)
        const p = requireFound(
            await c.env.DB.prepare(
                `SELECT pay.*, posts.title AS post_title FROM payments pay LEFT JOIN posts ON posts.id = pay.post_id
                 WHERE pay.id = ? AND pay.user_id = ?`
            )
                .bind(Number(c.req.param('id')), user.id)
                .first<any>()
        )
        if (!['pending', 'requires_action', 'failed'].includes(p.status))
            return c.json({ error: `Payment cannot be confirmed (current status: ${p.status})` }, 400)
        const ts = now()
        const intent = p.stripe_payment_intent_id || fakeIntent().id
        await c.env.DB.batch([
            c.env.DB.prepare(
                "UPDATE payments SET status = 'succeeded', stripe_payment_intent_id = ?, error_message = '', updated_at = ? WHERE id = ?"
            ).bind(intent, ts, p.id),
            c.env.DB.prepare(
                "UPDATE post_purchases SET status = 'succeeded', access_granted_at = ?, updated_at = ? WHERE payment_id = ?"
            ).bind(ts, ts, p.id),
        ])
        c.executionCtx.waitUntil(notify.paymentSucceeded(c.env, user, p.post_title ?? 'your order', p.amount, p.currency))
        return c.json({ status: 'succeeded', payment_id: p.id })
    })

/** /api/v0/subscriptions/ */
export const subscriptions = new Hono<AppEnv>()
    .get('/plans', (c) => c.json(Object.values(PLANS)))
    .post('/', async (c) => {
        const user = requireUser(c)
        const planKey = String((await readJson(c)).plan ?? 'month')
        const plan = planFor(planKey) ?? fail(400, { plan: [`"${planKey}" is not a valid choice.`] })
        const ts = now()
        const key = randomHex(16)
        const intent = fakeIntent()
        const priceId = `plan_blog_${planKey}`
        const sub = await c.env.DB.prepare(
            `INSERT INTO subscriptions (user_id, price_id, plan, status, stripe_subscription_id, client_secret, idempotency_key, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET price_id = excluded.price_id, plan = excluded.plan, status = 'pending',
                stripe_subscription_id = excluded.stripe_subscription_id, client_secret = excluded.client_secret,
                idempotency_key = excluded.idempotency_key, error_message = '', updated_at = excluded.updated_at
             RETURNING id`
        )
            .bind(user.id, priceId, planKey, intent.id, intent.secret, key, ts, ts)
            .first<{ id: number }>()
        const payment = await c.env.DB.prepare(
            `INSERT INTO payments (user_id, subscription_id, payment_type, amount, currency, stripe_payment_intent_id, client_secret, idempotency_key, created_at, updated_at)
             VALUES (?, ?, 'subscription', ?, 'usd', ?, ?, ?, ?, ?) RETURNING id`
        )
            .bind(user.id, sub!.id, plan.price_cents, intent.id, intent.secret, key, ts, ts)
            .first<{ id: number }>()
        return c.json(
            { status: 'pending', plan: planKey, client_secret: intent.secret, amount: plan.price_cents, currency: 'usd', payment_id: payment!.id },
            201
        )
    })
    .get('/current', async (c) => {
        const sub = requireFound(await mySubscription(c, requireUser(c).id))
        return c.json(subscriptionOut(sub), ['error', 'incomplete_expired', 'canceled'].includes(sub.status) ? 400 : 200)
    })
    .post('/confirm', async (c) => {
        const user = requireUser(c)
        const sub = requireFound(await mySubscription(c, user.id))
        if (sub.status !== 'pending') return c.json({ error: 'Subscription is not pending' }, 400)
        const plan = planFor(sub.plan) ?? PLANS.month
        const ts = now()
        const validUntil = new Date(Date.now() + plan.duration_seconds * 1000).toISOString()
        await c.env.DB.batch([
            c.env.DB.prepare("UPDATE subscriptions SET status = 'active', valid_until = ?, updated_at = ? WHERE id = ?").bind(
                validUntil,
                ts,
                sub.id
            ),
            c.env.DB.prepare(
                `UPDATE payments SET status = 'succeeded', updated_at = ?
                 WHERE id = (SELECT id FROM payments WHERE subscription_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)`
            ).bind(ts, sub.id),
        ])
        c.executionCtx.waitUntil(notify.subscriptionActivated(c.env, user, sub.plan, validUntil))
        return c.json({ status: 'active' })
    })
    .post('/cancel', async (c) => {
        const user = requireUser(c)
        const sub = requireFound(await mySubscription(c, user.id))
        const ts = now()
        await c.env.DB.batch([
            c.env.DB.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?").bind(ts, sub.id),
            c.env.DB.prepare(
                `UPDATE payments SET status = 'canceled', updated_at = ?
                 WHERE id = (SELECT id FROM payments WHERE subscription_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)`
            ).bind(ts, sub.id),
        ])
        c.executionCtx.waitUntil(notify.subscriptionCancelled(c.env, user, sub.plan))
        return c.json({ status: 'canceled' })
    })

/** /api/v0/emails/ — the "email backend" was always a database table. */
export const emails = new Hono<AppEnv>()
    .get('/', async (c) => {
        const user = requireUser(c)
        return c.json(
            await paginate(
                c,
                'SELECT COUNT(*) AS n FROM emails WHERE user_id = ?',
                'SELECT * FROM emails WHERE user_id = ? ORDER BY created_at DESC, id DESC',
                [user.id],
                (rows) => rows.map(emailOut)
            )
        )
    })
    .get('/:id', async (c) => {
        const user = requireUser(c)
        const row = await c.env.DB.prepare('UPDATE emails SET read = 1 WHERE id = ? AND user_id = ? RETURNING *')
            .bind(Number(c.req.param('id')), user.id)
            .first()
        return c.json(emailOut(requireFound(row)))
    })
    .delete('/:id', async (c) => {
        const user = requireUser(c)
        const { meta } = await c.env.DB.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?')
            .bind(Number(c.req.param('id')), user.id)
            .run()
        if (!meta.changes) fail(404, { detail: 'Not found.' })
        return c.body(null, 204)
    })

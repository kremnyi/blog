// Celery beat + RabbitMQ + a beat schedule file on an SD card, replaced by two cron strings in wrangler.jsonc.
import type { Env } from './lib/core'
import { notify } from './lib/notify'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export async function publishScheduledPosts(env: Env): Promise<number> {
    const { meta } = await env.DB.prepare(
        'UPDATE posts SET is_published = 1, updated_at = ? WHERE is_published = 0 AND published_at IS NOT NULL AND published_at <= ?'
    )
        .bind(new Date().toISOString(), new Date().toISOString())
        .run()
    return meta.changes
}

export async function expireSubscriptions(env: Env): Promise<number> {
    const nowMs = Date.now()
    // Runs hourly, so each reminder fires once: when 3 (or 1) days are left, within this hour.
    for (const days of [3, 1]) {
        const { results } = await env.DB.prepare(
            `SELECT s.plan, s.valid_until, u.id, u.email, u.first_name FROM subscriptions s JOIN users u ON u.id = s.user_id
             WHERE s.status = 'active' AND s.valid_until >= ? AND s.valid_until < ?`
        )
            .bind(new Date(nowMs + days * DAY).toISOString(), new Date(nowMs + days * DAY + HOUR).toISOString())
            .all<any>()
        for (const s of results) await notify.subscriptionExpiring(env, s, s.plan, s.valid_until, days)
    }
    const { meta } = await env.DB.prepare(
        "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND valid_until < ?"
    )
        .bind(new Date(nowMs).toISOString(), new Date(nowMs).toISOString())
        .run()
    return meta.changes
}

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') await expireSubscriptions(env)
    else await publishScheduledPosts(env)
}

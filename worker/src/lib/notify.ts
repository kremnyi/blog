// Celery + RabbitMQ used to queue these. They are INSERT statements now.
import { now } from './core'

type Pref =
    | 'comment_on_post'
    | 'post_reaction'
    | 'payment_successful'
    | 'payment_failed'
    | 'subscription_activated'
    | 'subscription_expiring'
    | 'subscription_cancelled'

const SIGNATURE = '\n\nBest regards,\nYour Blog'

async function send(env: { DB: D1Database; DEFAULT_FROM_EMAIL: string }, userId: string, pref: Pref, subject: string, body: string) {
    const user = await env.DB.prepare(
        `SELECT u.email, COALESCE(np.${pref}, 1) AS enabled
         FROM users u LEFT JOIN notification_preferences np ON np.user_id = u.id WHERE u.id = ?`
    )
        .bind(userId)
        .first<{ email: string; enabled: number }>()
    if (!user || !user.enabled) return
    await env.DB.prepare(
        'INSERT INTO emails (user_id, subject, body, from_email, to_email, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
        .bind(userId, subject, body + SIGNATURE, env.DEFAULT_FROM_EMAIL, user.email, now())
        .run()
}

type Env = Parameters<typeof send>[0]
type Person = { id: string; email: string; first_name: string }
const hi = (u: Person) => `Hi ${u.first_name || u.email},\n\n`
const money = (cents: number, currency: string) => `$${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`

export const notify = {
    comment: (env: Env, author: Person, postTitle: string, commenter: string, body: string) =>
        send(env, author.id, 'comment_on_post', `New comment on your post: ${postTitle}`,
            `${hi(author)}${commenter} commented on your post "${postTitle}":\n\n${body}`),

    reaction: (env: Env, author: Person, postTitle: string, reactorEmail: string, reaction: string) =>
        send(env, author.id, 'post_reaction', `Someone reacted to your post: ${postTitle}`,
            `${hi(author)}${reactorEmail} ${reaction}d your post "${postTitle}".`),

    paymentSucceeded: (env: Env, user: Person, what: string, amount: number, currency: string) =>
        send(env, user.id, 'payment_successful', 'Payment Successful',
            `${hi(user)}Your payment for "${what}" was successful.\nAmount: ${money(amount, currency)}\n\nYou now have access to the content.`),

    subscriptionActivated: (env: Env, user: Person, plan: string, validUntil: string) =>
        send(env, user.id, 'subscription_activated', 'Subscription Activated',
            `${hi(user)}Your ${plan} subscription has been activated.\nValid until: ${validUntil.slice(0, 16).replace('T', ' ')} UTC\n\nThank you for subscribing!`),

    subscriptionCancelled: (env: Env, user: Person, plan: string) =>
        send(env, user.id, 'subscription_cancelled', 'Subscription Cancelled',
            `${hi(user)}Your ${plan} subscription has been cancelled.\n\nWe hope to see you again soon!`),

    subscriptionExpiring: (env: Env, user: Person, plan: string, validUntil: string, days: number) =>
        send(env, user.id, 'subscription_expiring', `Your subscription expires in ${days} day(s)`,
            `${hi(user)}Your ${plan} subscription will expire on ${validUntil.slice(0, 16).replace('T', ' ')} UTC.\n\nRenew your subscription to continue enjoying our content.`),
}

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { scheduled } from './cron'
import { tokenAuth } from './lib/auth'
import type { AppEnv, Env } from './lib/core'
import { emails, payments, subscriptions } from './routes/billing'
import { manage, posts } from './routes/posts'
import { auth, preferences, users } from './routes/users'

const v0 = new Hono<AppEnv>({ strict: false })
    .use(tokenAuth)
    .route('/users', users)
    .on(['GET', 'PUT', 'PATCH'], '/notification-preferences', preferences)
    .route('/emails', emails)
    .route('/payments', payments)
    .route('/subscriptions', subscriptions)
    .route('/manage', manage)
    .route('/', posts)

const app = new Hono<AppEnv>({ strict: false })
    .get('/health', (c) => c.json({ status: 'ok' }))
    .route('/api/v0', v0)
    .route('/api', auth)
    .get('/media/*', async (c) => {
        const key = c.req.path.slice('/media/'.length)
        const { value, metadata } = await c.env.MEDIA.getWithMetadata<{ type?: string }>(key, 'arrayBuffer')
        if (!value) return c.notFound()
        return c.body(value, 200, {
            'Content-Type': metadata?.type ?? 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
        })
    })
    .all('/api/*', (c) => c.json({ detail: 'Not found.' }, 404))
    .all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error(err)
    return c.json({ detail: 'Internal server error' }, 500)
})

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>

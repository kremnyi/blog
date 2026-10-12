-- Replaces Postgres 17, Redis 8, Elasticsearch 9 and a Raspberry Pi 5.

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    profile_picture TEXT,
    website TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    date_joined TEXT NOT NULL
);

CREATE TABLE tokens (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE notification_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    comment_on_post INTEGER NOT NULL DEFAULT 1,
    post_reaction INTEGER NOT NULL DEFAULT 1,
    payment_successful INTEGER NOT NULL DEFAULT 1,
    payment_failed INTEGER NOT NULL DEFAULT 1,
    subscription_activated INTEGER NOT NULL DEFAULT 1,
    subscription_expiring INTEGER NOT NULL DEFAULT 1,
    subscription_cancelled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    from_email TEXT NOT NULL,
    to_email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_user_date_idx ON emails (user_id, created_at DESC);

CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
);

CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    excerpt TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    featured_image TEXT,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    is_published INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_paid INTEGER NOT NULL DEFAULT 0,
    price_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX post_pub_date_idx ON posts (is_published, published_at DESC, created_at DESC);
CREATE INDEX post_cat_pub_idx ON posts (category_id, is_published, published_at DESC);
CREATE INDEX post_author_idx ON posts (author_id, is_published);

-- Elasticsearch, but it is a SQLite virtual table.
CREATE VIRTUAL TABLE posts_fts USING fts5 (
    title, excerpt, content,
    content = 'posts', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts (rowid, title, excerpt, content) VALUES (new.id, new.title, new.excerpt, new.content);
END;
CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts (posts_fts, rowid, title, excerpt, content) VALUES ('delete', old.id, old.title, old.excerpt, old.content);
END;
CREATE TRIGGER posts_fts_au AFTER UPDATE OF title, excerpt, content ON posts BEGIN
    INSERT INTO posts_fts (posts_fts, rowid, title, excerpt, content) VALUES ('delete', old.id, old.title, old.excerpt, old.content);
    INSERT INTO posts_fts (rowid, title, excerpt, content) VALUES (new.id, new.title, new.excerpt, new.content);
END;

CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    email TEXT,
    body TEXT NOT NULL,
    is_approved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX comment_post_date_idx ON comments (post_id, created_at);

CREATE TABLE reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction_type TEXT NOT NULL CHECK (reaction_type IN ('like', 'dislike')),
    created_at TEXT NOT NULL,
    UNIQUE (post_id, user_id)
);
CREATE INDEX reaction_post_type_idx ON reactions (post_id, reaction_type);

CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    price_id TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'month',
    status TEXT NOT NULL DEFAULT 'pending',
    stripe_subscription_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT UNIQUE,
    valid_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX sub_status_valid_idx ON subscriptions (status, valid_until);

CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    payment_type TEXT NOT NULL DEFAULT 'post',
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending',
    stripe_payment_intent_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX payment_user_status_idx ON payments (user_id, status, created_at DESC);
CREATE INDEX pay_sub_status_idx ON payments (subscription_id, status);

CREATE TABLE post_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    access_granted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX unique_successful_purchase_per_post ON post_purchases (user_id, post_id) WHERE status = 'succeeded';
CREATE INDEX purchase_user_post_idx ON post_purchases (user_id, post_id, status);

ALTER TABLE categories ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

CREATE INDEX categories_created_at ON categories(created_at);
CREATE INDEX topics_created_at ON topics(created_at);

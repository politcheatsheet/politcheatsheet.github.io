ALTER TABLE categories ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN slug TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX categories_slug_unique ON categories(slug) WHERE slug <> '';
CREATE UNIQUE INDEX topics_category_slug_unique ON topics(category_id, slug) WHERE slug <> '';

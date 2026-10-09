export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  EDITOR_ACCESS_CODE: string;
  EDITOR_SESSION_SECRET: string;
  ALLOWED_ORIGINS?: string;
}

type Card = { id: string; title: string; description: string; slug: string; sortOrder: number };
type Topic = Card & { categoryId: string; author: string };
type Input = { title: string; description: string };
type TopicInput = Input & { author: string };

const encoder = new TextEncoder();
const maximumDescriptionLength = 750_000;
const maximumEmbeddedImages = 10;
const maximumEmbeddedImageLength = 350_000;
const maximumPdfBytes = 10 * 1024 * 1024;
const rememberedDeviceLifetime = 1000 * 60 * 60 * 24 * 30;
const deviceUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dataImagePattern = /!\[image\]\((data:image\/webp;base64,[A-Za-z0-9+/=]+)\)/g;
const imageSourcePattern = /!\[image\]\((data:image\/webp;base64,[A-Za-z0-9+/=]+|media:\/\/images\/[0-9a-f-]+\.webp)\)/g;
const mediaKeyPattern = /^(?:images\/[0-9a-f-]+\.webp|documents\/[0-9a-f-]+\.pdf)$/;
function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "carte";
}

const defaultCategories: Card[] = [
  { id: "economie", title: "Économie", description: "Comprendre les grandes mécaniques qui façonnent nos choix.", slug: "economie", sortOrder: 1 },
  { id: "societe", title: "Société", description: "Idées, institutions et questions qui traversent notre quotidien.", slug: "societe", sortOrder: 2 },
  { id: "technologie", title: "Technologie", description: "Des outils qui changent la façon dont nous vivons et travaillons.", slug: "technologie", sortOrder: 3 },
];
const defaultTopics: Topic[] = [
  { id: "inflation", categoryId: "economie", title: "L’inflation, simplement", description: "Pourquoi les prix montent, comment elle est mesurée, et ce qu’elle change au quotidien.", author: "", slug: "inflation_simplement", sortOrder: 1 },
  { id: "offre-demande", categoryId: "economie", title: "L’offre et la demande", description: "Le principe qui aide à lire les prix, les pénuries et les comportements de marché.", author: "", slug: "offre_et_la_demande", sortOrder: 2 },
  { id: "budget-public", categoryId: "economie", title: "Le budget public", description: "Comment l’État collecte, répartit et utilise l’argent public.", author: "", slug: "le_budget_public", sortOrder: 3 },
];

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowedOrigins = (env.ALLOWED_ORIGINS || "https://politcheatsheet.github.io").split(",").map((value) => value.trim()).filter(Boolean);
  if (!origin || !allowedOrigins.includes(origin)) return { "Vary": "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Filename",
    "Vary": "Origin",
  };
}

function json(request: Request, env: Env, value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(request, env) } });
}

function failure(request: Request, env: Env, message: string, status = 400) {
  return json(request, env, { error: message }, status);
}

function validateInput(value: unknown): Input {
  if (!value || typeof value !== "object") throw new Error("Les données sont invalides.");
  const body = value as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!title) throw new Error("Un titre est requis.");
  if (title.length > 120 || description.length > maximumDescriptionLength) throw new Error("Le titre ou la description est trop long.");
  const images = [...description.matchAll(imageSourcePattern)];
  if (images.length > maximumEmbeddedImages || images.some((image) => image[1].startsWith("data:") && image[1].length > maximumEmbeddedImageLength)) {
    throw new Error("Une description peut contenir au plus dix images WebP compressées.");
  }
  return { title, description };
}

function validateTopicInput(value: unknown): TopicInput {
  const input = validateInput(value);
  const author = typeof (value as Record<string, unknown>).author === "string" ? (value as Record<string, string>).author.trim() : "";
  if (author.length > 120) throw new Error("Le nom de l’auteur est trop long.");
  return { ...input, author };
}

function card(row: Record<string, unknown>): Card {
  const title = String(row.title);
  return { id: String(row.id), title, description: String(row.description || ""), slug: String(row.slug || slugify(title)), sortOrder: Number(row.sort_order || 0) };
}

async function backfillSlugs(env: Env, table: "categories" | "topics", rows: Record<string, unknown>[], categoryId?: string) {
  const used = new Set(rows.map((row) => String(row.slug || "")).filter(Boolean));
  if (table === "categories") {
    for (const item of defaultCategories) if (!rows.some((row) => String(row.id) === item.id)) used.add(item.slug);
  } else {
    for (const item of defaultTopics) if (item.categoryId === categoryId && !rows.some((row) => String(row.id) === item.id)) used.add(item.slug);
  }
  for (const row of rows) {
    if (row.slug) continue;
    const id = String(row.id);
    const base = slugify(String(row.title));
    let slug = base;
    if (used.has(slug)) slug = `${base}_${id.replace(/[^a-z0-9]/gi, "").slice(-6) || "card"}`;
    used.add(slug);
    if (table === "categories") await env.DB.prepare("UPDATE categories SET slug = ? WHERE id = ? AND slug = ''").bind(slug, id).run();
    else await env.DB.prepare("UPDATE topics SET slug = ? WHERE id = ? AND category_id = ? AND slug = ''").bind(slug, id, categoryId || "").run();
    row.slug = slug;
  }
}

async function availableSlug(env: Env, table: "categories" | "topics", title: string, id: string, categoryId?: string) {
  const base = slugify(title);
  const fallback = `${base}_${id.replace(/[^a-z0-9]/gi, "").slice(-6) || "card"}`;
  const defaultCollision = table === "categories"
    ? defaultCategories.some((item) => item.id !== id && item.slug === base)
    : defaultTopics.some((item) => item.categoryId === categoryId && item.id !== id && item.slug === base);
  const condition = table === "topics" ? "category_id = ? AND slug = ? AND id <> ?" : "slug = ? AND id <> ?";
  const query = (slug: string) => table === "topics"
    ? env.DB.prepare(`SELECT id FROM topics WHERE ${condition} LIMIT 1`).bind(categoryId || "", slug, id).first()
    : env.DB.prepare(`SELECT id FROM categories WHERE ${condition} LIMIT 1`).bind(slug, id).first();
  if (!defaultCollision && !(await query(base))) return base;
  if (!(await query(fallback))) return fallback;
  return `${fallback}_${crypto.randomUUID().slice(0, 6)}`;
}

function mediaSource(key: string) { return `media://${key}`; }

function mediaKey(source: string) {
  const key = source.startsWith("media://") ? source.slice("media://".length) : "";
  return mediaKeyPattern.test(key) ? key : null;
}

function dataImageBytes(source: string) {
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/=]+)$/.exec(source);
  if (!match) throw new Error("Image invalide.");
  const binary = atob(match[1]); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function migrateEmbeddedImages(env: Env, description: string) {
  const images = [...description.matchAll(dataImagePattern)];
  if (!images.length) return description;
  let migrated = description;
  for (const image of images) {
    const key = `images/${crypto.randomUUID()}.webp`;
    await env.ASSETS.put(key, dataImageBytes(image[1]), { httpMetadata: { contentType: "image/webp" } });
    migrated = migrated.replace(image[0], `![image](${mediaSource(key)})`);
  }
  return migrated;
}

async function migrateStoredDescription(env: Env, table: "categories" | "topics", row: Record<string, unknown>) {
  const description = String(row.description || "");
  const migrated = await migrateEmbeddedImages(env, description);
  if (migrated !== description) {
    await env.DB.prepare(`UPDATE ${table} SET description = ?, updated_at = ? WHERE id = ?`).bind(migrated, new Date().toISOString(), String(row.id)).run();
  }
  return { ...row, description: migrated };
}

function topic(row: Record<string, unknown>): Topic { return { ...card(row), categoryId: String(row.category_id), author: String(row.author || "") }; }

function merge<T extends { id: string; sortOrder: number }>(defaults: T[], stored: T[], deleted = new Set<string>()) {
  const values = new Map(defaults.filter((item) => !deleted.has(item.id)).map((item) => [item.id, item]));
  stored.forEach((item) => values.set(item.id, item));
  return [...values.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

function constantTimeEqual(left: string, right: string) {
  const a = encoder.encode(left); const b = encoder.encode(right); let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deviceId(value: unknown) {
  return typeof value === "string" && deviceUuidPattern.test(value) ? value.toLowerCase() : null;
}

async function rememberDevice(env: Env, id: string, username: string) {
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + rememberedDeviceLifetime).toISOString();
  const deviceHash = await hmac(id, env.EDITOR_SESSION_SECRET);
  await env.DB.prepare("INSERT INTO editor_devices (device_hash, username, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_hash) DO UPDATE SET username = excluded.username, expires_at = excluded.expires_at, updated_at = excluded.updated_at")
    .bind(deviceHash, username, expiresAt, timestamp, timestamp).run();
  return expiresAt;
}

async function rememberedUsername(env: Env, id: string) {
  const deviceHash = await hmac(id, env.EDITOR_SESSION_SECRET);
  const row = await env.DB.prepare("SELECT username, expires_at FROM editor_devices WHERE device_hash = ?").bind(deviceHash).first<{ username: string; expires_at: string }>();
  return row && Date.parse(row.expires_at) > Date.now() ? row.username : null;
}

function encodeUsername(username: string) {
  const bytes = encoder.encode(username);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeUsername(value: string) {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { return ""; }
}

async function sessionToken(env: Env, username: string) {
  const expiry = Date.now() + 1000 * 60 * 60 * 12;
  const payload = `${expiry}.${crypto.randomUUID()}.${encodeUsername(username)}`;
  return `${payload}.${await hmac(payload, env.EDITOR_SESSION_SECRET)}`;
}

async function authenticatedUsername(request: Request, env: Env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const [expiry, nonce, encodedUsername, signature] = token.split(".");
  if (!expiry || !nonce || !encodedUsername || !signature || Number(expiry) < Date.now()) return null;
  const payload = `${expiry}.${nonce}.${encodedUsername}`;
  if (!constantTimeEqual(await hmac(payload, env.EDITOR_SESSION_SECRET), signature)) return null;
  const username = decodeUsername(encodedUsername).trim();
  return username && username.length <= 120 ? username : null;
}

async function isEditor(request: Request, env: Env) {
  return Boolean(await authenticatedUsername(request, env));
}

async function storedCategory(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT id, title, description, slug, sort_order FROM categories WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? card(row) : null;
}

async function isDeleted(env: Env, type: "category" | "topic", id: string) {
  const row = await env.DB.prepare("SELECT id FROM deleted_cards WHERE card_type = ? AND id = ?").bind(type, id).first();
  return Boolean(row);
}

async function deletedIds(env: Env, type: "category" | "topic") {
  const result = await env.DB.prepare("SELECT id FROM deleted_cards WHERE card_type = ?").bind(type).all<{ id: string }>();
  return new Set(result.results.map((row) => row.id));
}

async function ensureCategory(env: Env, id: string) {
  if (await isDeleted(env, "category", id)) throw new Error("Cette catégorie est introuvable.");
  const existing = await storedCategory(env, id);
  if (existing) return existing;
  const fallback = defaultCategories.find((item) => item.id === id);
  if (!fallback) throw new Error("Cette catégorie est introuvable.");
  return writeCategory(env, fallback, id);
}

async function writeCategory(env: Env, input: Input & { sortOrder?: number }, id: string = crypto.randomUUID()) {
  const timestamp = new Date().toISOString();
  const fallback = defaultCategories.find((item) => item.id === id);
  const existing = await env.DB.prepare("SELECT slug FROM categories WHERE id = ?").bind(id).first<{ slug: string }>();
  const slug = existing?.slug || fallback?.slug || await availableSlug(env, "categories", input.title, id);
  await env.DB.prepare("INSERT INTO categories (id, title, description, slug, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, sort_order = excluded.sort_order, updated_at = excluded.updated_at")
    .bind(id, input.title, input.description, slug, input.sortOrder ?? fallback?.sortOrder ?? Date.now(), timestamp, timestamp).run();
  const result = await storedCategory(env, id);
  if (!result) throw new Error("La catégorie n’a pas pu être enregistrée.");
  return result;
}

async function listCategories(env: Env) {
  const result = await env.DB.prepare("SELECT id, title, description, slug, sort_order FROM categories ORDER BY sort_order ASC").all<Record<string, unknown>>();
  await backfillSlugs(env, "categories", result.results);
  const stored = await Promise.all(result.results.map(async (row) => card(await migrateStoredDescription(env, "categories", row))));
  return merge(defaultCategories, stored, await deletedIds(env, "category"));
}

async function listTopics(env: Env, categoryId: string) {
  if (await isDeleted(env, "category", categoryId)) return [];
  const result = await env.DB.prepare("SELECT id, category_id, title, description, slug, author, sort_order FROM topics WHERE category_id = ? ORDER BY sort_order ASC").bind(categoryId).all<Record<string, unknown>>();
  await backfillSlugs(env, "topics", result.results, categoryId);
  const stored = await Promise.all(result.results.map(async (row) => topic(await migrateStoredDescription(env, "topics", row))));
  return merge(defaultTopics.filter((item) => item.categoryId === categoryId), stored, await deletedIds(env, "topic"));
}

async function listAllTopics(env: Env) {
  const [result, deletedTopics, deletedCategories] = await Promise.all([
    env.DB.prepare("SELECT id, category_id, title, description, slug, author, sort_order FROM topics ORDER BY sort_order ASC").all<Record<string, unknown>>(),
    deletedIds(env, "topic"),
    deletedIds(env, "category"),
  ]);
  const topicsByCategory = new Map<string, Record<string, unknown>[]>();
  for (const row of result.results) {
    const categoryId = String(row.category_id);
    const rows = topicsByCategory.get(categoryId) || [];
    rows.push(row); topicsByCategory.set(categoryId, rows);
  }
  for (const [categoryId, rows] of topicsByCategory) await backfillSlugs(env, "topics", rows, categoryId);
  const stored = (await Promise.all(result.results.map(async (row) => topic(await migrateStoredDescription(env, "topics", row))))).filter((item) => !deletedCategories.has(item.categoryId));
  const defaults = defaultTopics.filter((item) => !deletedCategories.has(item.categoryId));
  return merge(defaults, stored, deletedTopics);
}

async function writeTopic(env: Env, categoryId: string, input: TopicInput, id: string = crypto.randomUUID()) {
  await ensureCategory(env, categoryId);
  const timestamp = new Date().toISOString();
  const fallback = defaultTopics.find((item) => item.id === id);
  const existing = await env.DB.prepare("SELECT slug FROM topics WHERE id = ?").bind(id).first<{ slug: string }>();
  const slug = existing?.slug || fallback?.slug || await availableSlug(env, "topics", input.title, id, categoryId);
  await env.DB.prepare("INSERT INTO topics (id, category_id, title, description, slug, author, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, title = excluded.title, description = excluded.description, author = excluded.author, sort_order = excluded.sort_order, updated_at = excluded.updated_at")
    .bind(id, categoryId, input.title, input.description, slug, input.author, fallback?.sortOrder ?? Date.now(), timestamp, timestamp).run();
  const row = await env.DB.prepare("SELECT id, category_id, title, description, slug, author, sort_order FROM topics WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error("Le sujet n’a pas pu être enregistré.");
  return topic(row);
}

async function deleteCategory(env: Env, id: string) {
  if (!id) throw new Error("Catégorie requise.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO deleted_cards (card_type, id, deleted_at) VALUES ('category', ?, ?) ON CONFLICT(card_type, id) DO UPDATE SET deleted_at = excluded.deleted_at").bind(id, new Date().toISOString()),
    env.DB.prepare("DELETE FROM topics WHERE category_id = ?").bind(id),
    env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id),
  ]);
}

async function deleteTopic(env: Env, id: string) {
  if (!id) throw new Error("Sujet requis.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO deleted_cards (card_type, id, deleted_at) VALUES ('topic', ?, ?) ON CONFLICT(card_type, id) DO UPDATE SET deleted_at = excluded.deleted_at").bind(id, new Date().toISOString()),
    env.DB.prepare("DELETE FROM topics WHERE id = ?").bind(id),
  ]);
}

async function uploadImage(env: Env, source: unknown) {
  if (typeof source !== "string") throw new Error("Image requise.");
  const bytes = dataImageBytes(source);
  if (source.length > maximumEmbeddedImageLength) throw new Error("L’image compressée est trop volumineuse.");
  const key = `images/${crypto.randomUUID()}.webp`;
  await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: "image/webp" } });
  return mediaSource(key);
}

function pdfFilename(value: string | null) {
  let decoded = "document.pdf";
  try { if (value) decoded = decodeURIComponent(value); } catch { /* Use the fallback name. */ }
  const cleaned = decoded.replace(/[^A-Za-z0-9À-ÿ._ -]/g, "_").trim().slice(0, 100);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned || "document"}.pdf`;
}

async function uploadPdf(request: Request, env: Env) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0] !== "application/pdf") throw new Error("Seuls les fichiers PDF sont acceptés.");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Le PDF est vide.");
  if (bytes.byteLength > maximumPdfBytes) throw new Error("Le PDF est trop volumineux (10 Mo maximum).");
  const filename = pdfFilename(request.headers.get("X-Filename")); const key = `documents/${crypto.randomUUID()}.pdf`;
  await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: "application/pdf", contentDisposition: `inline; filename="${filename}"` } });
  return { source: mediaSource(key), filename };
}

async function serveMedia(request: Request, env: Env, path: string) {
  let key = "";
  try { key = decodeURIComponent(path.slice("/media/".length)); } catch { return failure(request, env, "Fichier introuvable.", 404); }
  if (!mediaKeyPattern.test(key)) return failure(request, env, "Fichier introuvable.", 404);
  const object = await env.ASSETS.get(key);
  if (!object) return failure(request, env, "Fichier introuvable.", 404);
  const headers: Record<string, string> = { "Content-Type": object.httpMetadata?.contentType || (key.endsWith(".pdf") ? "application/pdf" : "image/webp"), "Cache-Control": "public, max-age=31536000, immutable", ...cors(request, env) };
  if (object.httpMetadata?.contentDisposition) headers["Content-Disposition"] = object.httpMetadata.contentDisposition;
  return new Response(object.body, { headers });
}

async function content(request: Request, env: Env, path: string) {
  if (request.method === "GET" && path === "/categories") return json(request, env, { categories: await listCategories(env) });
  if (request.method === "GET" && path === "/topics") {
    const categoryId = new URL(request.url).searchParams.get("categoryId");
    return json(request, env, { topics: categoryId ? await listTopics(env, categoryId) : await listAllTopics(env) });
  }
  if (!(await isEditor(request, env))) return failure(request, env, "Accès éditeur requis.", 403);
  if (request.method === "DELETE" && path.startsWith("/categories/")) {
    await deleteCategory(env, decodeURIComponent(path.slice(12)));
    return json(request, env, { ok: true });
  }
  if (request.method === "DELETE" && path.startsWith("/topics/")) {
    await deleteTopic(env, decodeURIComponent(path.slice(8)));
    return json(request, env, { ok: true });
  }
  if (request.method === "POST" && path === "/uploads/images") {
    const body = await request.json() as { source?: unknown };
    return json(request, env, { source: await uploadImage(env, body.source) }, 201);
  }
  if (request.method === "POST" && path === "/uploads/documents") return json(request, env, await uploadPdf(request, env), 201);
  if (request.method !== "POST" && request.method !== "PUT") return failure(request, env, "Route introuvable.", 404);
  const body = await request.json();
  const input = validateInput(body);
  if (request.method === "POST" && path === "/categories") return json(request, env, { category: await writeCategory(env, input) }, 201);
  if (request.method === "PUT" && path.startsWith("/categories/")) return json(request, env, { category: await writeCategory(env, input, decodeURIComponent(path.slice(12))) });
  const categoryId = typeof (body as Record<string, unknown>).categoryId === "string" ? (body as Record<string, string>).categoryId : "";
  if (!categoryId) return failure(request, env, "Catégorie requise.");
  const topicInput = validateTopicInput(body);
  if (request.method === "POST" && path === "/topics") return json(request, env, { topic: await writeTopic(env, categoryId, topicInput) }, 201);
  if (request.method === "PUT" && path.startsWith("/topics/")) return json(request, env, { topic: await writeTopic(env, categoryId, topicInput, decodeURIComponent(path.slice(8))) });
  return failure(request, env, "Route introuvable.", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path.startsWith("/media/")) return await serveMedia(request, env, path);
      if (request.method === "GET" && path === "/session/current") {
        const username = await authenticatedUsername(request, env);
        return username ? json(request, env, { username }) : failure(request, env, "Accès éditeur requis.", 403);
      }
      if (request.method === "POST" && path === "/session") {
        const body = await request.json() as { code?: unknown; username?: unknown; deviceId?: unknown };
        if (typeof body.code !== "string" || !constantTimeEqual(body.code, env.EDITOR_ACCESS_CODE)) return failure(request, env, "Code incorrect.", 401);
        const username = typeof body.username === "string" ? body.username.trim() : "";
        if (!username || username.length > 120) return failure(request, env, "Un nom d’utilisateur valide est requis.");
        const id = deviceId(body.deviceId);
        if (!id) return failure(request, env, "Identifiant d’appareil invalide.");
        const rememberUntil = await rememberDevice(env, id, username);
        return json(request, env, { token: await sessionToken(env, username), username, rememberUntil });
      }
      if (request.method === "POST" && path === "/session/remembered") {
        const body = await request.json() as { deviceId?: unknown };
        const id = deviceId(body.deviceId);
        const username = id ? await rememberedUsername(env, id) : null;
        if (!id || !username) return failure(request, env, "Accès mémorisé expiré.", 401);
        return json(request, env, { token: await sessionToken(env, username), username });
      }
      if (request.method === "DELETE" && path === "/session/remembered") {
        const username = await authenticatedUsername(request, env);
        if (!username) return failure(request, env, "Accès éditeur requis.", 403);
        const body = await request.json() as { deviceId?: unknown };
        const id = deviceId(body.deviceId);
        if (!id) return failure(request, env, "Identifiant d’appareil invalide.");
        const deviceHash = await hmac(id, env.EDITOR_SESSION_SECRET);
        await env.DB.prepare("DELETE FROM editor_devices WHERE device_hash = ? AND username = ?").bind(deviceHash, username).run();
        return json(request, env, { ok: true });
      }
      if (request.method === "GET" && path === "/health") return json(request, env, { ok: true });
      return await content(request, env, path);
    } catch (error) {
      console.error(error);
      return failure(request, env, error instanceof Error ? error.message : "Service temporairement indisponible.", 503);
    }
  },
};

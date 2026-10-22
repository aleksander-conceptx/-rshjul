// Shared storage for the årshjul: one JSON document in Netlify Blobs.
//   GET    /api/state           -> { events: [...], categories: [...] | null }
//   PUT    /api/events/:id      -> create/update an event
//   DELETE /api/events/:id      -> delete an event
//   PUT    /api/categories      -> { list: [...] }
// Writes return the new state. If the env var WHEEL_CODE is set, writes need the header x-wheel-code.
import { getStore } from "@netlify/blobs";

const KEY = "wheel";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const MAX_EVENTS = 2000;

const json = (data, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const view = (s) => ({
  events: Object.entries(s?.events ?? {}).map(([id, e]) => ({ id, ...e })),
  categories: s?.categories ?? null,
});

class HttpError extends Error {
  constructor(status) { super(String(status)); this.status = status; }
}

function cleanEvent(b) {
  if (!b || typeof b !== "object") return null;
  const title = String(b.title ?? "").trim().slice(0, 80);
  const start = String(b.start ?? "");
  const end = b.end ? String(b.end) : "";
  if (!title || !DATE.test(start) || (end && (!DATE.test(end) || end < start))) return null;
  return {
    title, start, end,
    cat: String(b.cat ?? "").slice(0, 64),
    note: String(b.note ?? "").slice(0, 400),
    updatedAt: new Date().toISOString(),
  };
}

function cleanCats(b) {
  const list = b?.list;
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) return null;
  const out = list.map((c) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? "").trim().slice(0, 40), color: String(c?.color ?? "") }));
  return out.every((c) => ID.test(c.id) && c.name && COLOR.test(c.color)) ? out : null;
}

// Read-modify-write with an etag check, so two people saving at once don't overwrite each other.
async function update(store, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    const next = fn(structuredClone(cur?.data ?? { events: {}, categories: null }));
    const res = cur
      ? await store.setJSON(KEY, next, { onlyIfMatch: cur.etag })
      : await store.setJSON(KEY, next, { onlyIfNew: true });
    if (res.modified) return next;
  }
  throw new HttpError(409);
}

export default async (req) => {
  const store = getStore({ name: "aarshjul", consistency: "strong" });
  const [route, id] = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  if (req.method === "GET" && route === "state") return json(view(await store.get(KEY, { type: "json" })));

  const code = process.env.WHEEL_CODE;
  if (code && req.headers.get("x-wheel-code") !== code) return json({ error: "code" }, 401);

  let body = null;
  if (req.method === "PUT") {
    try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  }

  try {
    if (route === "events" && id && ID.test(id) && req.method === "PUT") {
      const ev = cleanEvent(body);
      if (!ev) return json({ error: "invalid" }, 400);
      return json(view(await update(store, (s) => {
        if (!s.events[id] && Object.keys(s.events).length >= MAX_EVENTS) throw new HttpError(413);
        s.events[id] = ev;
        return s;
      })));
    }
    if (route === "events" && id && ID.test(id) && req.method === "DELETE") {
      return json(view(await update(store, (s) => { delete s.events[id]; return s; })));
    }
    if (route === "categories" && req.method === "PUT") {
      const list = cleanCats(body);
      if (!list) return json({ error: "invalid" }, 400);
      return json(view(await update(store, (s) => { s.categories = list; return s; })));
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    throw e;
  }
  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/*" };

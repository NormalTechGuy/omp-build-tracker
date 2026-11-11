// Cloudflare Worker for the omp build tracker: an always-on, read-only copy of
// the dashboard. The tracker server pushes its redacted public snapshot here;
// viewers poll it. Everything lives under /<SHARE_KEY>/; other paths are 404.
//
// Bindings: ASSETS (the dashboard's web/ directory), STATE (Durable Object).
// Secrets: SHARE_KEY (link key), WRITE_TOKEN (bearer token for pushes).
import { DurableObject } from "cloudflare:workers";

const MAX_BYTES = 1_800_000; // Durable Object values are capped at 2 MB.

export class TrackerState extends DurableObject {
	async read() {
		return (await this.ctx.storage.get("snapshot")) ?? null;
	}
	async write(json) {
		await this.ctx.storage.put("snapshot", json);
		await this.ctx.storage.put("pushed", Date.now());
	}
}

const enc = new TextEncoder();
function sameSecret(a, b) {
	const x = enc.encode(a ?? "");
	const y = enc.encode(b ?? "");
	return x.byteLength === y.byteLength && x.byteLength > 0 && crypto.subtle.timingSafeEqual(x, y);
}

const notFound = () => new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const m = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
		if (!m || !sameSecret(decodeURIComponent(m[1]), env.SHARE_KEY)) return notFound();
		const key = m[1];
		const rest = m[2];
		if (rest === undefined) return Response.redirect(`${url.origin}/${key}/${url.search}`, 301);
		const state = env.STATE.get(env.STATE.idFromName("main"));

		if (rest === "/api/push") {
			if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
			const auth = req.headers.get("authorization") ?? "";
			if (!sameSecret(auth.replace(/^Bearer\s+/i, ""), env.WRITE_TOKEN)) return new Response("unauthorized", { status: 401 });
			const body = await req.text();
			if (body.length > MAX_BYTES) return new Response("snapshot too large", { status: 413 });
			try {
				JSON.parse(body);
			} catch {
				return new Response("invalid JSON", { status: 400 });
			}
			await state.write(body);
			return new Response("ok");
		}
		if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405, headers: { allow: "GET" } });
		if (rest === "/api/snapshot") {
			const json = await state.read();
			if (!json) return new Response("no snapshot pushed yet", { status: 404, headers: { "cache-control": "no-store" } });
			return new Response(json, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
		}
		if (rest === "/" || rest === "/index.html") {
			const page = await env.ASSETS.fetch(new Request(`${url.origin}/`, req));
			// Tell the dashboard to poll: there is no event stream here.
			return new HTMLRewriter()
				.on("head", { element: e => e.append('<meta name="tracker-transport" content="poll">', { html: true }) })
				.transform(page);
		}
		if (rest.startsWith("/api/")) return notFound();
		return env.ASSETS.fetch(new Request(`${url.origin}${rest}`, req));
	},
};

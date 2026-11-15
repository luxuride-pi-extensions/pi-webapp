import { useEffect, useState } from "preact/hooks";

/**
 * Hash routing: the dashboard is served by a single static document, so every
 * view lives in the URL hash (`#/s/<sessionId>`). Deep links, browser back and
 * forward, and reloads all land on the same session.
 */
export type Route = { view: "overview" } | { view: "session"; sessionId: string };

const ROUTE_EVENT = "pi-webapp:route";
const SESSION_PREFIX = "#/s/";

export function parseRoute(hash: string = window.location.hash): Route {
	const value = hash.startsWith("#") ? hash.slice(1) : hash;
	const match = /^\/s\/(.+)$/.exec(value);
	if (match?.[1]) {
		try {
			return { view: "session", sessionId: decodeURIComponent(match[1]) };
		} catch {
			return { view: "session", sessionId: match[1] };
		}
	}
	// Older links used `#session=<id>`; keep them working.
	const legacy = /(?:^|[&])session=([^&]+)/.exec(value);
	if (legacy?.[1]) {
		try {
			return { view: "session", sessionId: decodeURIComponent(legacy[1]) };
		} catch {
			return { view: "session", sessionId: legacy[1] };
		}
	}
	return { view: "overview" };
}

export function routeHash(route: Route): string {
	return route.view === "session" ? `${SESSION_PREFIX}${encodeURIComponent(route.sessionId)}` : "#/";
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
	const hash = routeHash(route);
	const current = window.location.hash || "#/";
	if (current === hash) return;
	if (options.replace) window.history.replaceState(null, "", hash);
	else window.history.pushState(null, "", hash);
	window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function useRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseRoute());
	useEffect(() => {
		const sync = () => setRoute(parseRoute());
		window.addEventListener("popstate", sync);
		window.addEventListener("hashchange", sync);
		window.addEventListener(ROUTE_EVENT, sync);
		return () => {
			window.removeEventListener("popstate", sync);
			window.removeEventListener("hashchange", sync);
			window.removeEventListener(ROUTE_EVENT, sync);
		};
	}, []);
	return route;
}

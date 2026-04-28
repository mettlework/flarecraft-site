/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type Runtime = import("@astrojs/cloudflare").Runtime<{
	DB: D1Database;
	ASSETS: Fetcher;
	SITE_URL: string;
	SUBSCRIBE_URL: string;
}>;

declare namespace App {
	interface Locals extends Runtime {}
}

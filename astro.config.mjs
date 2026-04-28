// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// FlareCraft is server-rendered on Cloudflare Workers so that pages can read
// live data from D1 in the request path (no rebuild needed when the daily
// pipeline runs). Static assets (favicons, public/) are still served as
// static files by the same Worker via the assets binding.
export default defineConfig({
	output: "server",
	adapter: cloudflare({
		platformProxy: {
			enabled: true,
		},
	}),
});

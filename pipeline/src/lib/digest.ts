// Compose and send the daily digest email via Resend.
//
// Resend is a third-party transactional email service with a clean Workers-
// compatible API and a generous free tier. We use raw fetch() rather than
// the SDK for transparency and zero bundle weight.
//
// The email is intentionally minimal: top items by score, with primitive
// tags, one-liner, and a link. The full briefing lives at flarecraft.dev/
// — the email is a hook back to the site, not a replacement for it.

import type { ClassifiedItem, Env } from "../env";

interface DigestPayload {
	briefingId: string;
	items: ClassifiedItem[];
}

export async function sendDigest(
	env: Env,
	payload: DigestPayload,
): Promise<void> {
	const { items } = payload;

	if (items.length === 0) {
		console.log("Digest: no items to send, skipping");
		return;
	}

	const subject = `FlareCraft: ${items.length} ${items.length === 1 ? "thing" : "things"} on Cloudflare today`;
	const html = renderDigestHtml(payload, env.SITE_URL);
	const text = renderDigestText(payload, env.SITE_URL);

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: env.DIGEST_SENDER,
			to: [env.DIGEST_RECIPIENT],
			subject,
			html,
			text,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Resend send failed: ${res.status} ${body}`);
	}
}

function renderDigestHtml(p: DigestPayload, siteUrl: string): string {
	const date = new Date().toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	});

	const itemsHtml = p.items
		.map((item) => {
			const primitives = safeJSONArray(item.primitives);
			const tagsHtml = primitives
				.map(
					(p) =>
						`<span style="display:inline-block;background:#fef1e4;color:#f6821f;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-right:6px;">${escape(p)}</span>`,
				)
				.join("");

			return `
				<tr>
					<td style="padding:20px 0;border-bottom:1px solid #e5e1db;">
						<div style="font-size:13px;color:#6b6b6b;margin-bottom:6px;">
							${"★".repeat(item.score)}${"☆".repeat(5 - item.score)} &middot; ${escape(item.angle)}
						</div>
						<a href="${escape(item.url)}" style="font-size:18px;font-weight:600;color:#1a1a1a;text-decoration:none;line-height:1.3;display:block;margin-bottom:8px;">
							${escape(item.title)}
						</a>
						<div style="margin-bottom:10px;">${tagsHtml}</div>
						<div style="font-size:14px;color:#4a4a4a;line-height:1.5;">${escape(item.one_liner)}</div>
					</td>
				</tr>`;
		})
		.join("");

	return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>FlareCraft</title></head>
<body style="margin:0;padding:0;background:#faf8f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">
	<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:0 auto;padding:48px 24px;">
		<tr>
			<td>
				<div style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#f6821f;font-weight:600;margin-bottom:12px;">FlareCraft &middot; ${escape(date)}</div>
				<h1 style="font-size:28px;letter-spacing:-0.02em;line-height:1.2;color:#1a1a1a;margin:0 0 8px;">What developers are shipping on Cloudflare</h1>
				<p style="font-size:15px;color:#6b6b6b;margin:0 0 32px;">
					${p.items.length} item${p.items.length === 1 ? "" : "s"} from Hacker News in the last 24 hours, classified and ranked by Workers AI.
				</p>
				<table width="100%" cellpadding="0" cellspacing="0" border="0">${itemsHtml}</table>
				<div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e1db;font-size:13px;color:#6b6b6b;">
					Read the full briefing at <a href="${escape(siteUrl)}" style="color:#f6821f;text-decoration:none;">flarecraft.dev</a><br>
					Built end-to-end on Cloudflare: Workers + Workflows + Workers AI + Vectorize + D1 + R2 + Pages.
				</div>
			</td>
		</tr>
	</table>
</body>
</html>`;
}

function renderDigestText(p: DigestPayload, siteUrl: string): string {
	const date = new Date().toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
	const lines: string[] = [
		`FlareCraft — ${date}`,
		`What developers are shipping on Cloudflare`,
		``,
		`${p.items.length} item${p.items.length === 1 ? "" : "s"} from Hacker News in the last 24 hours.`,
		``,
		`---`,
		``,
	];
	for (const item of p.items) {
		const primitives = safeJSONArray(item.primitives).join(", ");
		lines.push(`★ ${item.score}/5  [${item.angle}]`);
		lines.push(item.title);
		if (primitives) lines.push(`Primitives: ${primitives}`);
		lines.push(item.one_liner);
		lines.push(item.url);
		lines.push(``);
	}
	lines.push(`Read the full briefing: ${siteUrl}`);
	return lines.join("\n");
}

function safeJSONArray(s: string): string[] {
	try {
		const parsed = JSON.parse(s);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function escape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

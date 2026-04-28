// Send the daily digest as an email via Resend.
//
// We pivoted away from Beehiiv's Posts API for the actual send because
// programmatic publish is gated to their enterprise tier. Beehiiv stays
// in the stack as the public subscribe-form / audience layer; Resend is
// the transport. Two platforms, separation of concerns:
//   - Beehiiv: who's in the list (and growth tooling, archive page, etc.)
//   - Resend:  the daily mail actually going out
//
// The bridge between them — pulling the Beehiiv subscriber list and
// blasting the digest to it via Resend — is a v2 problem. Today the
// digest goes to a single recipient (subscriber zero) to prove the path.

import type { BriefingSummary, ClassifiedItem, Env } from "../env";

interface DigestPayload {
	briefingId: string;
	items: ClassifiedItem[];
	summary: BriefingSummary | null;
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

	if (!env.RESEND_API_KEY) {
		console.warn("Digest: RESEND_API_KEY not set, skipping send");
		return;
	}

	const subject = `FlareCraft: ${items.length} ${items.length === 1 ? "thing" : "things"} on Cloudflare today`;
	const html = renderHtml(payload, env.SITE_URL);
	const text = renderText(payload, env.SITE_URL);

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

	const result = (await res.json()) as { id?: string };
	console.log(`Digest: Resend message id ${result.id ?? "(unknown)"}`);
}

function renderHtml(p: DigestPayload, siteUrl: string): string {
	const date = new Date().toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	});

	// "The cut" — editorial summary block above the items list
	const summaryHtml = (() => {
		if (!p.summary) return "";
		const { positives, negatives } = p.summary;
		if (positives.length === 0 && negatives.length === 0) return "";

		// Title→url lookup so summary entries link to their source posts.
		const urlByTitle = new Map<string, string>();
		for (const it of p.items) urlByTitle.set(it.title.trim(), it.url);

		const renderCol = (
			heading: string,
			items: { title: string; line: string }[],
			marker: string,
			markerColor: string,
		) => {
			if (items.length === 0) return "";
			const lis = items
				.map((it) => {
					const url = urlByTitle.get(it.title.trim());
					const titleHtml = url
						? `<a href="${escape(url)}" style="color:#1d1d1b;text-decoration:none;border-bottom:1px solid #d4cfc3;font-weight:600;">${escape(it.title)}.</a>`
						: `<strong style="color:#1d1d1b;font-weight:600;">${escape(it.title)}.</strong>`;
					return `<li style="margin-bottom:8px;">${titleHtml} ${escape(it.line)}</li>`;
				})
				.join("");
			return `<td style="vertical-align:top;width:50%;padding-right:12px;">
				<div style="font-family:Fraunces,Georgia,serif;font-weight:600;font-size:15px;color:#1d1d1b;margin-bottom:10px;">
					<span style="font-family:'JetBrains Mono',monospace;color:${markerColor};">${marker}</span>${escape(heading)}
				</div>
				<ol style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.55;color:#3a3a36;">${lis}</ol>
			</td>`;
		};

		return `
<div style="margin:24px 0 32px;padding:24px;background:#f3efe8;border-left:3px solid #e35a14;border-radius:0 4px 4px 0;">
	<div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#e35a14;font-weight:600;margin-bottom:14px;">
		The cut · today's read
	</div>
	<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
		${renderCol("What's working", positives, "+ ", "#e35a14")}
		${renderCol("What's friction", negatives, "− ", "#6b675e")}
	</tr></table>
</div>`;
	})();

	const itemsHtml = p.items
		.map((item, idx) => {
			const primitives = safeJSONArray(item.primitives);
			const tagsHtml = primitives
				.map(
					(prim) =>
						`<span style="display:inline-block;background:#fde9d2;color:#b03a0d;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:600;margin-right:4px;font-family:'JetBrains Mono',ui-monospace,monospace;">${escape(prim)}</span>`,
				)
				.join("");

			return `
<tr><td style="padding:20px 0;border-bottom:1px solid #e6e1d8;">
	<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#e35a14;margin-bottom:8px;font-weight:600;">
		${String(idx + 1).padStart(2, "0")} &nbsp;·&nbsp; ${"★".repeat(item.score)}${"☆".repeat(5 - item.score)} &nbsp;·&nbsp; ${escape(item.angle)}
	</div>
	<h2 style="font-family:Fraunces,Georgia,serif;font-weight:600;font-size:22px;line-height:1.25;letter-spacing:-0.015em;margin:0 0 10px;color:#1d1d1b;">
		<a href="${escape(item.url)}" style="color:#1d1d1b;text-decoration:none;">${escape(item.title)}</a>
	</h2>
	${tagsHtml ? `<div style="margin-bottom:10px;">${tagsHtml}</div>` : ""}
	<p style="margin:0;font-size:15px;color:#3a3a36;line-height:1.55;">${escape(item.one_liner)}</p>
</td></tr>`;
		})
		.join("");

	return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>FlareCraft</title></head>
<body style="margin:0;padding:0;background:#faf8f5;font-family:'Inter Tight',system-ui,-apple-system,sans-serif;">
	<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:0 auto;padding:48px 24px;">
		<tr><td>
			<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#e35a14;font-weight:600;margin-bottom:12px;">
				FlareCraft &nbsp;·&nbsp; ${escape(date)}
			</div>
			<h1 style="font-family:Fraunces,Georgia,serif;font-size:32px;letter-spacing:-0.025em;line-height:1.1;color:#1d1d1b;margin:0 0 8px;font-weight:700;">
				What developers are shipping<br>on Cloudflare
			</h1>
			<p style="font-size:15px;color:#3a3a36;margin:0 0 24px;">
				${p.items.length} item${p.items.length === 1 ? "" : "s"} from Hacker News and Reddit in the last 24 hours, classified and ranked by Workers AI.
			</p>
			${summaryHtml}
			<table width="100%" cellpadding="0" cellspacing="0" border="0">${itemsHtml}</table>
			<div style="margin-top:32px;padding-top:24px;border-top:2px solid #e35a14;font-size:13px;color:#6b675e;">
				Read live at <a href="${escape(siteUrl)}" style="color:#e35a14;text-decoration:none;font-weight:600;">flarecraft.dev</a><br>
				Built end-to-end on Cloudflare: Workers + Workflows + Workers AI + Vectorize + D1 + R2.
			</div>
		</td></tr>
	</table>
</body>
</html>`;
}

function renderText(p: DigestPayload, siteUrl: string): string {
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

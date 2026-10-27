#!/usr/bin/env node
/*
 * Customer-facing report for AI Website QA.
 * Reads a qa-analysis.json and writes one self-contained HTML file that leads
 * with what to fix first, in plain language. Test-automation notes are moved to
 * the end. No local paths or raw scenario IDs are printed.
 *
 *   node tools/customer-report.js reports/qa-analysis.json reports/customer-report.html --client "Acme"
 */
const fs = require("fs");

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
const client = flag("--client");
const [inFile = "reports/qa-analysis.json", outFile = "reports/customer-report.html"] = args;
const a = JSON.parse(fs.readFileSync(inFile, "utf8"));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, w) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;

// Plain-language copy per finding code. Anything not listed falls back to the finding's own text.
const COPY = {
  "a-missing-name": { title: "Links with no readable name", noun: "link", why: "Screen-reader users hear only “link” and cannot tell where it goes. Search engines also get less context about the target page.", fix: '<a href="/radio-shows" aria-label="Radio shows">…</a>', effort: "Usually one shared template change" },
  "button-missing-name": { title: "Buttons with no readable name", noun: "button", why: "Assistive technology cannot announce what the button does.", fix: '<button aria-label="Close menu">…</button>', effort: "Small" },
  "input-missing-label": { title: "Form fields with no label", noun: "form field", why: "People using screen readers or voice control cannot tell what to type, and tapping the label will not focus the field.", fix: '<label for="email">Email</label>\n<input id="email" type="email">', effort: "Small" },
  "image-missing-alt": { title: "Images with no text alternative", noun: "image", why: "Screen-reader users miss the image’s meaning, and search engines cannot index it.", fix: '<img src="team.jpg" alt="The support team at the 2026 meetup">', effort: "Small to medium" },
  "console-first-party-error": { title: "Errors from your own code", noun: "error", why: "These usually mean a feature failed or a resource was blocked, and visitors may hit the same problem.", fix: "Open the browser console on the page, find the failing script, fix it, and re-run the scan.", effort: "Varies" },
  "console-network-error": { title: "Resources that failed to load", noun: "failed request", why: "Some content, scripts, or sign-in options may not work for every visitor.", fix: "Check each failing URL and its HTTP response, then remove or repair the reference.", effort: "Small to medium" },
  "missing-page-title": { title: "Page has no title", noun: "page", why: "The title appears in browser tabs and search results.", fix: "<title>Page name | Site name</title>", effort: "Small" },
  "missing-lang": { title: "Page language not declared", noun: "page", why: "Screen readers pick the wrong pronunciation without it.", fix: '<html lang="en">', effort: "Small" },
  "missing-viewport": { title: "Page is not set up for mobile screens", noun: "page", why: "Phones show a zoomed-out desktop layout.", fix: '<meta name="viewport" content="width=device-width, initial-scale=1">', effort: "Small" },
  "duplicate-id": { title: "Duplicate element IDs", noun: "ID", why: "Labels, links, and scripts can attach to the wrong element.", fix: "Give every id on a page a unique value.", effort: "Small" },
  "empty-link": { title: "Links that go nowhere", noun: "link", why: "Visitors click and nothing happens.", fix: "Point the link at a real address, or use a button if it triggers an action.", effort: "Small" },
  "missing-h1": { title: "Page has no main heading", noun: "page", why: "Headings are how screen-reader users and search engines understand the page.", fix: "<h1>What this page is about</h1>", effort: "Small" },
  "unhealthy-link": { title: "Links that return errors", noun: "link", why: "Visitors land on error pages.", fix: "Update or remove each link that returns an error.", effort: "Small" },
  "page-http-error": { title: "Page returns an error", noun: "page", why: "Visitors and search engines see an error instead of content.", fix: "Check the server logs for the failing address.", effort: "Varies" },
  "missing-hsts": { title: "Browsers are not told to always use HTTPS", noun: "header", why: "First-time visitors can be downgraded to an insecure connection.", fix: "Strict-Transport-Security: max-age=31536000; includeSubDomains", effort: "Small (server setting)" },
  "missing-content-security-policy": { title: "No Content Security Policy", noun: "header", why: "Without one, injected scripts are harder to stop.", fix: "Start with a report-only policy, then tighten it.", effort: "Medium" },
};
// Findings that matter to test automation, not to the site owner.
const INTERNAL = new Set(["fragile-locator", "hidden-interactive-element", "disabled-interactive-element", "screenshot-unavailable"]);

const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const LABEL = { CRITICAL: "Critical", HIGH: "High priority", MEDIUM: "Medium priority", LOW: "Low priority", INFO: "Info" };
const verdict = (f) => (f.verification || {}).verdict;
const notReal = (f) => ["NOT_REPRODUCED", "CONDITIONAL"].includes(verdict(f)) || (f.verification || {}).disposition === "NOT_REPRODUCED";
const evidence = (f) => {
  const d = (f.verification || {}).disposition;
  if (d === "REPRODUCED") return ["Confirmed on the live page", "ok"];
  return ["Detected by the scan", "plain"];
};

const all = a.findings || [];
const main = all.filter((f) => !INTERNAL.has(f.code) && !notReal(f) && RANK[f.severity] >= 1)
  .sort((x, y) => RANK[y.severity] - RANK[x.severity] || (y.count || 0) - (x.count || 0));
const notes = all.filter((f) => !main.includes(f));

const scan = a.scan || {};
const info = scan.scan || {};
const sum = scan.summary || {};
const flows = (a.summary || {}).flowSummary || {};
const perf = scan.performance || {};
const site = info.finalUrl || info.url || (a.summary || {}).sourceUrl || "";
const date = new Date(info.timestamp || a.generatedAt || Date.now()).toISOString().slice(0, 10);
const host = (() => { try { return new URL(site).host; } catch { return site; } })();

const top = main[0];
const headline = !top ? "No significant problems found on the pages we checked."
  : main.length === 1 ? `One thing to fix: ${(COPY[top.code]?.title || top.title).toLowerCase()}.`
  : `${plural(main.length, "thing")} to fix. Start with ${(COPY[top.code]?.title || top.title).toLowerCase()}.`;
const sub = !top ? "Nothing here blocks visitors, but see the checks below for what was and was not covered."
  : `${plural(top.count || 1, COPY[top.code]?.noun || "item")} affected by the first issue alone. Fixing it is ${((COPY[top.code]?.effort) || "a focused change").toLowerCase().replace(/^./, (c) => c.toLowerCase())}.`;

function examples(f) {
  const out = [];
  for (const e of (f.examples || []).slice(0, 3)) {
    if (e.detail) out.push(e.detail);
    else if (e.element) {
      const el = e.element, bits = [`<${el.tag}>`];
      if (el.href) bits.push(el.href);
      else if (el.placeholder) bits.push(`placeholder “${el.placeholder}”`);
      else if (el.id) bits.push(`#${el.id}`);
      out.push(bits.join("  "));
    }
  }
  return out;
}

function item(f, i) {
  const c = COPY[f.code] || {};
  const [ev, evCls] = evidence(f);
  const ex = examples(f);
  return `<li class="item sev-${esc(f.severity)}">
  <div class="top"><h3>${esc(c.title || f.title)}</h3><span class="count">${esc(plural(f.count || 1, c.noun || "item"))}</span></div>
  <p class="meta"><span class="tag sev">${esc(LABEL[f.severity])}</span> <span class="tag ${evCls}">${esc(ev)}</span></p>
  <p><b>Why it matters.</b> ${esc(c.why || f.userImpact || f.description)}</p>
  <p><b>How to fix it.</b> ${c.fix && /[<:]/.test(c.fix) && c.fix.length < 140 ? "" : esc(c.fix || f.recommendation)}</p>
  ${c.fix && /[<:]/.test(c.fix) && c.fix.length < 140 ? `<pre>${esc(c.fix)}</pre>` : ""}
  ${c.effort ? `<p class="effort">Effort: ${esc(c.effort)}</p>` : ""}
  ${ex.length ? `<details><summary>Where we saw it</summary><ul class="ex">${ex.map((x) => `<li dir="auto">${esc(x)}</li>`).join("")}</ul>${(f.count || 0) > ex.length ? `<p class="effort">…and ${(f.count - ex.length).toLocaleString("en")} more. The full list is in the data export.</p>` : ""}</details>` : ""}
</li>`;
}

// Core Web Vitals-style thresholds: [good, poor]
const TH = { ttfb: [800, 1800, "Time to first byte", "How long the server takes to start answering."], fcp: [1800, 3000, "First content shown", "When visitors first see anything."], lcp: [2500, 4000, "Main content shown", "When the largest element finishes loading."] };
const rate = (k, v) => (v == null ? ["Not measured", "na"] : v <= TH[k][0] ? ["Good", "ok"] : v <= TH[k][1] ? ["Needs work", "warn"] : ["Slow", "bad"]);
const perfRows = Object.keys(TH).map((k) => {
  const v = perf[k], [r, cls] = rate(k, v);
  return `<tr><td><b>${TH[k][2]}</b><br><span class="effort">${TH[k][3]}</span></td><td class="num">${v == null ? "n/a" : (v / 1000).toFixed(1) + " s"}</td><td><span class="tag ${cls}">${r}</span></td></tr>`;
}).join("");

const checked = [
  `${plural(sum.totalElements || 0, "page element")} inspected (${(sum.interactiveElements || 0).toLocaleString("en")} interactive)`,
  `${plural(sum.linksChecked || 0, "link")} tested, ${sum.brokenLinks ? plural(sum.brokenLinks, "broken link") + " found" : "none broken"}`,
  flows.executed ? `${plural(flows.executed, "user journey")} run safely (${flows.passed || 0} passed)` : "No user journeys were run",
  "Nothing was submitted, purchased, or signed in to",
];

const noteRows = notes.map((f) => `<li><b>${esc(f.title)}</b>, ${esc(plural(f.count || 1, "instance"))}. ${esc(INTERNAL.has(f.code) ? (f.userImpact || f.description) : notReal(f) ? "Could not be reproduced on the live page, so it is probably tied to menus or panels that are hidden by default." : f.description)}</li>`).join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website QA report for ${esc(host)}</title>
<style>
:root{--ink:#16202c;--mute:#566475;--line:#d8dfe8;--bg:#eef1f5;--card:#fff;--high:#b42318;--med:#b54708;--low:#2f5aa8;--ok:#067647}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem}
header{padding:1.5rem 0 1rem}
.site{color:var(--mute);margin:0 0 1rem;font-size:.95rem}
h1{font:600 clamp(1.7rem,4.6vw,2.5rem)/1.15 Georgia,"Iowan Old Style",serif;margin:0 0 .6rem;letter-spacing:-.01em}
.lede{font-size:1.1rem;margin:0;max-width:38rem}
h2{font:600 1.35rem/1.2 Georgia,"Iowan Old Style",serif;margin:2.6rem 0 .3rem}
h2+p{margin:0 0 1rem;color:var(--mute)}
ol,ul{padding:0;margin:0;list-style:none}
.items{counter-reset:n}
.item{counter-increment:n;background:var(--card);border:1px solid var(--line);border-left:5px solid var(--low);border-radius:6px;padding:1rem 1.15rem;margin:0 0 .9rem}
.item.sev-HIGH,.item.sev-CRITICAL{border-left-color:var(--high)}.item.sev-MEDIUM{border-left-color:var(--med)}
.top{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;flex-wrap:wrap}
h3{font-size:1.08rem;margin:0}h3::before{content:counter(n) ". ";color:var(--mute);font-weight:500}
.count{font-weight:600;white-space:nowrap}
p{margin:.45rem 0}.meta{margin:.35rem 0 .6rem}
.tag{display:inline-block;font-size:.8rem;padding:.1rem .55rem;border-radius:99px;border:1px solid var(--line);background:#f6f8fa;margin-right:.25rem}
.tag.ok{color:var(--ok);border-color:#a6d8bf}.tag.warn{color:var(--med);border-color:#f0c79a}.tag.bad{color:var(--high);border-color:#efb1ab}.tag.na{color:var(--mute)}
pre{background:#f3f5f8;border:1px solid var(--line);border-radius:5px;padding:.6rem .8rem;overflow-x:auto;margin:.4rem 0;font:.85rem/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap}
.effort{color:var(--mute);font-size:.9rem}
details{margin-top:.5rem}summary{cursor:pointer;color:var(--low);font-weight:500}summary:focus-visible{outline:2px solid var(--low);outline-offset:2px}
.ex li{padding:.2rem 0;font:.85rem/1.4 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:6px}
td{padding:.7rem .9rem;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}.num{font:600 1.15rem Georgia,serif;white-space:nowrap}
.checked li{padding:.3rem 0 .3rem 1.2rem;position:relative}.checked li::before{content:"✓";position:absolute;left:0;color:var(--ok)}
.notes li{padding:.35rem 0;color:var(--mute)}
footer{margin-top:3rem;color:var(--mute);font-size:.85rem}
@media print{body{background:#fff}.item{break-inside:avoid}details{display:none}}
</style></head><body><main>
<header>
<p class="site">${client ? esc(client) + " · " : ""}${esc(host)} · scanned ${esc(date)}</p>
<h1>${esc(headline)}</h1>
<p class="lede">${esc(sub)}</p>
</header>

<h2>Fix these first</h2>
<p>Ordered by how many visitors each issue is likely to affect, then by how many places it appears.</p>
<ol class="items">${main.length ? main.map(item).join("\n") : "<li class='item'><p>No issues to list.</p></li>"}</ol>

<h2>Speed</h2>
<p>Measured on one page load from our test browser. Treat these as a guide and compare over time.</p>
<table>${perfRows}</table>

<h2>What we checked</h2>
<p>Everything below ran without changing anything on your site.</p>
<ul class="checked">${checked.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>

${notes.length ? `<h2>For your development team</h2>
<p>Lower-impact observations and automation notes. They do not affect visitors directly.</p>
<ul class="notes">${noteRows}</ul>` : ""}

<footer>Generated by AI Website QA. Findings marked “Detected by the scan” are signals to review, not guaranteed defects.</footer>
</main></body></html>`;

fs.writeFileSync(outFile, html);
console.log(`Wrote ${outFile} (${main.length} priority issues, ${notes.length} notes)`);

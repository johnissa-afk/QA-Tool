import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWebsite } from "../scanner.js";
import { detectIssues } from "../checks.js";

// A link or button is named by what it contains (an image's alt, an icon's <title> or aria-label),
// not only by its own text. Reading only the element's own text reported logo links, poster cards
// and icon buttons as "no accessible name" (a HIGH finding) although screen readers announce them.
const PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Names</title>
<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><main><h1>Names</h1>
<a id="img-alt" href="/a"><img src="/i.png" alt="Kuwait channel"></a>
<a id="alt-dot" href="/b"><img src="/i.png" alt="."></a>
<a id="alt-empty" href="/c"><img src="/i.png" alt=""></a>
<a id="alt-none" href="/d"><img src="/i.png"></a>
<a id="no-content" href="/e"></a>
<a id="sr-only" href="/f"><span class="sr-only">Home</span></a>
<button id="svg-title"><svg width="10" height="10"><title>Close</title><path d="M0 0h10v10z"/></svg></button>
<button id="svg-hidden"><svg aria-hidden="true" width="10" height="10"><path d="M0 0h10v10z"/></svg></button>
<button id="svg-label"><svg aria-label="Menu" width="10" height="10"><path d="M0 0h10v10z"/></svg></button>
<a id="own-label" href="/k" aria-label="Own label"><img src="/i.png" alt="ignored"></a>
<a id="aria-hidden-img" href="/l"><img src="/i.png" alt="Not announced" aria-hidden="true"></a>
<button id="title-only" title="Tooltip only"></button>
<a id="nested" href="/n"><div><span><img src="/i.png" alt="Deeply nested name"></span></div></a>
<span id="lbl">By reference</span><button id="labelledby" aria-labelledby="lbl"></button>
<a id="two-images" href="/p"><img src="/i.png" alt="First"><img src="/i.png" alt="Second"></a>
<a id="icon-font" href="/q"><i class="icon"></i></a>
<button id="img-button"><img src="/i.png" alt="Save"></button>
<a id="plain" href="/s">Plain text link</a>
<label>Wrapped email <input id="wrapped-input" type="email"></label>
<label>Wrapped select <select id="wrapped-select"><option>One</option></select></label>
<label><span>Nested span label</span><input id="wrapped-nested" type="text"></label>
<label for="explicit-input">Explicit label</label><input id="explicit-input" type="text">
<input id="aria-input" type="search" aria-label="Search the site">
<input id="bare-input" type="text">
</main></body></html>`;

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("links and buttons are named by their image alt, icon title or aria-label, and only truly nameless ones are flagged", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/i.png") { response.writeHead(200, { "content-type": "image/png" }); response.end(PIXEL); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await scanWebsite({ url: `http://127.0.0.1:${address.port}/`, headed: false, timeout: 15_000, outputPath: join(mkdtempSync(join(tmpdir(), "ai-website-qa-")), "report.json"), concurrency: 1 });
    const elements = result.report.elements;
    const nameOf = (id: string) => elements.find(element => element.id === id)?.accessibleName ?? null;
    // The report keeps five examples per finding, so evaluate the check itself on every element.
    const flagged = new Set(detectIssues(elements, { title: "t", lang: "en", viewport: "width=device-width" })
      .filter(issue => /-missing-name$|^input-missing-label$/.test(issue.code)).map(issue => issue.element?.id));

    const named: Record<string, string> = {
      "img-alt": "Kuwait channel", "svg-title": "Close", "svg-label": "Menu", "own-label": "Own label", "title-only": "Tooltip only",
      nested: "Deeply nested name", labelledby: "By reference", "two-images": "First Second", "img-button": "Save", "sr-only": "Home", plain: "Plain text link",
      "wrapped-input": "Wrapped email", "wrapped-select": "Wrapped select", "wrapped-nested": "Nested span label", "explicit-input": "Explicit label", "aria-input": "Search the site",
    };
    for (const [id, name] of Object.entries(named)) {
      assert.equal(nameOf(id), name, `${id} should be named ${JSON.stringify(name)}`);
      assert.equal(flagged.has(id), false, `${id} must not be reported as nameless`);
    }
    // Genuinely nameless: empty or missing alt, a placeholder alt with no letter or digit, no content,
    // an icon hidden from assistive technology, an image hidden from assistive technology, an icon font,
    // a form field with no label at all.
    for (const id of ["alt-dot", "alt-empty", "alt-none", "no-content", "svg-hidden", "aria-hidden-img", "icon-font", "bare-input"]) {
      assert.equal(nameOf(id), null, `${id} has no usable name`);
      assert.equal(flagged.has(id), true, `${id} must be reported as nameless`);
    }
  } finally {
    server.close();
  }
});

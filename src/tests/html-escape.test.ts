import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, safeHref } from "../html-escape.js";

test("escapeHtml neutralizes every HTML-significant character", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('1')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;",
  );
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(7), "7");
});

test("safeHref allows only http, https, and mailto", () => {
  assert.equal(safeHref("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&amp;c=2");
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("mailto:qa@example.com"), "mailto:qa@example.com");
});

test("safeHref blocks script-bearing schemes so a scanned page cannot inject payloads", () => {
  for (const hostile of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(safeHref(hostile), "about:blank#blocked-scheme", hostile);
  }
});

test("safeHref keeps relative and fragment references usable", () => {
  assert.equal(safeHref("/reports/detail"), "/reports/detail");
  assert.equal(safeHref("#section-2"), "#section-2");
  assert.equal(safeHref("./sibling"), "./sibling");
  assert.equal(safeHref("../parent"), "../parent");
  assert.equal(safeHref(""), "about:blank#blocked-scheme");
});

test("safeHref escapes quotes so the attribute cannot be broken out of", () => {
  const rendered = safeHref('https://example.com/"onmouseover="alert(1)');
  assert.ok(!rendered.includes('"'), rendered);
  assert.match(rendered, /&quot;/);
});

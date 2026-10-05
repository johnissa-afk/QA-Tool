// Semantic MIME acceptance for the rendered email.
//
// An assertion like `assert(body.includes("https://..."))` on raw wire bytes is a
// test that passes until the SMTP library changes its line-wrapping policy, and
// then fails for a reason that has nothing to do with the product. Quoted-
// printable encoding inserts a soft line break (`=` at end of line) wherever it
// likes - typically at 76 characters - which is legal and invisible to the
// recipient's mail client, and catastrophic to a naive `includes()` check on a
// long URL.
//
// So these tests assert on MEANING, never on wire formatting: encode the way a
// real SMTP client encodes, decode the way a real mail client decodes, and then
// require the content to be present and intact. A test that survives a change in
// wrapping strategy is the point of the exercise.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emailDashboardLink,
  emailSubject,
  renderEmailMessage,
} from "../dashboard/email-transport.js";
import { notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";

// ---------------------------------------------------------------------------
// Encoding and decoding, the way the wire does it
// ---------------------------------------------------------------------------

/**
 * Quoted-printable encode, soft-wrapping at `width` characters.
 *
 * Works over UTF-8 BYTES, not code units: `=XX` escapes name bytes, so encoding
 * a character by its code point would emit a four-digit escape for anything
 * above U+00FF and produce a body no mail client could decode. The wrapping is
 * deliberately naive - it exists to reproduce the one behaviour that matters
 * here, which is that a long unbroken token gets split across lines with a
 * trailing `=`. If the real encoder ever wraps elsewhere, these assertions still
 * hold, because they are about the decoded result.
 */
const quotedPrintableEncode = (text: string, width = 76): string => {
  const encoded = [...Buffer.from(text, "utf8")]
    .map(byte => {
      if (byte === 0x3d) return "=3D"; // '='
      if (byte >= 33 && byte <= 126) return String.fromCharCode(byte);
      return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += width) lines.push(encoded.slice(i, i + width));
  return lines.join("=\r\n");
};

/** Decode quoted-printable, undoing soft line breaks. What a mail client does. */
const quotedPrintableDecode = (body: string): string => {
  const joined = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
};

/** Decode an RFC 2047 encoded-word subject, as a mail client's header parser would. */
const decodeEncodedWords = (subject: string): string =>
  subject.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset: string, encoding: string, payload: string) => {
    if (encoding.toUpperCase() === "B") return Buffer.from(payload, "base64").toString("utf8");
    const bytes: number[] = [];
    for (let i = 0; i < payload.length; i += 1) {
      if (payload[i] === "_") bytes.push(0x20);
      else if (payload[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(payload.slice(i + 1, i + 3))) {
        bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(payload.charCodeAt(i));
    }
    return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  });

/** Encodes a header value as an RFC 2047 `Q` encoded word, byte-for-byte. */
const toEncodedWordQ = (value: string): string => {
  const body = [...Buffer.from(value, "utf8")]
    .map(byte => {
      const ch = String.fromCharCode(byte);
      // Printable ASCII stays literal except the three specials Q must escape.
      if (byte >= 33 && byte <= 126 && ch !== "=" && ch !== "?" && ch !== "_") return ch;
      if (ch === " ") return "_";
      return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `=?UTF-8?Q?${body}?=`;
};

/** Wraps a value as a mail client would when it cannot send raw 8-bit bytes. */
const toEncodedWord = (value: string): string =>
  `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LONG_RUN = "run-20260930T070302Z-abcdefghijklmnopqrstuvwxyz-0123456789-long";
const LONG_FINDING = "QA-F-20260930-accessibility-contrast-with-a-deliberately-long-identifier";
const DASHBOARD = "http://127.0.0.1:4173/dashboard";

const notification = (overrides: Partial<Parameters<typeof notificationFromEvent>[0]> = {}) =>
  notificationFromEvent({
    type: "NEW_FINDING",
    projectId: "prj-20260930070302-6e919c",
    projectName: "A Project With A Long Name That Will Certainly Need Wrapping Somewhere",
    title: "Button lacks an accessible name",
    message: "The primary call to action exposes no accessible name to assistive technology.",
    runId: LONG_RUN,
    findingId: LONG_FINDING,
    severity: "HIGH",
    source: "finding-lifecycle",
    reference: LONG_FINDING,
    ...overrides,
  } as NotificationPreviewEvent, "2026-09-30T07:03:02.000Z");

// ===========================================================================
// 1. The link is whole in the message the recipient receives
// ===========================================================================

test("mime: a long dashboard link survives quoted-printable wrapping intact", () => {
  const note = notification();
  const message = renderEmailMessage(note, DASHBOARD);
  const expected = emailDashboardLink(note, DASHBOARD);

  assert.ok(expected, "this notification type carries a dashboard link");
  assert.ok(expected.length > 76, "the link is long enough to be wrapped, which is the point");

  // What the wire actually carries.
  const onTheWire = quotedPrintableEncode(message.text);

  // A naive substring check against the raw bytes would now fail...
  assert.equal(onTheWire.includes(expected), false,
    "confirming the fixture really does defeat a naive `includes` on wire bytes");
  assert.match(onTheWire, /=\r\n/, "the encoder really did soft-wrap");

  // ...and the recipient still gets a working link.
  const received = quotedPrintableDecode(onTheWire);
  assert.ok(received.includes(expected),
    "after decoding, the link is present exactly as composed, with no break inside it");
  assert.equal(received.includes(`${expected.slice(0, 40)}\r\n`), false,
    "and no line break interrupts it");
});

test("mime: the link points at the finding, encoded, and never at a raw unescaped id", () => {
  const note = notification();
  const link = emailDashboardLink(note, DASHBOARD)!;
  const message = renderEmailMessage(note, DASHBOARD);

  assert.match(link, /\?finding=QA-F-20260930/, "a finding notification deep-links to the finding");
  assert.ok(quotedPrintableDecode(quotedPrintableEncode(message.text)).includes(link));

  // An id that needs escaping must not be able to break out of the href.
  const awkward = notification({ findingId: "a b&c#d?e=f\"g'h<i>j" } as never);
  const awkwardLink = emailDashboardLink(awkward, DASHBOARD)!;
  assert.equal(awkwardLink.includes("&"), false, "the query is encoded, not concatenated raw");
  assert.equal(awkwardLink.includes(" "), false, "and contains no space to break the URL");
  assert.match(awkwardLink, /\?finding=a%20b%26c%23d%3Fe%3Df%22g'h/i);
});

// ===========================================================================
// 2. The subject survives RFC 2047 encoding
// ===========================================================================

test("mime: a non-ASCII subject survives RFC 2047 encoded-word encoding", () => {
  const note = notification({ projectName: "Kaufabteilung – Prüfung" } as never);
  const subject = emailSubject(note);

  // A mail client sends a non-ASCII subject as an encoded word.
  const onTheWire = toEncodedWordQ(subject);
  assert.equal(onTheWire.includes(subject), false,
    "the wire form is not the plain subject, so nothing can pass by comparing raw bytes");
  assert.match(onTheWire, /=E2=80/, "the non-ASCII bytes are hex-escaped, as Q requires");
  assert.equal(decodeEncodedWords(onTheWire), subject, "and it decodes back exactly");

  // The same for base64, which is what most clients actually choose.
  assert.equal(decodeEncodedWords(toEncodedWord(subject)), subject);

  // And the body carries the same project name, so subject and body cannot disagree.
  assert.ok(quotedPrintableDecode(quotedPrintableEncode(renderEmailMessage(note, DASHBOARD).text)).includes("Kaufabteilung – Prüfung"));
});

// ===========================================================================
// 3. Meaning survives, not formatting
// ===========================================================================

test("mime: every semantic field survives wrapping, checked as meaning", () => {
  const note = notification();
  const message = renderEmailMessage(note, DASHBOARD);
  const received = quotedPrintableDecode(quotedPrintableEncode(message.text));

  // Each of these is a separate line the recipient reads as a labelled value.
  for (const [label, value] of [
    ["Event", "NEW_FINDING"],
    ["Project", note.projectName],
    ["Severity", "HIGH"],
    ["Run", LONG_RUN],
    ["Finding", LONG_FINDING],
  ] as const) {
    assert.ok(
      received.includes(`${label}: ${value}`),
      `the "${label}" line reads as one field: "${label}: ${value}"`,
    );
  }

  assert.ok(received.includes(note.message), "the message body is intact");
  assert.ok(received.includes(`Recorded at: ${note.createdAt}`), "the timestamp is intact");

  // The wrapped body must not have grown a spurious blank-line paragraph in the
  // middle of a field, which is what hard wrapping (rather than soft) would do.
  assert.equal(/-\r?\n\s*\r?\n[^\s]/.test(received), false, "no field was split by a blank line");
});

test("mime: the HTML body escapes content and keeps the link clickable", () => {
  const note = notification({ projectName: '<script>alert("x")</script>' } as never);
  const message = renderEmailMessage(note, DASHBOARD);

  assert.equal(message.html.includes("<script>"), false, "no raw markup from a project name");
  assert.match(message.html, /&lt;script&gt;/);
  // The link survives HTML-escaping without becoming an entity soup of the URL.
  assert.match(message.html, /<a href="http:\/\/127\.0\.0\.1:4173\/dashboard\/projects\/prj-20260930070302-6e919c\?finding=QA-F-20260930[^"]*">/);
});

// ===========================================================================
// 4. Rendering is deterministic - the same notification renders the same bytes
// ===========================================================================

test("mime: rendering the same notification twice produces identical bytes", () => {
  const note = notification();
  const first = renderEmailMessage(note, DASHBOARD);
  const second = renderEmailMessage(note, DASHBOARD);
  assert.deepEqual(first, second, "the message is a pure function of the notification");

  // And after a quoted-printable round trip, still identical - encoding is
  // deterministic too, so a re-delivery is byte-identical rather than merely
  // equivalent.
  assert.equal(quotedPrintableDecode(quotedPrintableEncode(first.text)), quotedPrintableDecode(quotedPrintableEncode(second.text)));
});
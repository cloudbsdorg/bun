import { expect, test } from "bun:test";
import { Readable } from "node:stream";

// https://github.com/oven-sh/bun/issues/28928
// `new Request(input, init)` must inherit input's body when init does not
// provide its own (missing key, `undefined`, or `null`). Previously Bun
// hung forever reading the body of the cloned request because the inherited
// stream was dropped.

function streamRequest(payload: string) {
  const stream = Readable.toWeb(Readable.from([Buffer.from(payload)]));
  return new Request("http://localhost/test", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
}

test("new Request(original, { body: undefined }) inherits the source body", async () => {
  const cloned = new Request(streamRequest("hello undefined"), { body: undefined });
  expect(await cloned.text()).toBe("hello undefined");
});

test("new Request(original, {}) inherits the source body", async () => {
  const cloned = new Request(streamRequest("hello empty init"), {});
  expect(await cloned.text()).toBe("hello empty init");
});

test("new Request(original, { body: null }) inherits the source body", async () => {
  // Per the Fetch spec, `init["body"]` must be "exists and is non-null" to
  // override; an explicit `null` therefore falls back to the input body.
  const cloned = new Request(streamRequest("hello null"), { body: null });
  expect(await cloned.text()).toBe("hello null");
});

test("new Request(original, { method: 'POST' }) inherits the source body without a body key", async () => {
  const cloned = new Request(streamRequest("hello method-only"), { method: "POST" });
  expect(cloned.method).toBe("POST");
  expect(await cloned.text()).toBe("hello method-only");
});

test("new Request(original) still inherits the source body (no init)", async () => {
  const cloned = new Request(streamRequest("hello no init"));
  expect(await cloned.text()).toBe("hello no init");
});

test("new Request(original, init) preserves inherited headers alongside inherited body", async () => {
  const original = new Request("http://localhost/test", {
    method: "POST",
    body: Readable.toWeb(Readable.from([Buffer.from("payload")])),
    headers: { "x-custom": "value", "content-type": "application/json" },
    duplex: "half",
  });
  const cloned = new Request(original, { body: undefined });
  expect(cloned.headers.get("x-custom")).toBe("value");
  expect(cloned.headers.get("content-type")).toBe("application/json");
  expect(await cloned.text()).toBe("payload");
});

test("cloning via the constructor marks the source body unusable (matches Node)", async () => {
  // Per the Fetch spec, creating a proxy for the input body tees its
  // underlying stream, which locks the source. Node's undici raises
  // "Body is unusable" on subsequent reads; Bun should match. The
  // assertion deliberately exercises reading the source after the
  // two-arg constructor so this path can't regress into a hang.
  const original = streamRequest("locked after clone");
  const cloned = new Request(original, { body: undefined });
  expect(await cloned.text()).toBe("locked after clone");
  expect(async () => await original.text()).toThrow();
});

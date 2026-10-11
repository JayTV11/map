import test from "node:test";
import assert from "node:assert/strict";
import { basePath, url, wsUrl } from "../src/base";

test("root mount", () => {
  const l = { href: "https://soc.example/?view=console", protocol: "https:", host: "soc.example" };
  assert.equal(basePath(l), "/");
  assert.equal(url("/api/status", l), "/api/status");
  assert.equal(wsUrl("/ws", l), "wss://soc.example/ws");
});

test("sub-path mount", () => {
  for (const href of ["https://app.example/sightline/", "https://app.example/sightline/index.html?view=map"]) {
    const l = { href, protocol: "https:", host: "app.example" };
    assert.equal(basePath(l), "/sightline/");
    assert.equal(url("/api/known-good?cidr=1.2.3.4", l), "/sightline/api/known-good?cidr=1.2.3.4");
    assert.equal(wsUrl("/ws", l), "wss://app.example/sightline/ws");
  }
});

test("plain http uses ws", () => {
  const l = { href: "http://h/x/", protocol: "http:", host: "h" };
  assert.equal(wsUrl("/ws", l), "ws://h/x/ws");
});

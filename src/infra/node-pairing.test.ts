import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveNodePairing,
  ensurePairedNode,
  getPairedNode,
  requestNodePairing,
  updatePairedNodeMetadata,
  verifyNodeToken,
} from "./node-pairing.js";

async function setupPairedNode(baseDir: string): Promise<string> {
  const request = await requestNodePairing(
    {
      nodeId: "node-1",
      platform: "darwin",
      commands: ["system.run"],
    },
    baseDir,
  );
  await approveNodePairing(request.request.requestId, baseDir);
  const paired = await getPairedNode("node-1", baseDir);
  expect(paired).not.toBeNull();
  if (!paired) {
    throw new Error("expected node to be paired");
  }
  return paired.token;
}

describe("node pairing tokens", () => {
  test("reuses existing pending requests for the same node", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const first = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
      },
      baseDir,
    );
    const second = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
      },
      baseDir,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  test("generates base64url node tokens with 256-bit entropy output length", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const token = await setupPairedNode(baseDir);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("verifies token and rejects mismatches", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const token = await setupPairedNode(baseDir);
    await expect(verifyNodeToken("node-1", token, baseDir)).resolves.toEqual({
      ok: true,
      node: expect.objectContaining({ nodeId: "node-1" }),
    });
    await expect(verifyNodeToken("node-1", "x".repeat(token.length), baseDir)).resolves.toEqual({
      ok: false,
    });
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const token = await setupPairedNode(baseDir);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(verifyNodeToken("node-1", multibyteToken, baseDir)).resolves.toEqual({
      ok: false,
    });
  });
});

describe("node pairing store population on connect", () => {
  test("updatePairedNodeMetadata silently drops bin updates when node entry is missing", async () => {
    // This test documents the pre-fix broken behavior: when a node connects
    // and the gateway probes for bins, the results are lost because
    // updatePairedNodeMetadata returns early if nodes/paired.json has no entry.
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    // Simulate what happens when refreshRemoteNodeBins completes its probe
    // and tries to persist bins — but no node entry exists
    await updatePairedNodeMetadata("node-orphan", { bins: ["memo", "remindctl"] }, baseDir);

    // The bins were silently dropped — no entry was created
    const node = await getPairedNode("node-orphan", baseDir);
    expect(node).toBeNull();
  });

  test("ensurePairedNode creates a node entry when none exists", async () => {
    // Fix: ensurePairedNode is called when a node connects, ensuring the entry
    // exists before bin probes run.
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));
    const result = await ensurePairedNode(
      "node-2",
      {
        displayName: "Test Node",
        platform: "darwin",
        commands: ["system.run", "system.which"],
      },
      baseDir,
    );
    expect(result.created).toBe(true);

    const node = await getPairedNode("node-2", baseDir);
    expect(node).not.toBeNull();
    expect(node!.nodeId).toBe("node-2");
    expect(node!.displayName).toBe("Test Node");
    expect(node!.platform).toBe("darwin");
    expect(node!.commands).toEqual(["system.run", "system.which"]);
    expect(node!.token).toBeTruthy();
    expect(node!.createdAtMs).toBeGreaterThan(0);
    expect(node!.approvedAtMs).toBeGreaterThan(0);
    expect(node!.lastConnectedAtMs).toBeGreaterThan(0);
  });

  test("ensurePairedNode updates metadata without overwriting token or timestamps", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    const first = await ensurePairedNode(
      "node-3",
      { displayName: "Original Name", platform: "darwin" },
      baseDir,
    );
    expect(first.created).toBe(true);
    const original = await getPairedNode("node-3", baseDir);
    expect(original).not.toBeNull();

    // Reconnect with updated metadata
    const second = await ensurePairedNode(
      "node-3",
      { displayName: "Updated Name", platform: "darwin", commands: ["system.run"] },
      baseDir,
    );
    expect(second.created).toBe(false);

    const updated = await getPairedNode("node-3", baseDir);
    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe("Updated Name");
    expect(updated!.commands).toEqual(["system.run"]);
    expect(updated!.token).toBe(original!.token);
    expect(updated!.createdAtMs).toBe(original!.createdAtMs);
  });

  test("bin updates succeed after ensurePairedNode creates the entry", async () => {
    // This is the core regression test: the exact flow that was broken before.
    // 1. Node connects → ensurePairedNode creates entry (NEW)
    // 2. Bin probe runs → updatePairedNodeMetadata persists bins (NOW WORKS)
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-node-pairing-"));

    // Step 1: Node connects (our fix)
    await ensurePairedNode(
      "node-4",
      { platform: "darwin", commands: ["system.run", "system.which"] },
      baseDir,
    );

    // Step 2: Bin probe completes (existing code, previously lost results)
    await updatePairedNodeMetadata("node-4", { bins: ["memo", "remindctl"] }, baseDir);

    const node = await getPairedNode("node-4", baseDir);
    expect(node).not.toBeNull();
    expect(node!.bins).toEqual(["memo", "remindctl"]);
  });
});

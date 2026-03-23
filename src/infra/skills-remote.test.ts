import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
} from "./skills-remote.js";

describe("skills-remote global singleton", () => {
  it("shares remote node state across separate imports via globalThis", () => {
    // Before this fix, each dist bundle had its own module-level remoteNodes
    // Map. The gateway would populate it at startup, but the Discord bundle's
    // copy stayed empty — so getRemoteSkillEligibility() always returned
    // undefined in extension code paths.
    //
    // With the globalThis singleton, all accesses resolve to the same Map.
    // This test validates that nodes recorded by one caller are visible to
    // getRemoteSkillEligibility() in the same process (simulating cross-bundle
    // access).
    const nodeId = `node-singleton-${randomUUID()}`;
    const bin = `bin-singleton-${randomUUID()}`;
    try {
      // Simulate gateway registering a node (happens in server.impl.ts)
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Mac Mini",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeId, [bin]);

      // Simulate Discord extension checking eligibility (happens in
      // session-updates.ts) — before the fix this returned undefined
      const eligibility = getRemoteSkillEligibility();
      expect(eligibility).not.toBeUndefined();
      expect(eligibility?.hasBin(bin)).toBe(true);
      expect(eligibility?.platforms).toEqual(["darwin"]);
    } finally {
      removeRemoteNodeInfo(nodeId);
    }
  });
});

describe("skills-remote", () => {
  it("removes disconnected nodes from remote skill eligibility", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(() => {
      removeRemoteNodeInfo(nodeId);
      removeRemoteNodeInfo(nodeId);
    }).not.toThrow();
  });

  it("ignores non-mac and non-system.run nodes for eligibility", () => {
    const linuxNodeId = `node-${randomUUID()}`;
    const noRunNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: linuxNodeId,
        displayName: "Linux Box",
        platform: "linux",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(linuxNodeId, [bin]);

      recordRemoteNodeInfo({
        nodeId: noRunNodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.which"],
      });
      recordRemoteNodeBins(noRunNodeId, [bin]);

      expect(getRemoteSkillEligibility()).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(linuxNodeId);
      removeRemoteNodeInfo(noRunNodeId);
    }
  });

  it("aggregates bins and note labels across eligible mac nodes", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        platform: "macOS",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility();
      expect(eligibility?.platforms).toEqual(["darwin"]);
      expect(eligibility?.hasBin(binA)).toBe(true);
      expect(eligibility?.hasAnyBin([`missing-${randomUUID()}`, binB])).toBe(true);
      expect(eligibility?.note).toContain("Mac Studio");
      expect(eligibility?.note).toContain(nodeB);
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });
});

import { randomUUID } from "node:crypto";
import {
  createAsyncLock,
  pruneExpiredPending,
  readJsonFile,
  resolvePairingPaths,
  upsertPendingPairingRequest,
  writeJsonAtomic,
} from "./pairing-files.js";
import { rejectPendingPairingRequest } from "./pairing-pending.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

type NodePairingNodeMetadata = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
};

export type NodePairingPendingRequest = NodePairingNodeMetadata & {
  requestId: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type NodePairingPairedNode = Omit<NodePairingNodeMetadata, "requestId"> & {
  token: string;
  bins?: string[];
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
};

export type NodePairingList = {
  pending: NodePairingPendingRequest[];
  paired: NodePairingPairedNode[];
};

type NodePairingStateFile = {
  pendingById: Record<string, NodePairingPendingRequest>;
  pairedByNodeId: Record<string, NodePairingPairedNode>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;

const withLock = createAsyncLock();

async function loadState(baseDir?: string): Promise<NodePairingStateFile> {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  const [pending, paired] = await Promise.all([
    readJsonFile<Record<string, NodePairingPendingRequest>>(pendingPath),
    readJsonFile<Record<string, NodePairingPairedNode>>(pairedPath),
  ]);
  const state: NodePairingStateFile = {
    pendingById: pending ?? {},
    pairedByNodeId: paired ?? {},
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}

async function persistState(state: NodePairingStateFile, baseDir?: string) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
  await Promise.all([
    writeJsonAtomic(pendingPath, state.pendingById),
    writeJsonAtomic(pairedPath, state.pairedByNodeId),
  ]);
}

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function newToken() {
  return generatePairingToken();
}

export async function listNodePairing(baseDir?: string): Promise<NodePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByNodeId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

export async function getPairedNode(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  const state = await loadState(baseDir);
  return state.pairedByNodeId[normalizeNodeId(nodeId)] ?? null;
}

export async function requestNodePairing(
  req: Omit<NodePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const nodeId = normalizeNodeId(req.nodeId);
    if (!nodeId) {
      throw new Error("nodeId required");
    }

    return await upsertPendingPairingRequest({
      pendingById: state.pendingById,
      isExisting: (pending) => pending.nodeId === nodeId,
      isRepair: Boolean(state.pairedByNodeId[nodeId]),
      createRequest: (isRepair) => ({
        requestId: randomUUID(),
        nodeId,
        displayName: req.displayName,
        platform: req.platform,
        version: req.version,
        coreVersion: req.coreVersion,
        uiVersion: req.uiVersion,
        deviceFamily: req.deviceFamily,
        modelIdentifier: req.modelIdentifier,
        caps: req.caps,
        commands: req.commands,
        permissions: req.permissions,
        remoteIp: req.remoteIp,
        silent: req.silent,
        isRepair,
        ts: Date.now(),
      }),
      persist: async () => await persistState(state, baseDir),
    });
  });
}

export async function approveNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; node: NodePairingPairedNode } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }

    const now = Date.now();
    const existing = state.pairedByNodeId[pending.nodeId];
    const node: NodePairingPairedNode = {
      nodeId: pending.nodeId,
      token: newToken(),
      displayName: pending.displayName,
      platform: pending.platform,
      version: pending.version,
      coreVersion: pending.coreVersion,
      uiVersion: pending.uiVersion,
      deviceFamily: pending.deviceFamily,
      modelIdentifier: pending.modelIdentifier,
      caps: pending.caps,
      commands: pending.commands,
      permissions: pending.permissions,
      remoteIp: pending.remoteIp,
      createdAtMs: existing?.createdAtMs ?? now,
      approvedAtMs: now,
    };

    delete state.pendingById[requestId];
    state.pairedByNodeId[pending.nodeId] = node;
    await persistState(state, baseDir);
    return { requestId, node };
  });
}

export async function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  return await withLock(async () => {
    return await rejectPendingPairingRequest<
      NodePairingPendingRequest,
      NodePairingStateFile,
      "nodeId"
    >({
      requestId,
      idKey: "nodeId",
      loadState: () => loadState(baseDir),
      persistState: (state) => persistState(state, baseDir),
      getId: (pending: NodePairingPendingRequest) => pending.nodeId,
    });
  });
}

export async function verifyNodeToken(
  nodeId: string,
  token: string,
  baseDir?: string,
): Promise<{ ok: boolean; node?: NodePairingPairedNode }> {
  const state = await loadState(baseDir);
  const normalized = normalizeNodeId(nodeId);
  const node = state.pairedByNodeId[normalized];
  if (!node) {
    return { ok: false };
  }
  return verifyPairingToken(token, node.token) ? { ok: true, node } : { ok: false };
}

/**
 * Ensure a paired node entry exists for the given nodeId.
 * If the entry already exists, updates it with the provided metadata.
 * If it does not exist, creates a new entry.
 *
 * This is called when an authenticated node connects to the gateway so that
 * the node pairing store (`nodes/paired.json`) stays in sync with the device
 * pairing store. Without this, bin probe results from `refreshRemoteNodeBins`
 * silently fail to persist because `updatePairedNodeMetadata` returns early
 * when the node entry is missing.
 */
export async function ensurePairedNode(
  nodeId: string,
  metadata: {
    displayName?: string;
    platform?: string;
    version?: string;
    coreVersion?: string;
    uiVersion?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    remoteIp?: string;
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
  },
  baseDir?: string,
): Promise<{ created: boolean }> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (existing) {
      // Update metadata fields if the entry already exists
      const next: NodePairingPairedNode = {
        ...existing,
        displayName: metadata.displayName ?? existing.displayName,
        platform: metadata.platform ?? existing.platform,
        version: metadata.version ?? existing.version,
        coreVersion: metadata.coreVersion ?? existing.coreVersion,
        uiVersion: metadata.uiVersion ?? existing.uiVersion,
        deviceFamily: metadata.deviceFamily ?? existing.deviceFamily,
        modelIdentifier: metadata.modelIdentifier ?? existing.modelIdentifier,
        remoteIp: metadata.remoteIp ?? existing.remoteIp,
        caps: metadata.caps ?? existing.caps,
        commands: metadata.commands ?? existing.commands,
        permissions: metadata.permissions ?? existing.permissions,
        lastConnectedAtMs: Date.now(),
      };
      state.pairedByNodeId[normalized] = next;
      await persistState(state, baseDir);
      return { created: false };
    }

    // Create a new entry for this node
    const now = Date.now();
    const node: NodePairingPairedNode = {
      nodeId: normalized,
      token: newToken(),
      displayName: metadata.displayName,
      platform: metadata.platform,
      version: metadata.version,
      coreVersion: metadata.coreVersion,
      uiVersion: metadata.uiVersion,
      deviceFamily: metadata.deviceFamily,
      modelIdentifier: metadata.modelIdentifier,
      remoteIp: metadata.remoteIp,
      caps: metadata.caps,
      commands: metadata.commands,
      permissions: metadata.permissions,
      createdAtMs: now,
      approvedAtMs: now,
      lastConnectedAtMs: now,
    };
    state.pairedByNodeId[normalized] = node;
    await persistState(state, baseDir);
    return { created: true };
  });
}

export async function updatePairedNodeMetadata(
  nodeId: string,
  patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>,
  baseDir?: string,
) {
  await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return;
    }

    const next: NodePairingPairedNode = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      platform: patch.platform ?? existing.platform,
      version: patch.version ?? existing.version,
      coreVersion: patch.coreVersion ?? existing.coreVersion,
      uiVersion: patch.uiVersion ?? existing.uiVersion,
      deviceFamily: patch.deviceFamily ?? existing.deviceFamily,
      modelIdentifier: patch.modelIdentifier ?? existing.modelIdentifier,
      remoteIp: patch.remoteIp ?? existing.remoteIp,
      caps: patch.caps ?? existing.caps,
      commands: patch.commands ?? existing.commands,
      bins: patch.bins ?? existing.bins,
      permissions: patch.permissions ?? existing.permissions,
      lastConnectedAtMs: patch.lastConnectedAtMs ?? existing.lastConnectedAtMs,
    };

    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
  });
}

export async function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return null;
    }
    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("displayName required");
    }
    const next: NodePairingPairedNode = { ...existing, displayName: trimmed };
    state.pairedByNodeId[normalized] = next;
    await persistState(state, baseDir);
    return next;
  });
}

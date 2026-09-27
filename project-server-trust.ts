import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentPath } from "./agent-dir.ts";
import type { LoadedMcpConfig } from "./config.ts";
import { isServerDisabled, type McpConfig, type ProjectServerBlock, type ProjectServerBlockReason, type ServerDefinition } from "./types.ts";

const APPROVALS_VERSION = 1;
const APPROVALS_FILE = "mcp-project-approvals.json";
// Same registry key as config.ts; Symbol.for avoids a runtime import of config.ts.
const MCP_CONFIG_SOURCE_METADATA = Symbol.for("pi-mcp-adapter/config-source-metadata");

interface ApprovalRecord {
  projectRoot: string;
  serverName: string;
  definitionHash: string;
  approvedAt: string;
}

interface DenialRecord {
  projectRoot: string;
  serverName: string;
  definitionHash: string;
  deniedAt: string;
}

interface ApprovalStore {
  version: 1;
  approvals: ApprovalRecord[];
  denials: DenialRecord[];
}

export interface ProjectTrustResult {
  config: McpConfig;
  blockedServers: Map<string, ProjectServerBlock>;
}

export function describeProjectServerBlock(reason: ProjectServerBlockReason): string {
  switch (reason) {
    case "untrusted":
      return "blocked by project trust — trust the project to review and approve this server";
    case "approval-required":
      return "blocked: project server approval required — approve it in a trusted interactive session or set user-global settings.projectServers to \"allow\"";
    case "denied":
      return "blocked: project server approval denied — reload in a trusted interactive session to approve it";
  }
}

export function disabledServerReason(blocked: ReadonlyMap<string, ProjectServerBlock> | undefined, name: string): string {
  const block = blocked?.get(name);
  return block ? describeProjectServerBlock(block.reason) : `disabled. Run /mcp-adapter enable ${name} and /reload to enable it.`;
}

type ConfigWithSourceMetadata = McpConfig & {
  [MCP_CONFIG_SOURCE_METADATA]?: Pick<LoadedMcpConfig, "projectServers" | "projectServerPolicy">;
};

function asLoadedConfig(config: McpConfig): LoadedMcpConfig {
  const metadata = (config as ConfigWithSourceMetadata)[MCP_CONFIG_SOURCE_METADATA];
  return {
    config,
    projectServers: metadata?.projectServers ?? new Map(),
    projectServerPolicy: metadata?.projectServerPolicy ?? "ask",
  };
}

export function hasProjectServerDefinitions(config: McpConfig): boolean {
  return asLoadedConfig(config).projectServers.size > 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

export function hashProjectServerDefinition(definition: ServerDefinition): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(definition))).digest("hex");
}

export function canonicalProjectRoot(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function approvalPath(): string {
  return getAgentPath(APPROVALS_FILE);
}

function isDenialRecord(entry: unknown): entry is DenialRecord {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Partial<DenialRecord>;
  return typeof record.projectRoot === "string" && typeof record.serverName === "string"
    && typeof record.definitionHash === "string" && typeof record.deniedAt === "string";
}

function matchesApprovalIdentity(
  entry: { projectRoot: string; serverName: string; definitionHash: string },
  projectRoot: string,
  serverName: string,
  definitionHash: string,
): boolean {
  return entry.projectRoot === projectRoot && entry.serverName === serverName && entry.definitionHash === definitionHash;
}

function loadApprovals(): ApprovalStore {
  const path = approvalPath();
  if (!existsSync(path)) return { version: APPROVALS_VERSION, approvals: [], denials: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ApprovalStore>;
    if (parsed.version !== APPROVALS_VERSION || !Array.isArray(parsed.approvals)) throw new Error("invalid format");
    const approvals = parsed.approvals.filter((entry): entry is ApprovalRecord =>
      !!entry && typeof entry.projectRoot === "string" && typeof entry.serverName === "string"
      && typeof entry.definitionHash === "string" && typeof entry.approvedAt === "string");
    const denials = Array.isArray(parsed.denials) ? parsed.denials.filter(isDenialRecord) : [];
    return { version: APPROVALS_VERSION, approvals, denials };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`MCP: ignoring invalid project-server approval store ${path}: ${detail}`);
    return { version: APPROVALS_VERSION, approvals: [], denials: [] };
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withApprovalLock<T>(fn: () => T): T {
  const lockPath = `${approvalPath()}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
      break;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5_000) unlinkSync(lockPath);
      } catch {
        // Another writer removed or replaced the lock.
      }
      if (Date.now() - started > 2_000) throw new Error("Timed out waiting for the project-server approval store");
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock is already gone.
    }
  }
}

function writeApprovalStore(store: ApprovalStore): void {
  const path = approvalPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function mutateApprovals(mutate: (store: ApprovalStore) => void): void {
  withApprovalLock(() => {
    const store = loadApprovals();
    mutate(store);
    writeApprovalStore(store);
  });
}

function saveApproval(record: ApprovalRecord): void {
  mutateApprovals((store) => {
    store.denials = store.denials.filter(entry => !matchesApprovalIdentity(entry, record.projectRoot, record.serverName, record.definitionHash));
    store.approvals = store.approvals.filter(entry =>
      entry.projectRoot !== record.projectRoot || entry.serverName !== record.serverName);
    store.approvals.push(record);
  });
}

function recordDenial(projectRoot: string, serverName: string, definitionHash: string): void {
  mutateApprovals((store) => {
    store.denials = store.denials.filter(entry => !matchesApprovalIdentity(entry, projectRoot, serverName, definitionHash));
    store.denials.push({
      projectRoot,
      serverName,
      definitionHash,
      deniedAt: new Date().toISOString(),
    });
    store.approvals = store.approvals.filter(entry => !matchesApprovalIdentity(entry, projectRoot, serverName, definitionHash));
  });
}

export function approveProjectServer(cwd: string, serverName: string, definition: ServerDefinition): void {
  saveApproval({
    projectRoot: canonicalProjectRoot(cwd),
    serverName,
    definitionHash: hashProjectServerDefinition(definition),
    approvedAt: new Date().toISOString(),
  });
}

let nextApprovalPromptEpoch = 0;
const settledApprovalEpoch = new Map<string, number>();
const deniedApprovalPrompts = new Set<string>();

function approvalPromptKey(projectRoot: string, serverName: string, definitionHash: string): string {
  return `${projectRoot}\0${serverName}\0${definitionHash}`;
}

function scheduleApprovalPrompt(
  ctx: Pick<ExtensionContext, "ui">,
  projectRoot: string,
  serverName: string,
  definition: ServerDefinition,
  sourcePath: string,
  definitionHash: string,
): void {
  const key = approvalPromptKey(projectRoot, serverName, definitionHash);
  if (deniedApprovalPrompts.has(key)) return;
  const epoch = ++nextApprovalPromptEpoch;
  // Macrotask so later session_start handlers can install their editor first.
  // Awaiting confirm here lets setEditorComponent detach the selector without
  // resolving it, which pins initialization and stalls every later prompt.
  setTimeout(() => {
    if (deniedApprovalPrompts.has(key) || epoch < (settledApprovalEpoch.get(key) ?? 0)) return;
    try {
      void Promise.resolve(ctx.ui.confirm(
        `Allow project MCP server “${serverName}”?`,
        `Source: ${sourcePath}\nEndpoint: ${describeServer(definition)}\n\nThis server can run local commands or make network requests with your user permissions.\n\nApproving applies on the next /reload.`,
      )).then((allowed) => {
        // Scheduling another prompt must not discard this answer. Only a newer
        // settled decision wins, so a detached dialog cannot drop an Allow and
        // an older Allow cannot outlive a later Deny.
        if (epoch < (settledApprovalEpoch.get(key) ?? 0)) return;
        settledApprovalEpoch.set(key, epoch);
        if (!allowed) {
          deniedApprovalPrompts.add(key);
          try {
            recordDenial(projectRoot, serverName, definitionHash);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            try {
              ctx.ui.notify(`MCP: could not save denial for “${serverName}”: ${detail}`, "warning");
            } catch {
              // The session may already have shut down.
            }
          }
          return;
        }
        try {
          approveProjectServer(projectRoot, serverName, definition);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          try {
            ctx.ui.notify(`MCP: could not save approval for “${serverName}”: ${detail}`, "warning");
          } catch {
            // The session may already have shut down.
          }
          return;
        }
        try {
          ctx.ui.notify(`MCP: “${serverName}” approved. Run /reload to start it.`, "info");
        } catch {
          // The session may already have shut down.
        }
      }, () => {
        // The host rejected the dialog. A later initialization can prompt again.
      });
    } catch {
      // Pi throws on ctx.ui after reload. Leave the server unapproved so the next init can ask.
    }
  }, 0);
}

function describeServer(definition: ServerDefinition): string {
  if (definition.command) {
    return [definition.command, ...(definition.args ?? [])].map(value => JSON.stringify(value)).join(" ");
  }
  if (definition.url) return definition.url;
  if (definition.socket) return definition.socket;
  return "(no command or endpoint)";
}

export async function applyProjectServerTrust(
  loaded: LoadedMcpConfig,
  ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">,
): Promise<ProjectTrustResult> {
  const config: McpConfig = { ...loaded.config, mcpServers: { ...loaded.config.mcpServers } };
  const blockedServers = new Map<string, ProjectServerBlock>();
  if (loaded.projectServers.size === 0) return { config, blockedServers };

  let projectTrusted = false;
  try {
    projectTrusted = ctx.isProjectTrusted();
  } catch {
    projectTrusted = false;
  }
  const projectRoot = canonicalProjectRoot(ctx.cwd);
  const approvals = loadApprovals();

  for (const [name, source] of loaded.projectServers) {
    const definition = config.mcpServers[name];
    if (!definition || isServerDisabled(definition)) continue;
    const definitionHash = hashProjectServerDefinition(definition);
    const deniedOnDisk = approvals.denials.some(entry =>
      matchesApprovalIdentity(entry, projectRoot, name, definitionHash));
    const approved = !deniedOnDisk && approvals.approvals.some(entry =>
      matchesApprovalIdentity(entry, projectRoot, name, definitionHash));
    if (projectTrusted && !deniedOnDisk && (approved || (!ctx.hasUI && loaded.projectServerPolicy === "allow"))) continue;

    let reason: ProjectServerBlockReason;
    const promptKey = approvalPromptKey(projectRoot, name, definitionHash);
    if (deniedApprovalPrompts.has(promptKey)) {
      reason = "denied";
    } else if (!projectTrusted) {
      reason = "untrusted";
    } else if (!ctx.hasUI) {
      reason = deniedOnDisk ? "denied" : "approval-required";
    } else {
      reason = "approval-required";
      scheduleApprovalPrompt(ctx, projectRoot, name, definition, source.path, definitionHash);
    }
    config.mcpServers[name] = { ...definition, disabled: true };
    blockedServers.set(name, { reason, source });
  }

  return { config, blockedServers };
}

export function applyProjectServerTrustToConfig(
  config: McpConfig,
  ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">,
): Promise<ProjectTrustResult> {
  return applyProjectServerTrust(asLoadedConfig(config), ctx);
}

/** Remove project-derived servers before an ExtensionContext exists. */
export function excludeProjectServersAtLoadTime(loadedOrConfig: LoadedMcpConfig | McpConfig): McpConfig {
  const loaded = "config" in loadedOrConfig && "projectServers" in loadedOrConfig
    ? loadedOrConfig as LoadedMcpConfig
    : asLoadedConfig(loadedOrConfig as McpConfig);
  const config: McpConfig = { ...loaded.config, mcpServers: { ...loaded.config.mcpServers } };
  for (const name of loaded.projectServers.keys()) delete config.mcpServers[name];
  return config;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

describe("project MCP server trust", () => {
  let root: string;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-project-trust-"));
    home = join(root, "home");
    cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function load() {
    const config = await import("../config.ts");
    const trust = await import("../project-server-trust.ts");
    return { config, trust };
  }

  function context(overrides: Record<string, unknown> = {}) {
    return {
      cwd,
      hasUI: false,
      mode: "rpc",
      isProjectTrusted: () => true,
      ui: { confirm: vi.fn() },
      ...overrides,
    } as any;
  }

  it("tracks every project-scoped definition and excludes it before session trust is known", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { mcpServers: { inherited: { command: "global" } } });
    writeJson(join(cwd, ".mcp.json"), { mcpServers: {
      inherited: { args: ["project"] },
      local: { command: "node", lifecycle: "eager" },
    } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect([...loaded.projectServers.keys()].sort()).toEqual(["inherited", "local"]);
    expect(loaded.config.mcpServers.inherited).toEqual({ command: "global", args: ["project"] });
    expect(trust.excludeProjectServersAtLoadTime(loaded).mcpServers).toEqual({});
  });

  it("blocks project servers when Pi reports the project untrusted", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    const result = await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ isProjectTrusted: () => false, hasUI: true }),
    );

    expect(result.config.mcpServers.local.disabled).toBe(true);
    expect(result.blockedServers.get("local")?.reason).toBe("untrusted");
  });

  it("does not request approval for an inherited server disabled by project config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
      mcpServers: { inherited: { command: "global", args: ["server.js"] } },
    });
    writeJson(join(cwd, ".pi", "mcp-adapter.json"), {
      mcpServers: { inherited: { disabled: true } },
    });
    const { config, trust } = await load();
    const confirm = vi.fn();

    const result = await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui: { confirm } }),
    );

    expect(result.config.mcpServers.inherited?.disabled).toBe(true);
    expect(result.blockedServers.size).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not wait on a confirm dialog another extension can detach", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    const confirm = vi.fn(() => new Promise(() => {}));

    const result = await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui: { confirm } }),
    );

    expect(result.config.mcpServers.local.disabled).toBe(true);
    expect(result.blockedServers.get("local")?.reason).toBe("approval-required");
    expect(confirm).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(1);

    await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui: { confirm } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("prompts again when the approval dialog throws after the session is gone", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    const confirm = vi.fn(() => {
      throw new Error("ExtensionContext is no longer valid");
    });
    const ui = { confirm, notify: vi.fn() };

    await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("reports an approval that cannot be saved", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    const notify = vi.fn();
    const ui = { confirm: vi.fn().mockResolvedValue(true), notify };
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(dirname(agentDir), { recursive: true });
    writeFileSync(agentDir, "not a directory");

    await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not save approval"), "warning");
  });

  it("does not start a server whose denial outlives a failed approval removal", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node", args: ["one.js"] } } });
    const { config, trust } = await load();
    const confirm = vi.fn().mockResolvedValue(true);
    const ui = { confirm, notify: vi.fn() };
    await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const approvalPath = join(home, ".pi", "agent", "mcp-project-approvals.json");
    const saved = JSON.parse(readFileSync(approvalPath, "utf8")) as {
      approvals: Array<{ projectRoot: string; definitionHash: string }>;
      denials: unknown[];
    };
    saved.denials = [{
      projectRoot: saved.approvals[0]?.projectRoot,
      serverName: "local",
      definitionHash: saved.approvals[0]?.definitionHash,
      deniedAt: new Date().toISOString(),
    }];
    writeFileSync(approvalPath, `${JSON.stringify(saved)}\n`);
    vi.resetModules();
    const reloaded = await load();
    const result = await reloaded.trust.applyProjectServerTrust(
      reloaded.config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: false, mode: "print" }),
    );

    expect(result.config.mcpServers.local.disabled).toBe(true);
    expect(result.blockedServers.get("local")?.reason).toBe("denied");
  });

  it("keeps an approval for a different definition when another definition is denied", async () => {
    const path = join(cwd, ".mcp.json");
    writeJson(path, { mcpServers: { local: { command: "node", args: ["one.js"] } } });
    const { config, trust } = await load();
    const confirm = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const ui = { confirm, notify: vi.fn() };
    const ask = () => trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approvalPath = join(home, ".pi", "agent", "mcp-project-approvals.json");
    const approved = JSON.parse(readFileSync(approvalPath, "utf8")) as { approvals: Array<{ definitionHash: string }> };
    const approvedHash = approved.approvals[0]?.definitionHash;

    writeJson(path, { mcpServers: { local: { command: "node", args: ["two.js"] } } });
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stored = JSON.parse(readFileSync(approvalPath, "utf8")) as {
      approvals: Array<{ definitionHash: string }>;
      denials: Array<{ definitionHash: string }>;
    };

    expect(stored.approvals.map((entry) => entry.definitionHash)).toContain(approvedHash);
    expect(stored.denials.some((entry) => entry.definitionHash === approvedHash)).toBe(false);
    expect(stored.denials.length).toBe(1);
  });

  it("keeps an approval when a later prompt never settles", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    let resolveFirst: (allowed: boolean) => void = () => {};
    const confirm = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<boolean>(() => {}));
    const notify = vi.fn();
    const ui = { confirm, notify };
    const ask = () => trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );

    await ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(2);

    resolveFirst(true);
    await Promise.resolve();

    expect(existsSync(join(home, ".pi", "agent", "mcp-project-approvals.json"))).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("approved"), "info");
  });

  it("does not let an older approval override a later denial", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    let resolveFirst: (allowed: boolean) => void = () => {};
    let resolveSecond: (allowed: boolean) => void = () => {};
    const confirm = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSecond = resolve; }));
    const notify = vi.fn();
    const ui = { confirm, notify };
    const ask = () => trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui }),
    );

    await ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(2);

    resolveSecond(false);
    await Promise.resolve();
    resolveFirst(true);
    await Promise.resolve();

    expect(notify).not.toHaveBeenCalled();
    const stored = JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp-project-approvals.json"), "utf8")) as {
      approvals: unknown[];
    };
    expect(stored.approvals).toEqual([]);
    const denied = await ask();
    expect(denied.blockedServers.get("local")?.reason).toBe("denied");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("persists an interactive approval and re-prompts after the definition changes", async () => {
    const path = join(cwd, ".mcp.json");
    writeJson(path, { mcpServers: { local: { command: "node", args: ["one.js"] } } });
    const { config, trust } = await load();
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const ui = { confirm, notify };

    let result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui }));
    expect(result.blockedServers.get("local")?.reason).toBe("approval-required");
    expect(confirm).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(statSync(join(home, ".pi", "agent", "mcp-project-approvals.json")).mode & 0o777).toBe(0o600);

    result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui }));
    expect(result.blockedServers.size).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);

    writeJson(path, { mcpServers: { local: { command: "node", args: ["two.js"] } } });
    result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui }));
    expect(result.blockedServers.get("local")?.reason).toBe("approval-required");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("skips unapproved servers headlessly unless the global policy allows them", async () => {
    writeJson(join(cwd, ".mcp.json"), { settings: { projectServers: "allow" }, mcpServers: { local: { command: "node" } } });
    let modules = await load();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let loaded = modules.config.loadMcpConfigWithSources(undefined, cwd);
    expect(loaded.projectServerPolicy).toBe("ask");
    expect((await modules.trust.applyProjectServerTrust(loaded, context())).blockedServers.has("local")).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Ignoring settings.projectServers"));

    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { settings: { projectServers: "allow" }, mcpServers: {} });
    vi.resetModules();
    modules = await load();
    loaded = modules.config.loadMcpConfigWithSources(undefined, cwd);
    expect(loaded.projectServerPolicy).toBe("allow");
    expect((await modules.trust.applyProjectServerTrust(loaded, context())).blockedServers.size).toBe(0);
  });

  it("keeps denied project servers blocked for the session", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { url: "https://example.test/mcp" } } });
    const { config, trust } = await load();
    const confirm = vi.fn().mockResolvedValue(false);
    const ui = { confirm, notify: vi.fn() };
    const result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui }));

    expect(result.config.mcpServers.local.disabled).toBe(true);
    expect(result.blockedServers.get("local")?.reason).toBe("approval-required");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const denied = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui }));
    expect(denied.blockedServers.get("local")?.reason).toBe("denied");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain("example.test");
  });

  it("treats Claude-plugin servers enabled by project config as project-scoped", async () => {
    const plugin = join(cwd, "evil-plugin");
    writeJson(join(plugin, ".mcp.json"), { mcpServers: {
      evil: { command: "node", args: ["marker.js"], lifecycle: "eager" },
    } });
    writeJson(join(cwd, ".mcp.json"), {
      claudePlugins: [{ path: "./evil-plugin", mcp: true }],
      mcpServers: {},
    });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("evil")?.path).toBe(join(cwd, ".mcp.json"));
    const result = await trust.applyProjectServerTrust(loaded, context({ isProjectTrusted: () => false }));
    expect(result.config.mcpServers.evil).toMatchObject({ disabled: true, lifecycle: "eager" });
  });

  it("treats Agent Plugin servers enabled by project settings as project-scoped", async () => {
    const plugin = join(cwd, "evil-agent-plugin");
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "evil-agent",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { marker: { type: "stdio", command: "node", args: ["marker.js"] } },
    });
    writeJson(join(cwd, ".mcp.json"), {
      settings: { agentPluginPaths: ["./evil-agent-plugin"] },
      mcpServers: {},
    });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);
    const name = "evil-agent__marker";

    expect(loaded.projectServers.get(name)?.path).toBe(join(cwd, ".mcp.json"));
    const result = await trust.applyProjectServerTrust(loaded, context({ isProjectTrusted: () => false }));
    expect(result.config.mcpServers[name]).toMatchObject({ disabled: true, command: "node" });
  });

  it("gates repo-local imports enabled by global config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { imports: ["vscode"], mcpServers: {} });
    writeJson(join(cwd, ".vscode", "mcp.json"), { mcpServers: { host: { command: "node" } } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("host")?.path).toBe(join(cwd, ".vscode", "mcp.json"));
  });

  it("gates repo-local host discovery enabled by global config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
      settings: { hostConfigDiscovery: "on" },
      mcpServers: {},
    });
    writeJson(join(cwd, "opencode.json"), { mcp: {
      host: { type: "local", command: ["node", "marker.js"] },
    } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("host")?.path).toBe(join(cwd, "opencode.json"));
  });

  it("keeps home-level imports outside project-server gating", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { imports: ["cursor"], mcpServers: {} });
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { home: { command: "node" } } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.has("home")).toBe(false);
    expect(trust.excludeProjectServersAtLoadTime(loaded).mcpServers.home).toEqual({ command: "node" });
  });

  it("gates home-level imports requested by a project config", async () => {
    writeJson(join(cwd, ".mcp.json"), { imports: ["cursor"], mcpServers: {} });
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { home: { command: "node" } } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("home")?.path).toBe(join(cwd, ".mcp.json"));
  });

  it("treats Pi package servers enabled by project settings as project-scoped", async () => {
    const packageRoot = join(cwd, ".pi", "packages", "evil-package");
    writeJson(join(cwd, ".pi", "settings.json"), { packages: ["./packages/evil-package"] });
    writeJson(join(packageRoot, "package.json"), {
      name: "evil-package",
      pi: { mcp: "./mcp.json" },
    });
    writeJson(join(packageRoot, "mcp.json"), { mcpServers: {
      marker: { command: "node", args: ["marker.js"], lifecycle: "eager" },
    } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);
    const name = "evil-package__marker";

    expect(loaded.projectServers.get(name)?.path).toBe(join(cwd, ".pi", "settings.json"));
    const result = await trust.applyProjectServerTrust(loaded, context({ isProjectTrusted: () => false }));
    expect(result.config.mcpServers[name]).toMatchObject({ disabled: true, lifecycle: "eager" });
  });
});

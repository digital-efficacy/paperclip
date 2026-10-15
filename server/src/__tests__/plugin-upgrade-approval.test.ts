import { describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";


describe("plugin upgrade capability approval", () => {
  it("stages added UI capabilities without activating, then enables only on explicit admin action", async () => {
    let current = { ...pluginRecord, status: "ready", manifestJson: { id: "example.plugin", capabilities: ["ui.dashboardWidget.register"] } };
    mockRegistry.getById.mockImplementation(async () => current);
    mockRegistry.updateStatus.mockImplementation(async (_id, patch) => { current = { ...current, ...patch }; return current; });
    const next = { ...current.manifestJson, capabilities: ["ui.dashboardWidget.register", "ui.page.register"] };
    const loadSingle = vi.fn().mockResolvedValue({ success: true, plugin: current });
    const upgradePlugin = vi.fn().mockImplementation(async () => {
      const oldManifest = current.manifestJson;
      current = { ...current, manifestJson: next };
      return { oldManifest, newManifest: next, discovered: { version: "0.2.0" } };
    });
    const loader = { hasRuntimeServices: () => true, unloadSingle: vi.fn().mockResolvedValue(undefined), loadSingle, upgradePlugin } as unknown as PluginLoader;
    const lifecycle = pluginLifecycleManager({} as never, { loader });
    const pending = await lifecycle.upgrade("plugin-1", "0.2.0");
    expect(upgradePlugin).toHaveBeenCalledWith("plugin-1", { version: "0.2.0", deferCapabilityApproval: true });
    expect(pending.status).toBe("upgrade_pending");
    expect(loadSingle).not.toHaveBeenCalled();
    expect(pending.manifestJson.capabilities).toContain("ui.page.register");
    const enabled = await lifecycle.enable("plugin-1");
    expect(enabled.status).toBe("ready");
    expect(loadSingle).toHaveBeenCalledTimes(1);
  });
});

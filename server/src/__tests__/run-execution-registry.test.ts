import { afterEach, describe, expect, it } from "vitest";

import {
  registerServerAdapter,
  setOverridePaused,
  unregisterServerAdapter,
} from "../adapters/registry.ts";
import type { ServerAdapterModule } from "../adapters/types.ts";
import {
  activeRunExecutions,
  adapterTracksLocalChildProcess,
  isRunExecutingInProcess,
  moduleTracksLocalChildProcess,
  recordedProcessSpeaksForRun,
} from "../services/run-execution-registry.ts";

function stubAdapter(type: string, tracksLocalChildProcess?: boolean): ServerAdapterModule {
  return {
    type,
    ...(tracksLocalChildProcess === undefined ? {} : { tracksLocalChildProcess }),
    async execute() {
      throw new Error("not used");
    },
    async testEnvironment() {
      throw new Error("not used");
    },
  } as ServerAdapterModule;
}

describe("adapterTracksLocalChildProcess", () => {
  const registered: string[] = [];

  afterEach(() => {
    while (registered.length > 0) unregisterServerAdapter(registered.pop()!);
    activeRunExecutions.clear();
  });

  function register(adapter: ServerAdapterModule) {
    registerServerAdapter(adapter);
    registered.push(adapter.type);
  }

  it("keeps the built-in local-child adapters authoritative", () => {
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(true);
    expect(adapterTracksLocalChildProcess("codex_local")).toBe(true);
    // hermes_local is built elsewhere and declares nothing, so it still resolves
    // through the legacy fallback list.
    expect(adapterTracksLocalChildProcess("hermes_local")).toBe(true);
  });

  it("does not trust an unknown adapter's recorded pid", () => {
    // A plugin adapter registered through adapter-plugins.json is not in the
    // legacy list. It may well work in-process and report one transient child
    // per tool call, so its recorded pid is not the run's liveness.
    expect(adapterTracksLocalChildProcess("unregistered_plugin_local")).toBe(false);
    expect(adapterTracksLocalChildProcess("")).toBe(false);
  });

  it("lets a plugin adapter declare the capability either way", () => {
    register(stubAdapter("plugin_opt_in", true));
    register(stubAdapter("plugin_opt_out", false));
    register(stubAdapter("plugin_silent"));

    expect(adapterTracksLocalChildProcess("plugin_opt_in")).toBe(true);
    expect(adapterTracksLocalChildProcess("plugin_opt_out")).toBe(false);
    expect(adapterTracksLocalChildProcess("plugin_silent")).toBe(false);
  });

  // A paused override is still the module `findServerAdapter` returns, but it is
  // not the module that executes the run — `getServerAdapter` hands that to the
  // restored builtin. Resolving the capability off the paused module inverts the
  // pid authority in both directions.
  it("follows a paused override back to the builtin that actually executes", () => {
    // claude_local declares true; the override works in-process and declares false.
    register(stubAdapter("claude_local", false));
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(false);

    setOverridePaused("claude_local", true);
    // Execution is back on the builtin child process, so its dead pid is once
    // again evidence the run died. Reading the paused override here would leave
    // a dead run holding its issue lock forever.
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(true);

    setOverridePaused("claude_local", false);
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(false);
  });

  it("does not carry a paused override's opt-in onto a gateway builtin", () => {
    // hermes_gateway declares nothing and is not in the legacy list; the
    // override is backed by one long-lived child and declares true.
    expect(adapterTracksLocalChildProcess("hermes_gateway")).toBe(false);
    register(stubAdapter("hermes_gateway", true));
    expect(adapterTracksLocalChildProcess("hermes_gateway")).toBe(true);

    setOverridePaused("hermes_gateway", true);
    // The gateway builtin holds no local child. Keeping the override's opt-in
    // would terminalize a live run on a transient child's pid.
    expect(adapterTracksLocalChildProcess("hermes_gateway")).toBe(false);

    setOverridePaused("hermes_gateway", false);
  });
});

// The capability is a property of the module that executed the run, but the
// registry it lives in is mutable while runs execute: /api/adapters installs,
// uninstalls and pauses modules, and an agent's adapterType can be edited
// outright. Resolving by type at recovery time therefore answers "what would
// run this type now", which is a different question. These cover the stamp that
// closes the gap.
describe("recordedProcessSpeaksForRun", () => {
  const registered: string[] = [];

  afterEach(() => {
    while (registered.length > 0) unregisterServerAdapter(registered.pop()!);
  });

  function register(adapter: ServerAdapterModule) {
    registerServerAdapter(adapter);
    registered.push(adapter.type);
  }

  it("keeps a live in-process run's stamp when its adapter is uninstalled mid-run", () => {
    // The run spawned under an in-process plugin that overrode claude_local, so
    // its recorded pid is a finished tool call. Uninstalling the plugin restores
    // the builtin, which declares true. Re-resolving by type would read that
    // true and terminalize a live run on a dead transient pid.
    register(stubAdapter("claude_local", false));
    const stamped = moduleTracksLocalChildProcess(stubAdapter("claude_local", false), "claude_local");
    expect(stamped).toBe(false);

    unregisterServerAdapter(registered.pop()!);
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(true);
    expect(
      recordedProcessSpeaksForRun({ processTracksRun: stamped, adapterType: "claude_local" }),
    ).toBe(false);
  });

  it("keeps a dead child-process run terminalizable when an in-process override lands mid-run", () => {
    // The mirror image. The run spawned on the builtin child process, so its
    // dead pid is real evidence. An override installed since declares false;
    // honouring it would leave the dead run holding its issue lock forever.
    const stamped = moduleTracksLocalChildProcess(null, "claude_local");
    expect(stamped).toBe(true);

    register(stubAdapter("claude_local", false));
    expect(adapterTracksLocalChildProcess("claude_local")).toBe(false);
    expect(
      recordedProcessSpeaksForRun({ processTracksRun: stamped, adapterType: "claude_local" }),
    ).toBe(true);
  });

  it("ignores the agent's adapterType once the run is stamped", () => {
    // Editing an agent's adapterType mid-run repoints the type lookup at an
    // unrelated module. The stamp still describes the process that was spawned.
    expect(
      recordedProcessSpeaksForRun({ processTracksRun: true, adapterType: "some_gateway" }),
    ).toBe(true);
    expect(
      recordedProcessSpeaksForRun({ processTracksRun: false, adapterType: "claude_local" }),
    ).toBe(false);
  });

  it("falls back to the registry for runs recorded before the stamp existed", () => {
    // Null is "unknown", not "tracked": rows older than the column, and runs
    // that never reported a child.
    expect(
      recordedProcessSpeaksForRun({ processTracksRun: null, adapterType: "claude_local" }),
    ).toBe(true);
    expect(
      recordedProcessSpeaksForRun({ processTracksRun: undefined, adapterType: "plugin_unknown" }),
    ).toBe(false);
    expect(recordedProcessSpeaksForRun({ processTracksRun: null, adapterType: null })).toBe(false);
  });
});

describe("moduleTracksLocalChildProcess", () => {
  it("reads the module it is handed, falling back to the legacy list", () => {
    expect(moduleTracksLocalChildProcess(stubAdapter("x", true), "x")).toBe(true);
    expect(moduleTracksLocalChildProcess(stubAdapter("x", false), "x")).toBe(false);
    // Declares nothing: the legacy list answers, by type.
    expect(moduleTracksLocalChildProcess(stubAdapter("hermes_local"), "hermes_local")).toBe(true);
    expect(moduleTracksLocalChildProcess(stubAdapter("hermes_gateway"), "hermes_gateway")).toBe(false);
  });
});

describe("isRunExecutingInProcess", () => {
  afterEach(() => activeRunExecutions.clear());

  it("sees an in-process adapter execution, not only a child process handle", () => {
    // The recovery backstop used to read runningProcesses alone, so a run that
    // was live inside adapter.execute() looked exactly like a crashed one.
    expect(isRunExecutingInProcess("run-1")).toBe(false);
    activeRunExecutions.add("run-1");
    expect(isRunExecutingInProcess("run-1")).toBe(true);
    activeRunExecutions.delete("run-1");
    expect(isRunExecutingInProcess("run-1")).toBe(false);
  });
});

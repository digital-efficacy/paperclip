// Shared, module-level registry of runs this server process is executing.
//
// Two independent things make a heartbeat run live inside this process, and
// until now only one of them was visible outside heartbeat.ts:
//
// - `runningProcesses` (adapters/utils.js): the run is carried by a local child
//   process that the server spawned and still holds a handle to.
// - `activeRunExecutions` (below): the run is executing in-process, inside an
//   `adapter.execute()` call. Adapters that drive a local HTTP server or an SDK
//   — including every plugin adapter — are live this way and never appear in
//   `runningProcesses`.
//
// The recovery backstop consulted only the first, so an in-process execution
// looked exactly like a crashed one and got terminalized mid-run. Both live
// here so heartbeat.ts and recovery/service.ts share one answer instead of each
// keeping a partial view.
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { ServerAdapterModule } from "../adapters/types.js";

// Routes and the scheduler construct separate heartbeatService instances, but
// they must agree on in-process adapter executions when reaping stale runs.
export const activeRunExecutions = new Set<string>();

/**
 * True when this server process is still executing the run, either as a local
 * child process or as an in-process `adapter.execute()` call. A false answer is
 * not by itself proof the run is dead: the server may have restarted since the
 * run started, which is exactly the case the process-death authority exists to
 * catch.
 */
export function isRunExecutingInProcess(runId: string): boolean {
  return runningProcesses.has(runId) || activeRunExecutions.has(runId);
}

// Adapters that predate the `tracksLocalChildProcess` capability flag. Each one
// runs its agent as a single long-lived local child process, so a dead recorded
// pid means a dead run. Kept only as the fallback for adapters that declare
// nothing; new adapters should declare the capability instead of being added
// here.
const LEGACY_LOCAL_CHILD_PROCESS_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

/**
 * True when the pid a module reports through `onSpawn` describes the process
 * that carries the run, so its death is evidence the run died.
 *
 * Takes the module rather than looking one up, so a caller that already holds
 * the executing module — heartbeat, at the moment it records the pid — asks
 * about that module and not about whatever the registry says later.
 *
 * Adapters that declare nothing resolve through the legacy list, so a plugin
 * adapter is false unless it opts in: `onSpawn` is free to report short-lived
 * children, and an adapter that shells out per tool call reports one child per
 * `run_command` whose pid dies within seconds while the run keeps working.
 */
export function moduleTracksLocalChildProcess(
  adapter: Pick<ServerAdapterModule, "tracksLocalChildProcess"> | null,
  adapterType: string,
): boolean {
  if (adapter && typeof adapter.tracksLocalChildProcess === "boolean") {
    return adapter.tracksLocalChildProcess;
  }
  return LEGACY_LOCAL_CHILD_PROCESS_ADAPTERS.has(adapterType);
}

/**
 * The same question asked of the registry as it stands *now*, for callers that
 * have only an adapter type. This is a guess about a run, not a fact about it:
 * see `recordedProcessSpeaksForRun` for why, and prefer that entry point.
 *
 * Resolution goes through `getServerAdapter`, the same call execution uses to
 * pick the module it hands the run to. It must, because an external override
 * can be paused: `findServerAdapter` would still return the paused external
 * module while the run actually executed on the restored builtin fallback, and
 * the two need not agree on this flag.
 */
export function adapterTracksLocalChildProcess(adapterType: string): boolean {
  // Never null: unknown types fall back to the process adapter, which is also
  // what would execute them.
  return moduleTracksLocalChildProcess(getServerAdapter(adapterType), adapterType);
}

/**
 * Whether a run's recorded pid speaks for that run.
 *
 * Prefers `heartbeat_runs.process_tracks_run`, stamped by the module that was
 * executing when it reported the child. Re-resolving the capability from the
 * registry instead would answer a different question — "what would execute this
 * adapter type right now" — and the two come apart, because the registry is
 * mutable while a run executes: `POST /adapters` installs a module, the
 * uninstall and pause routes remove or shadow one, and an agent's `adapterType`
 * can be edited outright. Any of those between spawn and sweep inverts the pid
 * authority in one of two directions:
 *
 * - A live in-process run whose adapter is uninstalled falls back to a builtin
 *   that declares `true`, so the transient pid of a finished `run_command` is
 *   read as run death and the run is terminalized mid-flight — the exact
 *   kill/wake loop this authority was narrowed to stop.
 * - A dead child-process run whose type is overridden by an in-process module
 *   declaring `false` stops being terminalizable and keeps its issue lock
 *   forever.
 *
 * `processTracksRun` is null for runs recorded before the column existed and
 * for runs that never reported a child. Those fall back to registry resolution,
 * which is what the caller would have done anyway.
 */
export function recordedProcessSpeaksForRun(input: {
  processTracksRun: boolean | null | undefined;
  adapterType: string | null;
}): boolean {
  if (typeof input.processTracksRun === "boolean") return input.processTracksRun;
  return adapterTracksLocalChildProcess(input.adapterType ?? "");
}

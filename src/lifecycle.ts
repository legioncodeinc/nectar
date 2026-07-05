/**
 * The `nectar start` / `stop` / `uninstall` lifecycle orchestration (PRD-003b
 * b-AC-1/2/3/4/6).
 *
 * These verbs FRONT the machinery nectar already has - the OS service module
 * (`service/index.ts`), the daemon lock/pid files (`lock.ts`), the doctor
 * registry writer (`doctor-registry.ts`), and the fleet-root state dir
 * (`apiary-root.ts`) - never fork it. Every external effect is behind an
 * injectable seam so the orchestration is fully hermetic in tests (no real
 * service manager, no real signals, no real home dir).
 *
 * - start: already-running -> a friendly no-op; otherwise start the registered
 *   OS unit, falling back to a direct detached spawn when no unit is registered.
 * - stop: best-effort stop the OS unit AND signal the running pid, so both a
 *   service-managed and a directly-spawned daemon stop. Idempotent (a not-running
 *   daemon is a friendly no-op).
 * - uninstall: the three-part contract in order - stop the daemon, remove the OS
 *   unit (current + legacy best-effort), delete nectar's doctor registry entry,
 *   remove nectar's state dir (resolved absolute path only, never a glob, never
 *   following a symlink out of the root). Each step is best-effort with a
 *   per-step report; a not-installed machine exits 0 "nothing to remove" (b-AC-6);
 *   a real per-step failure exits 1 with a plain-language, actionable error.
 *   The CURRENT-label service unit is the one exception to "best-effort never
 *   fails the run": {@link ServiceModule.uninstall} classifies its own outcome
 *   (see {@link ServiceUninstallResult}), and a GENUINE removal failure (not
 *   merely the unit having been already absent) is a hard failure here too -
 *   a swallowed error there would leave a unit that resurrects on next boot
 *   while `nectar uninstall` reports success (b-AC-2 / AC-9). The remaining
 *   steps still run best-effort so a partial uninstall never wedges. The
 *   legacy-label deregister stays fully best-effort/non-fatal, since a legacy
 *   unit being absent is the norm, not the exception.
 *
 * Built-ins only.
 */
import type { ServiceModule, ServiceResult, ServiceUninstallResult } from "./service/index.js";
import type { DeregisterResult } from "./doctor-registry.js";

/** The output/error sinks the verbs write through (injected so tests capture them). */
export interface LifecycleIo {
  out(line: string): void;
  err(line: string): void;
}

// ── start ────────────────────────────────────────────────────────────────────

export interface StartLifecycleDeps {
  readonly service: ServiceModule;
  /** True when a live daemon currently holds the lock. */
  isDaemonRunning(): boolean;
  /** The pid recorded in the pid/lock file, or null. */
  readPid(): number | null;
  /** Directly spawn the daemon (detached). Returns the spawned pid, or null on failure. */
  spawnDaemon(): number | null;
  readonly io: LifecycleIo;
}

/**
 * `nectar start` (b-AC-1). If a daemon is already running, a friendly no-op.
 * Otherwise start the registered OS unit; if no unit is registered (the manager
 * start argv fails), fall back to a direct detached spawn.
 */
export async function runStartLifecycle(deps: StartLifecycleDeps): Promise<number> {
  if (deps.isDaemonRunning()) {
    const pid = deps.readPid();
    deps.io.out(`nectar is already running${pid !== null ? ` (pid ${pid})` : ""}.`);
    return 0;
  }
  const viaService = await deps.service.start();
  if (viaService.ok) {
    deps.io.out(viaService.message);
    return 0;
  }
  const pid = deps.spawnDaemon();
  if (pid === null) {
    deps.io.err(
      `nectar start: could not start via the OS service (${viaService.message}) and the direct spawn failed. ` +
        "Try 'nectar daemon' in a terminal to see the error.",
    );
    return 1;
  }
  deps.io.out(`nectar daemon started directly (pid ${pid}).`);
  return 0;
}

// ── stop ─────────────────────────────────────────────────────────────────────

export interface StopLifecycleDeps {
  readonly service: ServiceModule;
  isDaemonRunning(): boolean;
  readPid(): number | null;
  /** Send a signal to a pid; returns true when the signal was delivered. */
  sendSignal(pid: number, signal: NodeJS.Signals): boolean;
  readonly io: LifecycleIo;
}

/**
 * `nectar stop` (b-AC-1). Best-effort stops the registered OS unit AND signals
 * the running pid, so both a service-managed and a directly-spawned daemon stop.
 * A not-running daemon is a friendly no-op. Always exits 0 (idempotent, AC-9).
 */
export async function runStopLifecycle(deps: StopLifecycleDeps): Promise<number> {
  const running = deps.isDaemonRunning();
  const pid = deps.readPid();
  if (!running && pid === null) {
    deps.io.out("nectar is not running; nothing to stop.");
    return 0;
  }
  const viaService = await deps.service.stop();
  if (viaService.ok) deps.io.out(viaService.message);
  let signalled = false;
  if (pid !== null) signalled = deps.sendSignal(pid, "SIGTERM");
  if (signalled) deps.io.out(`Sent SIGTERM to the nectar daemon (pid ${pid}).`);
  if (!viaService.ok && !signalled) {
    deps.io.out("nectar stop: no running daemon was signalled (it may already be stopped).");
  }
  return 0;
}

// ── uninstall ──────────────────────────────────────────────────────────────────

/** The classified outcome of removing nectar's state dir. */
export type StateDirRemovalStatus = "removed" | "absent" | "skipped-symlink" | "failed";

export interface StateDirRemovalResult {
  readonly status: StateDirRemovalStatus;
  readonly path: string;
  readonly reason?: string;
}

/** The minimal fs surface {@link removeStateDir} needs (injected so tests are hermetic). */
export interface StateDirFs {
  isAbsolute(path: string): boolean;
  exists(path: string): boolean;
  /** True iff the path itself is a symlink (an lstat, NOT following it). */
  isSymlink(path: string): boolean;
  /** Recursively remove the directory (force). Never follows a symlink out of the root. */
  rm(path: string): void;
}

/**
 * Remove nectar's state dir by RESOLVED ABSOLUTE PATH only (b-AC-4 / AC-8): a
 * non-absolute path is refused; an absent dir is a clean no-op; a path that is
 * itself a symlink is refused (so a symlinked state dir never lets a delete
 * escape the fleet root). Never globs. Returns the classified outcome.
 */
export function removeStateDir(dir: string, fs: StateDirFs): StateDirRemovalResult {
  if (!fs.isAbsolute(dir)) {
    return { status: "failed", path: dir, reason: "refusing to remove a non-absolute state dir path" };
  }
  if (!fs.exists(dir)) return { status: "absent", path: dir };
  if (fs.isSymlink(dir)) return { status: "skipped-symlink", path: dir };
  try {
    fs.rm(dir);
    return { status: "removed", path: dir };
  } catch (err) {
    return { status: "failed", path: dir, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface UninstallLifecycleDeps {
  readonly service: ServiceModule;
  isDaemonRunning(): boolean;
  readPid(): number | null;
  sendSignal(pid: number, signal: NodeJS.Signals): boolean;
  /** Delete nectar's entry from doctor's registry file(s). */
  deregisterFromDoctor(): DeregisterResult;
  /** Remove nectar's resolved state dir (guarded). */
  removeStateDir(): StateDirRemovalResult;
  readonly io: LifecycleIo;
}

/**
 * `nectar uninstall` (b-AC-2/3/4/6): the three-part contract in order. Each step
 * is best-effort with a per-step report. A not-installed machine exits 0 with a
 * friendly "nothing to remove" (b-AC-6); a real failure (a malformed registry it
 * could not rewrite, or a state-dir removal error) exits 1 with an actionable
 * message.
 */
export async function runUninstallLifecycle(deps: UninstallLifecycleDeps): Promise<number> {
  const io = deps.io;
  let hardFailure = false;

  // 1. Stop the daemon (so doctor never sees a registered-but-gone product mid-flight).
  const daemonWasRunning = deps.isDaemonRunning();
  const pid = deps.readPid();
  await deps.service.stop();
  if (pid !== null) deps.sendSignal(pid, "SIGTERM");
  if (daemonWasRunning) io.out("Stopped the running nectar daemon.");

  // 2. Remove the OS service unit (current label, plus best-effort legacy label).
  // b-AC-2 / AC-9: a GENUINE current-unit removal failure (classified by the
  // service module, not merely "the unit was already absent") is a hard
  // failure - it must not be swallowed into a reported success while a
  // boot-resurrecting unit survives. The already-absent case stays the
  // friendly no-op it always was.
  const unit: ServiceUninstallResult = await deps.service.uninstall();
  const legacy: ServiceResult = await deps.service.deregisterLegacy();
  const serviceRemoved = unit.ok;
  if (unit.ok || unit.alreadyAbsent) {
    io.out(unit.message);
  } else {
    hardFailure = true;
    io.err(`Could not remove the nectar service unit: ${unit.message}`);
  }
  io.out(legacy.message);

  // 3. Delete nectar's doctor registry entry (leaving every other entry intact).
  const registry = deps.deregisterFromDoctor();
  for (const f of registry.files) {
    if (f.error !== null) {
      hardFailure = true;
      io.err(`Could not update the doctor registry at ${f.registryPath}: ${f.error}`);
    } else if (f.removed) {
      io.out(`Deleted nectar's doctor registry entry from ${f.registryPath}.`);
    }
  }

  // 4. Remove nectar's state dir (resolved absolute path only, no symlink follow).
  const dir = deps.removeStateDir();
  switch (dir.status) {
    case "removed":
      io.out(`Removed nectar's state dir at ${dir.path}.`);
      break;
    case "absent":
      break;
    case "skipped-symlink":
      io.err(`Skipped nectar's state dir at ${dir.path}: it is a symlink; remove it manually if that was intended.`);
      break;
    case "failed":
      hardFailure = true;
      io.err(`Could not remove nectar's state dir at ${dir.path}: ${dir.reason ?? "unknown error"}`);
      break;
    default: {
      const unreachable: never = dir.status;
      throw new Error(`unhandled state-dir status: ${String(unreachable)}`);
    }
  }

  const anythingRemoved = daemonWasRunning || serviceRemoved || registry.removedAny || dir.status === "removed";

  if (hardFailure) {
    io.err(
      "nectar uninstall: one or more steps failed (see above). Resolve them and re-run 'nectar uninstall', " +
        "or remove the paths manually.",
    );
    return 1;
  }
  if (!anythingRemoved) {
    io.out("nectar uninstall: nothing to remove; nectar does not appear to be installed.");
    return 0;
  }
  io.out("nectar uninstall: done. (The npm package itself is left in place; remove it with your package manager if desired.)");
  return 0;
}

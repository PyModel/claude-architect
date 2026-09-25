// This dependency-free entrypoint must remain parseable by Node.js 20 so it can supervise producer
// processes independently of the bundled runtime. It kills the producer process group when the MCP
// server that launched it is no longer alive.
//
// POSIX contract: the runtime spawns this watchdog as the leader of a new process group, and the
// producer stays in that same group. Every tree teardown — the supervisor's SIGKILL escalation and
// startup recovery, which both signal the watchdog's group — therefore reaches the producer too. A
// producer in a group of its own survived the uncatchable SIGKILL that removed its watchdog.
import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 5_000;
const TERMINATION_GRACE_MS = 5_000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const [supervisorArg, separator, command, ...args] = process.argv.slice(2);

if (separator !== "--" || command === undefined) {
  process.stderr.write("usage: watchdog.mjs <supervisorPid> -- <cmd> [args...]\n");
  process.exit(64);
}

const supervisorPid = Number(supervisorArg);
// Windows has no POSIX process groups or signals; its process-tree teardown is
// handled separately by the Job Object helper.
const isWindows = process.platform === "win32";
const child = spawn(command, args, { stdio: "inherit" });
let supervisorGone = false;
let terminationTimer = null;

function signalChild(signal) {
  try {
    process.kill(child.pid, signal);
  } catch {
    // The child has already exited.
  }
}

// The whole group: this watchdog, the producer, and everything it spawned.
function killTree(signal) {
  try {
    if (isWindows) process.kill(child.pid, signal);
    else process.kill(-process.pid, signal);
  } catch {
    // The group has already exited.
  }
}

// A signal sent to the group already reached the producer; one sent to this
// process alone is relayed so the producer can shut down cleanly.
const signalHandlers = new Map(FORWARDED_SIGNALS.map(signal => [
  signal,
  () => signalChild(signal),
]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

const poll = setInterval(() => {
  if (supervisorGone) return;
  try {
    process.kill(supervisorPid, 0);
  } catch {
    supervisorGone = true;
    killTree("SIGTERM");
    terminationTimer = setTimeout(() => killTree("SIGKILL"), TERMINATION_GRACE_MS);
  }
}, POLL_INTERVAL_MS);

function cleanup() {
  clearInterval(poll);
  if (terminationTimer !== null) clearTimeout(terminationTimer);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}

child.once("error", () => {
  cleanup();
  process.exit(1);
});

child.once("exit", (code, signal) => {
  cleanup();
  // An orphaned tree is torn down completely: the producer's own children must
  // not outlive it just because the producer exited within the grace period.
  if (supervisorGone) killTree("SIGKILL");
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

// Adapted from pi-patty-bg-tasks (MIT). See ../PROVENANCE.md.
/** A process-group anchor. The IPC descriptor is owned only by the Pi process
 * and this supervisor (never inherited by commands). EOF therefore detects even
 * SIGKILL of Pi. Keeping the group leader alive until cleanup prevents PGID/PID
 * reuse while signalling. POSIX only: descendants which call setsid/setpgid can
 * escape; fully containing those requires an OS-managed cgroup/job object.
 * No stale numeric PID is used by the hard-parent-death cleanup path. */
export const supervisorSource = `
const { spawn } = require('node:child_process');
const [file, argv] = JSON.parse(process.argv[1]);
let stopping = false;
function cleanup() {
  if (stopping) return;
  stopping = true;
  // This process is still the group leader, pinning its identity.
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
}
process.on('disconnect', cleanup);
process.on('error', cleanup);
process.on('message', message => {
  if (!message || typeof message.signal !== 'string') return;
  // Only the live group anchor uses a numeric group ID. A stale parent
  // capability cannot send this request to a recycled PID/process group.
  try { process.kill(-process.pid, message.signal); } catch { /* gone/invalid */ }
});
// Group SIGTERM reaches the command too. Hold the group identity until a
// resistant command is forcibly killed; do not leave descendants behind.
process.on('SIGTERM', () => { setTimeout(cleanup, 1000); });
process.on('SIGINT', () => { setTimeout(cleanup, 1000); });
const child = spawn(file, argv, { stdio: ['ignore', 1, 2] });
let reported = false;
function finish(code, signal) {
  if (reported) return;
  reported = true;
  try {
    if (process.connected) process.send({ code, signal }, cleanup);
    else cleanup();
  } catch { cleanup(); }
}
child.on('error', err => {
  console.error('Failed to spawn command:', err.message);
  finish(1, null);
});
child.on('exit', finish);
if (!process.connected) cleanup();
`;

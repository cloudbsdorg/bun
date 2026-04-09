import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

// https://github.com/oven-sh/bun/issues/29043
//
// Worker error event must honor preventDefault(): when the worker's own
// `error` event listener cancels the event, the error must not propagate to
// the parent Worker and the worker must not be terminated with exit code 1.

// Build the harness that spawns a child bun, which in turn creates the
// worker, reads its output, and waits for the worker to exit before the
// parent exits so the 'exit' event is observable.
function buildHarness(workerCode: string, workerOpts: string = "{ eval: true }"): string {
  return `
    import { Worker } from 'node:worker_threads';

    const workerCode = ${JSON.stringify(workerCode)};

    const worker = new Worker(workerCode, ${workerOpts});

    const errors = [];
    worker.on('error', (err) => {
      errors.push(err && err.message);
    });

    const workerExitCode = await new Promise((resolve) => {
      worker.on('exit', resolve);
    });
    console.log('exit:' + workerExitCode);
    if (errors.length !== 0) {
      console.log('PARENT_ERROR_COUNT:' + errors.length);
      process.exit(2);
    }
  `;
}

async function runWorker(workerCode: string, workerOpts?: string) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", buildHarness(workerCode, workerOpts)],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

test("Worker error event preventDefault() stops propagation and keeps worker running (async throw)", async () => {
  // The throw is inside a microtask, so the `error` listener is already
  // installed when it fires. This exercises the runtime `onUnhandledRejection`
  // path in `web_worker.zig`.
  const { stdout, exitCode } = await runWorker(`
    globalThis.addEventListener('error', (e) => {
      console.log('handled:' + (e.error && e.error.message));
      e.preventDefault();
    });

    queueMicrotask(() => {
      throw new Error('hmm');
    });

    // Keep the worker alive long enough to confirm it didn't terminate on
    // the error, then exit cleanly so the parent's 'exit' event fires.
    setImmediate(() => {
      setImmediate(() => {
        console.log('alive');
        process.exit(0);
      });
    });
  `);

  // The worker's own handler should have seen the error,
  // the worker should have kept running to print 'alive',
  // and the parent worker should have seen exit code 0 without any 'error' event.
  expect(stdout).toContain("handled:hmm");
  expect(stdout).toContain("alive");
  expect(stdout).toContain("exit:0");
  expect(stdout).not.toContain("PARENT_ERROR");
  expect(exitCode).toBe(0);
});

test("Worker error event preventDefault() stops propagation and keeps worker running (top-level throw)", async () => {
  // The throw happens during module evaluation, so it flows through the
  // rejected-promise branch in `spin()` rather than the runtime microtask
  // path. The `addEventListener` call is already evaluated by the time the
  // throw happens because statements run top-to-bottom.
  const { stdout, exitCode } = await runWorker(`
    globalThis.addEventListener('error', (e) => {
      console.log('handled:' + (e.error && e.error.message));
      e.preventDefault();
    });

    // Schedule a macrotask so the worker has something to do after the
    // top-level throw is cancelled by the error listener.
    setImmediate(() => {
      console.log('alive');
      process.exit(0);
    });

    throw new Error('entry');
  `);

  expect(stdout).toContain("handled:entry");
  expect(stdout).toContain("alive");
  expect(stdout).toContain("exit:0");
  expect(stdout).not.toContain("PARENT_ERROR");
  expect(exitCode).toBe(0);
});

test("Worker error event preventDefault() also cancels under --unhandled-rejections=throw", async () => {
  // In `--unhandled-rejections=throw` mode the `unhandledRejection` flow
  // in VirtualMachine routes through `uncaughtException`, and without the
  // fix in `uncaughtException` to return `true` when the listener
  // cancelled the event, the `.throw` branch would fall through and
  // dispatch the error a SECOND time with the original reason, re-running
  // (and potentially defeating) a stateful error listener.
  const { stdout, exitCode } = await runWorker(
    `
    let dispatchCount = 0;
    globalThis.addEventListener('error', (e) => {
      dispatchCount++;
      console.log('dispatch:' + dispatchCount);
      e.preventDefault();
    });

    queueMicrotask(() => {
      throw new Error('throw-mode');
    });

    setImmediate(() => {
      console.log('alive');
      console.log('totalDispatches:' + dispatchCount);
      process.exit(0);
    });
  `,
    "{ eval: true, execArgv: ['--unhandled-rejections=throw'] }",
  );

  // The error should be dispatched exactly once even under throw mode.
  expect(stdout).toContain("dispatch:1");
  expect(stdout).not.toContain("dispatch:2");
  expect(stdout).toContain("alive");
  expect(stdout).toContain("totalDispatches:1");
  expect(stdout).toContain("exit:0");
  expect(stdout).not.toContain("PARENT_ERROR");
  expect(exitCode).toBe(0);
});

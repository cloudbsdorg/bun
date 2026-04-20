import { test, expect } from "bun:test";
import os from "node:os";

test("node:os on FreeBSD", () => {
  if (process.platform !== "freebsd") {
    return;
  }

  expect(os.platform()).toBe("freebsd");
  expect(os.type()).toBe("FreeBSD");
  
  const cpus = os.cpus();
  expect(cpus.length).toBeGreaterThan(0);
  for (const cpu of cpus) {
    expect(cpu.model).toBeDefined();
    expect(typeof cpu.model).toBe("string");
    expect(cpu.speed).toBeGreaterThanOrEqual(0);
    expect(cpu.times).toBeDefined();
    expect(typeof cpu.times.user).toBe("number");
    expect(typeof cpu.times.nice).toBe("number");
    expect(typeof cpu.times.sys).toBe("number");
    expect(typeof cpu.times.idle).toBe("number");
    expect(typeof cpu.times.irq).toBe("number");
  }

  expect(os.freemem()).toBeGreaterThan(0);
  expect(os.totalmem()).toBeGreaterThan(0);
  expect(os.totalmem()).toBeGreaterThan(os.freemem());
});

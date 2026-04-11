// https://github.com/oven-sh/bun/issues/29197
//
// The `accessor` class field modifier (TC39 Stage 4 / TypeScript 4.9+) was
// rejected by Bun's parser whenever `experimentalDecorators: true` was set in
// `tsconfig.json`, because the parser gated the keyword on Bun's internal
// `standard_decorators` feature flag. The keyword is valid class syntax
// regardless of which decorator proposal is active, so parsing it should not
// depend on that flag.
//
// JavaScriptCore also does not currently parse `accessor` natively, so Bun
// needs to desugar the field to a `#storage` private field plus a `get`/`set`
// pair — matching what TypeScript emits under `experimentalDecorators: true`
// — for the code to actually run.

import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

async function runWithExperimentalDecorators(source: string) {
  using dir = tempDir("bun-issue-29197", {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        target: "es2022",
      },
    }),
    "index.ts": source,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "index.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, rawStderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  // Debug/ASAN builds print a JSC warning on startup. It's not from the code
  // under test, so strip it before making assertions.
  const stderr = rawStderr
    .split("\n")
    .filter(line => !line.includes("ASAN interferes with JSC signal handlers"))
    .join("\n");

  return { stdout, stderr, exitCode };
}

test("accessor field with a legacy decorator parses and runs", async () => {
  const { stdout, stderr, exitCode } = await runWithExperimentalDecorators(`
    function example(target: any, key: any, desc: any): void {
      console.log("dec:" + key + ":" + typeof desc?.get + ":" + typeof desc?.set);
    }
    class Foo {
      @example accessor x = "value";
    }
    const f = new Foo();
    console.log("get:" + f.x);
    f.x = "other";
    console.log("set:" + f.x);
  `);

  expect(stderr).toBe("");
  expect(stdout).toBe("dec:x:function:function\nget:value\nset:other\n");
  expect(exitCode).toBe(0);
});

test("undecorated accessor field parses and runs under experimentalDecorators", async () => {
  const { stdout, stderr, exitCode } = await runWithExperimentalDecorators(`
    class Foo {
      accessor x = "value";
      accessor y: number = 42;
    }
    const f = new Foo();
    console.log(f.x, f.y);
    f.x = "other";
    f.y = 100;
    console.log(f.x, f.y);
  `);

  expect(stderr).toBe("");
  expect(stdout).toBe("value 42\nother 100\n");
  expect(exitCode).toBe(0);
});

test("static accessor field parses and runs under experimentalDecorators", async () => {
  const { stdout, stderr, exitCode } = await runWithExperimentalDecorators(`
    class Counter {
      static accessor count = 0;
    }
    console.log(Counter.count);
    Counter.count++;
    Counter.count++;
    console.log(Counter.count);
  `);

  expect(stderr).toBe("");
  expect(stdout).toBe("0\n2\n");
  expect(exitCode).toBe(0);
});

test("accessor field in a class expression works under experimentalDecorators", async () => {
  const { stdout, stderr, exitCode } = await runWithExperimentalDecorators(`
    const Foo = class {
      accessor x = 1;
    };
    const f = new Foo();
    console.log(f.x);
    f.x = 2;
    console.log(f.x);
  `);

  expect(stderr).toBe("");
  expect(stdout).toBe("1\n2\n");
  expect(exitCode).toBe(0);
});

test("legacy decorator on accessor receives an accessor-style descriptor", async () => {
  // TypeScript's `__decorate` invokes property decorators with the
  // descriptor fetched via `Object.getOwnPropertyDescriptor`, so a decorator
  // applied to an `accessor` field sees `get`/`set` — not a data descriptor.
  const { stdout, stderr, exitCode } = await runWithExperimentalDecorators(`
    function logDescriptor(target: any, key: any, descriptor: any) {
      const hasGet = typeof descriptor.get === "function";
      const hasSet = typeof descriptor.set === "function";
      const hasValue = "value" in descriptor;
      console.log(key, "get:" + hasGet, "set:" + hasSet, "value:" + hasValue);
    }
    class C {
      @logDescriptor accessor a = 1;
      @logDescriptor accessor b = "two";
    }
    new C();
  `);

  expect(stderr).toBe("");
  expect(stdout).toBe("a get:true set:true value:false\nb get:true set:true value:false\n");
  expect(exitCode).toBe(0);
});

test("accessor field initializer can reference outer scope", async () => {
  const { stdout, stderr, exitCode } = await runWithExperimentalDecorators(`
    const base = 10;
    class Box {
      accessor value = base + 5;
    }
    console.log(new Box().value);
  `);

  expect(stderr).toBe("");
  expect(stdout).toBe("15\n");
  expect(exitCode).toBe(0);
});

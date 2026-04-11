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

async function runTS(
  source: string,
  extraCompilerOptions: Record<string, unknown> = {},
): Promise<{ stdout: string; exitCode: number | null }> {
  using dir = tempDir("bun-issue-29197", {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        target: "es2022",
        ...extraCompilerOptions,
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

  const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
  // stderr is intentionally not asserted: debug/ASAN builds print startup
  // warnings, and stdout + exit code already prove the class ran correctly.
  return { stdout, exitCode };
}

test("accessor field with a legacy decorator parses and runs", async () => {
  const { stdout, exitCode } = await runTS(`
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

  expect(stdout).toBe("dec:x:function:function\nget:value\nset:other\n");
  expect(exitCode).toBe(0);
});

test("undecorated accessor field parses and runs under experimentalDecorators", async () => {
  const { stdout, exitCode } = await runTS(`
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

  expect(stdout).toBe("value 42\nother 100\n");
  expect(exitCode).toBe(0);
});

test("static accessor field parses and runs under experimentalDecorators", async () => {
  const { stdout, exitCode } = await runTS(`
    class Counter {
      static accessor count = 0;
    }
    console.log(Counter.count);
    Counter.count++;
    Counter.count++;
    console.log(Counter.count);
  `);

  expect(stdout).toBe("0\n2\n");
  expect(exitCode).toBe(0);
});

test("static accessor field is accessible through a subclass", async () => {
  // A naive rewrite would emit `return this.#storage` for the synthesized
  // static getter/setter, which triggers JavaScript's private-field brand
  // check and throws TypeError when the receiver is a subclass. We must
  // dereference through the declaring class (`Counter.#storage`) instead.
  const { stdout, exitCode } = await runTS(`
    class Counter {
      static accessor count = 10;
    }
    class Sub extends Counter {}
    console.log(Sub.count);
    Sub.count = 99;
    console.log(Counter.count, Sub.count);
  `);

  expect(stdout).toBe("10\n99 99\n");
  expect(exitCode).toBe(0);
});

// Also covers https://github.com/oven-sh/bun/issues/27335: the same bug
// surfaced as a plain `public accessor name: string = "John"` class field
// failing to parse, because the TypeScript `public` modifier leads into
// the `.p_accessor` branch in `parseProperty` just like a decorator does.
test("TypeScript accessibility modifier before accessor works", async () => {
  const { stdout, exitCode } = await runTS(`
    class Person {
      public accessor name: string = "John";
      protected accessor age: number = 30;
    }
    const p = new Person();
    console.log(p.name, (p as any).age);
    p.name = "Jane";
    (p as any).age = 31;
    console.log(p.name, (p as any).age);
  `);

  expect(stdout).toBe("John 30\nJane 31\n");
  expect(exitCode).toBe(0);
});

test("accessor field in a class expression works under experimentalDecorators", async () => {
  const { stdout, exitCode } = await runTS(`
    const Foo = class {
      accessor x = 1;
    };
    const f = new Foo();
    console.log(f.x);
    f.x = 2;
    console.log(f.x);
  `);

  expect(stdout).toBe("1\n2\n");
  expect(exitCode).toBe(0);
});

test("legacy decorator on accessor receives an accessor-style descriptor", async () => {
  // TypeScript's `__decorate` invokes property decorators with the
  // descriptor fetched via `Object.getOwnPropertyDescriptor`, so a decorator
  // applied to an `accessor` field sees `get`/`set` — not a data descriptor.
  const { stdout, exitCode } = await runTS(`
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

  expect(stdout).toBe("a get:true set:true value:false\nb get:true set:true value:false\n");
  expect(exitCode).toBe(0);
});

test("accessor field initializer can reference outer scope", async () => {
  const { stdout, exitCode } = await runTS(`
    const base = 10;
    class Box {
      accessor value = base + 5;
    }
    console.log(new Box().value);
  `);

  expect(stdout).toBe("15\n");
  expect(exitCode).toBe(0);
});

test("accessor field with a non-identifier string key", async () => {
  // `"foo-bar"` is a valid class element name but NOT a valid private
  // identifier, so the helper must fall back to the counter-based
  // `#_accessor_storage_N` naming rather than emit `#foo-bar_accessor_storage`.
  const { stdout, exitCode } = await runTS(`
    class Weird {
      accessor "foo-bar" = 1;
      accessor "1" = 2;
    }
    const w: any = new Weird();
    console.log(w["foo-bar"], w["1"]);
    w["foo-bar"] = 10;
    w["1"] = 20;
    console.log(w["foo-bar"], w["1"]);
  `);

  expect(stdout).toBe("1 2\n10 20\n");
  expect(exitCode).toBe(0);
});

test("accessor field with a computed key evaluates the key exactly once", async () => {
  // The rewrite expands one `accessor [expr]` into a field plus a getter and
  // a setter. Without hoisting, `expr` would run three times (or at least
  // twice for the get/set pair). This test asserts it runs exactly once.
  const { stdout, exitCode } = await runTS(`
    let calls = 0;
    const k = () => {
      calls++;
      return "dynamic";
    };
    class C {
      accessor [k()] = 42;
    }
    const c: any = new C();
    console.log("calls=" + calls, "value=" + c.dynamic);
    c.dynamic = 99;
    console.log("calls=" + calls, "value=" + c.dynamic);
  `);

  expect(stdout).toBe("calls=1 value=42\ncalls=1 value=99\n");
  expect(exitCode).toBe(0);
});

test("decorator metadata: accessor field records its declared type", () => {
  // Under `experimentalDecorators: true` + `emitDecoratorMetadata: true`,
  // a decorated typed accessor must still get `design:type` pointing to the
  // user's declared type — not `Object` (which is what happens if the
  // synthesized getter's `return_ts_metadata` is left defaulted).
  //
  // We check the emitted JavaScript directly rather than spawning a
  // subprocess with reflect-metadata, because the bug is in what Bun emits
  // and reflect-metadata is not normally installed in a tempDir.
  const transpiler = new Bun.Transpiler({
    loader: "ts",
    target: "bun",
    tsconfig: JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: "es2022",
      },
    }),
  });

  const out = transpiler.transformSync(`
    function collect(_t: any, _k: any) {}
    class Foo {
      @collect accessor str: string = "s";
      @collect accessor num: number = 1;
      @collect accessor bool: boolean = true;
    }
  `);

  // Each decorated accessor should emit a `design:type` metadata entry
  // pointing at the *declared type*, not `Object`. Bun's current legacy
  // metadata emission uses `__legacyMetadataTS("design:type", String)`
  // (or Number / Boolean) for these cases.
  expect(out).toContain('"design:type", String');
  expect(out).toContain('"design:type", Number');
  expect(out).toContain('"design:type", Boolean');
  // Sanity check: the accessor must have been lowered to a backing private
  // field, not left as the raw `accessor` keyword (JSC doesn't parse it).
  expect(out).toContain("_accessor_storage");
  expect(out).not.toMatch(/\baccessor\s+str\b/);
});

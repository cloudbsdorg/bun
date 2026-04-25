### Native FreeBSD Port Plan

**Last Updated**: 2026-04-23  
**Current Status**: Zig compiler built successfully, integrating into Bun build  
**Environment**: FreeBSD 16.0-CURRENT (x86_64)

#### Critical Blockers (Updated 2026-04-23)

1. **Zig Compiler Source Build**: We are now building the Zig compiler from source using the fork at `git@github.com:cloudbsdorg/zig.git` instead of downloading Linux binaries.
   - Fork: `git@github.com:cloudbsdorg/zig.git` (cloudbsdorg/zig on GitHub)
   - Base: oven-sh/zig at pinned commit `0bcf4c3d998133e724d27e9fd783172ffed4c943`
   - Required: FreeBSD native ELF binary with Bun extensions enabled
   - Build approach: Bootstrap from C source → native build on FreeBSD (bootstrap.c compiles to zig2)
   - **Status**: ✅ Successfully built native FreeBSD Zig compiler (zig2) from source
   - **FreeBSD-specific patches applied to bootstrap.c**:
     - Added `__FreeBSD__` detection in `get_host_os()` returning "freebsd"
     - Fixed linker flags: FreeBSD uses `-Wl,-z,stack-size=0x10000000` (not macOS `-Wl,-stack_size`)
   - Note: `zigDownloadUrl` in `scripts/build/zig.ts` downloads the **build-time Zig compiler** (the toolchain that compiles Bun's Zig sources), not a Bun runtime update mechanism. It is not related to end-user package updates.

2. **Zig Syntax Extensions**: Bun's codebase uses non-standard Zig extensions that require the bun-forked Zig compiler:
   - `#raw`, `#destroy` - Custom attribute syntax
   - Files as structs - Top-level field declarations (treating .zig files as struct definitions)
   - `@This()` at file scope
   - These extensions are NOT in standard Zig 0.15.2

#### Completed/Attempted Tasks
- [x] Implement native FreeBSD `getFdPath` using `fcntl(F_KINFO)` instead of Linux-emulated `linprocfs`
- [x] Adapt build system to run codegen using Node.js instead of bootstrap Bun (Linuxulation bugs)
    - [x] Create `bun-shim.mjs` to emulate Bun APIs in Node.js
    - [x] Create `/tmp/bun-node-wrapper` to intercept `bun` commands during build
    - [x] Patch all codegen scripts to use absolute paths and handle Node.js execution environments
- [x] Port `bun-usockets` to FreeBSD
    - [x] Remove/guard Mach Port and Apple-specific headers
    - [x] Abstract `kevent64` to standard `kevent`
    - [x] Add missing networking headers (`netinet/in.h`, `netinet/ip.h`)
    - [x] Implement fallback for `IP_PKTINFO` using `IP_RECVDSTADDR`
- [x] Fix WebKit header conflicts
    - [x] Suppress `HAVE_FEATURES_H` to avoid missing `features.h`
- [x] Attempt to resolve Zig syntax extensions (e.g., `#raw`, top-level fields)
    - [x] Download Bun-forked Zig binaries from `oven-sh/zig`
    - [x] Prototype wrapper script for top-level fields (see scripts/wrap_top_level_fields.ts)
    - [!] (Blocker) Top-level fields in files (treating files as struct definitions) is a deep compiler extension not currently active in downloaded binaries. Standard Zig expects declarations only at the top level.
- [x] Confirmed Zig compiler targets FreeBSD (`zig targets | grep freebsd` shows x86_64-freebsd-none)

#### Completed Tasks
- [x] **CRITICAL**: Build native FreeBSD Zig compiler from source
  - [x] Fork oven-sh/zig → `git@github.com:cloudbsdorg/zig.git`
  - [x] Clone fork locally and checkout pinned commit (`0bcf4c3d998133e724d27e9fd783172ffed4c943`)
  - [x] Bootstrap: Build from C source (bootstrap.c) → native FreeBSD zig2
  - [x] Build FreeBSD native zig compiler with Bun extensions enabled
  - [x] Verify with `file zig2` → shows "ELF 64-bit LSB executable, x86-64, version 1 (FreeBSD)"
  - [x] Commit and push FreeBSD bootstrap fixes to `freebsd-bootstrap` branch
  - [x] Copy native binary to Bun vendor: `vendor/zig/zig.native`
- [x] Integrate top-level fields wrapper into build pipeline
  - [x] Wrapper script exists (scripts/wrap_top_level_fields.ts)
  - [ ] Run wrapper BEFORE Zig compilation in build.zig
  - [x] Alternative: Build Zig with bun extensions enabled from source (zig2 has Bun extensions)
- [ ] Complete Zig compilation stage
  - [ ] Fix remaining compilation errors in current build_log.txt
  - [ ] Verify all .zig files compile without syntax errors

#### Blocked Tasks
- [x] Top-level fields syntax blocker resolved via wrapper script (pending integration)
- [ ] Zig compilation → blocked on native compiler
- [ ] Final linking → blocked on Zig compilation
- [ ] Testing → blocked on executable

#### TODO Tasks (Updated Priority)
1. **[CRITICAL] Build Zig compiler from source on FreeBSD**
   - Clone fork: `git clone git@github.com:cloudbsdorg/zig.git`
   - Checkout pinned commit: `git checkout 0bcf4c3d998133e724d27e9fd783172ffed4c943`
   - Bootstrap build (stage1): Use existing Linux zig binary to compile FreeBSD-native stage1
   - Full build: `zig build -Dtarget=x86_64-freebsd-none` (or native build on FreeBSD)
   - Install to `vendor/zig/zig` and verify with `file` command
   - Document repeatable build process in BUILDING.md

2. **[HIGH] Integrate built Zig into Bun build pipeline**
   - Option A: Modify `scripts/build/zig.ts` to use built binary instead of downloading
   - Option B: Add `vendor/zig/` as git submodule pointing to fork
   - Test with single .zig file first

3. **[HIGH] Complete Zig compilation stage**
   - Fix remaining FreeBSD-specific issues
   - Build bun-zig.o successfully

4. **[MEDIUM] Link final FreeBSD native executable**
   - Link bun-zig.o with C++ objects
   - Verify: `file build/debug/bun-debug` → should show "FreeBSD" not "GNU/Linux"

5. **[MEDIUM] Create FreeBSD Port**
   - Create `lang/bun` port directory structure
   - Write `Makefile` with proper dependencies (Zig, WebKit, etc.)
   - Generate `distinfo`, `pkg-descr`, `pkg-plist`
   - Test with `poudriere` on FreeBSD 14.x, 15.x, 16-CURRENT
   - Submit port for review to FreeBSD Ports tree

6. **[MEDIUM] Run regression and unit tests on FreeBSD**
   - `bun bd test <test-file>`
   - Verify native execution

7. **[LOW] Push finalized changes to freebsd branch**
   - Commit all changes
   - Document build process for FreeBSD

#### Distribution Notes
- **FreeBSD updates will be managed from its own pkg repo** (`pkg install bun`). This is separate from the build-time `zigDownloadUrl` mechanism, which only fetches the Zig compiler toolchain needed to compile Bun from source.

#### FreeBSD Ports Collection Integration
- **Goal**: Submit Bun port to FreeBSD Ports tree for official package management
- **Port category**: `lang/bun` or `www/bun` (TBD)
- **Dependencies to declare**:
  - `lang/zig` (FreeBSD native Zig compiler, or our forked version)
  - `www/webkit2-gtk3` (or equivalent WebKit port)
  - `devel/libuv` (if using system libuv)
  - `security/openssl` (BoringSSL vs system OpenSSL TBD)
- **Build steps for port**:
  1. Extract Bun source
  2. Build or depend on native FreeBSD Zig compiler with Bun extensions
  3. Run codegen scripts (Node.js or native Bun if available)
  4. Compile Zig sources to `bun-zig.o`
  5. Compile C++ sources with WebKit bindings
  6. Link final executable
- **Files to create**:
  - `Makefile` - Port build instructions
  - `distinfo` - Source tarball checksums
  - `pkg-descr` - Short description
  - `pkg-plist` - Installed files list
- **Upstream integration**: Maintain fork at `cloudbsdorg/zig` with FreeBSD-specific patches; submit PRs upstream to `oven-sh/zig` and `oven-sh/bun` where applicable
- **Testing**: Verify `poudriere` build succeeds on FreeBSD 14.x, 15.x, 16-CURRENT

#### Validation & Regression Testing
- **Lint**: The repository has `bun lint` (`bunx oxlint --config=oxlint.json --format=github src/js`) in `.github/workflows/lint.yml`
- **Full test suite**: `node scripts/runner.node.mjs --exec-path ./build/debug/bun-debug` runs the comprehensive Bun self-test suite
  - This is the **full regression test** the user is asking about
  - It runs each `bun test` in a separate process to catch crashes
  - It cannot use Bun APIs (run via Node.js)
  - It does not import dependencies for faster startup
- **For FreeBSD port**: Add `do-test` target to Makefile that runs runner.node.mjs with native binary
- **CI integration**: The existing `.github/workflows/lint.yml` and test workflows should be adapted for FreeBSD runners or cross-compilation testing

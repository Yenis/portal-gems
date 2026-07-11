# Phase 0 gate 2 - Android chain build notes

Verified 2026-07-05 on the Pixel 6 emulator (Android 14, x86_64): the example app
sent a file to the reference CLI and received one from it (fixed/paired-style code),
SHA-256 identical both ways, direct (non-relay) transit in both directions.

Stack: React Native **0.85** + create-react-native-library **turbo-module/cpp/vanilla**
template + uniffi-bindgen-react-native **0.31.0-3** (uniffi 0.31.2) + cargo-ndk,
NDK 27.1. ubrn is documented against RN 0.75/0.76, and RN 0.77+ moved C++
turbo-modules to an app-driven CMake build - every workaround below stems from that
version drift. Re-check each when bumping ubrn or RN.

## The architecture that works (pure C++ turbo-module)

RN 0.85's CRNL cpp template declares the library in `react-native.config.js` as a
**pure C++ dependency** (`cxxModuleCMakeListsPath`, `cxxModuleHeaderName:
'WormholeRnImpl'`, autolinking reports `isPureCxxDependency: true`). The app's own
CMake builds `android/CMakeLists.txt` directly; there is **no Gradle project, no
Kotlin, no AndroidManifest in the library**. ubrn 0.31 instead generates its older
Kotlin-module flavor (Kotlin module + JNI cpp-adapter + build.gradle). We use the
pure-C++ path:

- `cpp/WormholeRnImpl.{h,cpp}` implement the codegen'd spec and call
  `wormholern::installRustCrate(rt, jsInvoker_)` from ubrn's generated
  `cpp/wormhole-rn.cpp`.
- Deleted from the library: `android/build.gradle`, `android/src/main/java/**`,
  `android/src/main/AndroidManifest.xml`, `android/cpp-adapter.cpp`.
  **The leftover AndroidManifest.xml silently breaks autolinking** (the CLI then
  mis-detects the library as a Gradle project → "Project with path ':wormhole-rn'
  could not be found"). If autolinking output for the dependency shows only
  `{"buildTypes": []}`, look for stray Gradle/manifest/Kotlin files.

## android/CMakeLists.txt (kept, heavily patched)

Modeled on the pristine CRNL template (STATIC lib linked into `libappmodules.so`,
plain `jsi`/`reactnative`/`react_codegen_WormholeRnSpec` targets from the app
scope), plus:

1. `CMAKE_CURRENT_SOURCE_DIR` instead of `CMAKE_SOURCE_DIR` for the jniLibs path —
   under the app-driven build, `CMAKE_SOURCE_DIR` points into react-native's
   `default-app-setup`.
2. `CXX_STANDARD 20` - RN ≥ 0.79 headers use C++20 requires-clauses; ubrn's
   template says 17.
3. ubrn package root resolution: `require.resolve('uniffi-bindgen-react-native/package.json')`
   throws `ERR_PACKAGE_PATH_NOT_EXPORTED` (their exports map only exposes `"."`);
   we resolve the entry point and walk 4 levels up, with an existence check.
4. Sources include `../cpp/WormholeRnImpl.cpp` and `../cpp/generated/wormhole_core.cpp`;
   the imported static lib `wormhole_core` points at
   `src/main/jniLibs/${ANDROID_ABI}/libwormhole_core.a` (produced by `yarn ubrn:android`).

Upstream issue candidates (ubrn): items 1–3, plus the Kotlin-flavor/pure-cxx
template mismatch.

## Codegen

`codegenConfig.includesGeneratedCode: true` means **we** must produce
`android/generated/`:

```sh
node node_modules/react-native/scripts/generate-codegen-artifacts.js \
  --path . --outputPath android/generated --targetPlatform android
```

Note: codegen emits `NativeWormholeRnSpec` into `com.facebook.fbreact.specs`,
ignoring `codegenConfig.android.javaPackageName` - irrelevant on the pure-C++ path
(the Java spec is unused), but it bit us while the Kotlin flavor was still in place.

## Other gotchas

- **`yarn ubrn:clean` script**: yarn 4's shell aborts on the unmatched
  `android/*.cpp` glob, so the whole clean silently did nothing. Leftover starter
  files (`WormholeRnImpl` with `multiply`, `src/multiply*.tsx`) then shadow/clash
  with ubrn output.
- **ABIs**: we build Rust for `arm64-v8a` + `x86_64` (ubrn.config.yaml); the example
  app's `gradle.properties` restricts `reactNativeArchitectures` to match. Add
  `armeabi-v7a` (and drop or keep x86) before release.
- Rerunning `yarn ubrn:android --and-generate` regenerates `cpp/wormhole-rn.*`,
  `cpp/generated/**`, `src/index.tsx`, `src/Native*` **and may re-emit the Kotlin
  flavor files** (`android/src/main/java`, `android/cpp-adapter.cpp`,
  `android/build.gradle`, manifest) and overwrite `android/CMakeLists.txt`. After
  regeneration: re-delete the Kotlin-flavor files and re-apply the CMakeLists
  patches (or diff against this file's list). Consider scripting this.
- Emulator networking reaches the public mailbox server fine; transit even
  negotiates **direct** connections through the emulator NAT (`10.0.2.2` host
  route outbound, host→emulator via the CLI connecting to hints).

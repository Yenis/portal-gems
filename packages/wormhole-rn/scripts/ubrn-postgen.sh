#!/usr/bin/env bash
# Post-generation cleanup after `ubrn build android --and-generate`.
#
# This library is a pure C++ turbo-module (RN >= 0.77 template), but ubrn 0.31
# re-emits its older Kotlin-module flavor and overwrites android/CMakeLists.txt
# with a template that doesn't work under the app-driven CMake build. Remove
# the Kotlin flavor and restore our patched CMakeLists from git.
# Background: docs/phase0-android-notes.md.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf android/src/main/java android/src/main/AndroidManifest.xml \
  android/build.gradle android/cpp-adapter.cpp

git checkout -- android/CMakeLists.txt

echo "ubrn-postgen: Kotlin flavor removed, CMakeLists restored."

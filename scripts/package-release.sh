#!/usr/bin/env bash
#
# package-release.sh - collect built PortalGems binaries into one folder with
# consistent names and SHA256 checksums, ready to upload to a GitHub release.
#
# Usage:
#   scripts/package-release.sh [version]
#
# version defaults to the "version" field of packages/app-desktop/package.json.
# Build the artifacts first (see README "Building from source"); this script
# only collects and checksums whatever it finds, warning about anything missing.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="${1:-$(node -p "require('./packages/app-desktop/package.json').version")}"
out="release-artifacts/v${version}"

echo "PortalGems release packager - v${version}"
echo "Output: ${out}"
rm -rf "$out"
mkdir -p "$out"

# Find the first existing path from a list; echo it, or nothing if none match.
first_existing() {
  for p in "$@"; do
    if [ -e "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

# copy <source-glob-or-path> <dest-filename>
collect() {
  local label="$1" dest="$2"; shift 2
  local src
  if src="$(first_existing "$@")"; then
    cp "$src" "$out/$dest"
    echo "  [ok]   $label  <-  $src"
  else
    echo "  [skip] $label  (not built yet)"
  fi
}

echo "Collecting artifacts..."

# Android APK (single universal APK; no ABI splits configured)
collect "Android APK" "PortalGems-${version}-android.apk" \
  "packages/app-mobile/android/app/build/outputs/apk/release/app-release.apk"

# Linux AppImage (electron-builder names vary; take the newest .AppImage)
collect "Linux AppImage" "PortalGems-${version}-linux-x86_64.AppImage" \
  packages/app-desktop/release/*.AppImage

# Linux Debian package (.deb)
collect "Linux .deb" "PortalGems-${version}-linux-amd64.deb" \
  packages/app-desktop/release/*.deb

# Linux RPM package (.rpm)
collect "Linux .rpm" "PortalGems-${version}-linux-x86_64.rpm" \
  packages/app-desktop/release/*.rpm

# Windows portable exe (name may contain a space, e.g. "PortalGems 1.0.0.exe")
collect "Windows .exe" "PortalGems-${version}-windows-x64.exe" \
  packages/app-desktop/release/*.exe

echo "Generating SHA256 checksums..."
shopt -s nullglob
cd "$out"
for f in *; do
  case "$f" in
    *.sha256) continue ;;
  esac
  sha256sum "$f" > "$f.sha256"
  echo "  $f.sha256"
done

echo
echo "Done. Files in $out:"
ls -1
echo
echo "Verify later with:  (cd \"$out\" && sha256sum -c *.sha256)"

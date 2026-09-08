#!/bin/sh
# Package and self-sign the Symbian client.
#
# Symbian OS 9.x refuses an unsigned SIS, and Nokia's Symbian Signed and
# Open Signed Online are both long gone. Neither matters here: we sign with
# our own certificate, which the phone accepts as long as the package asks
# only for user-grantable capabilities (see whmini.mmp) and the device has
# software installation set to "All" with the online certificate check off.
#
# The certificate is generated once and then reused, so a reinstall upgrades
# in place instead of colliding. Keep portalgems-dev.key out of the repo -
# it is ignored, like the Android release keystore.
#
# Requires EPOCROOT and the gnupoc wrappers on PATH; see
# packages/app-symbian/toolchain/README.md.
set -e

HERE=$(dirname "$0")
SIS_DIR="$HERE/../packages/app-symbian/sis"
BINARY="${EPOCROOT}epoc32/release/gcce/urel/whmini.exe"
APP_RSC="${EPOCROOT}epoc32/data/z/resource/apps/whmini.rsc"
ICON="${EPOCROOT}epoc32/data/z/resource/apps/whmini.mbm"
REG_RSC="${EPOCROOT}epoc32/data/z/private/10003a3f/import/apps/whmini_reg.rsc"
LOC_RSC="${EPOCROOT}epoc32/data/z/resource/apps/whmini_loc.rsc"
KEY="$SIS_DIR/portalgems-dev.key"
CERT="$SIS_DIR/portalgems-dev.cer"
PASS="${SYMBIAN_KEY_PASS:-portalgems}"

if [ ! -f "$KEY" ]; then
    echo "generating a self-signed development certificate"
    # The SDK's own makekeys is not used: it shells out to
    # `openssl dsaparam -genkey 2048 -out ...`, an argument order OpenSSL 3
    # rejects outright. Generating the pair directly is simpler than
    # patching it, and RSA is the better choice anyway - it is what
    # signsis defaults to for a non-DSA key.
    openssl req -x509 -newkey rsa:2048 -nodes -sha1 -days 7300 \
        -keyout "$KEY" -out "$CERT" \
        -subj "/CN=PortalGems Dev/O=PortalGems/C=XX" 2>/dev/null
fi

if [ ! -f "$BINARY" ]; then
    echo "no built binary at $BINARY - run 'abld build gcce urel' first" >&2
    exit 1
fi
for f in "$BINARY" "$APP_RSC" "$ICON" "$REG_RSC" "$LOC_RSC"; do
    if [ ! -f "$f" ]; then
        echo "missing build output: $f" >&2
        exit 1
    fi
    cp "$f" "$SIS_DIR/"
done

# Refuse to package a binary older than the sources it came from. abld
# prints its errors and carries on to the next target, so a failed build
# leaves the previous binary in place - and signing that produces a package
# that installs cleanly and is silently the wrong build.
NEWER=$(find "$HERE/../native/wormhole-mini/src" "$HERE/../native/wormhole-mini/port" \
             "$HERE/../packages/app-symbian/src" "$HERE/../packages/app-symbian/inc" \
             "$HERE/../packages/app-symbian/data" \
             -type f \( -name '*.c' -o -name '*.cpp' -o -name '*.h' \
                      -o -name '*.hrh' -o -name '*.rss' \) \
             -newer "$BINARY" 2>/dev/null | head -3)
if [ -n "$NEWER" ]; then
    echo "refusing to sign: these are newer than the built binary," >&2
    echo "which means the last build did not succeed:" >&2
    echo "$NEWER" | sed 's/^/  /' >&2
    exit 1
fi

echo "building the package"
( cd "$SIS_DIR" && makesis whmini.pkg whmini.sis )

echo "signing"
( cd "$SIS_DIR" && signsis whmini.sis whmini-signed.sis \
    "$(basename "$CERT")" "$(basename "$KEY")" "$PASS" )

echo
echo "signed package: $SIS_DIR/whmini-signed.sis"
echo "copy it to the phone and open it from the file manager."

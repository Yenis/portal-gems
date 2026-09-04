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
# UNVERIFIED: written against the documented behaviour of these tools, not
# yet run - that needs the SDK from phase S4.
set -e

HERE=$(dirname "$0")
SIS_DIR="$HERE/../packages/app-symbian/sis"
KEY="$SIS_DIR/portalgems-dev.key"
CERT="$SIS_DIR/portalgems-dev.cer"
PASS="${SYMBIAN_KEY_PASS:-portalgems}"

if [ ! -f "$KEY" ]; then
    echo "generating a self-signed development certificate"
    makekeys -cert -password "$PASS" -len 2048 \
        -dname "CN=PortalGems Dev OR=PortalGems CO=XX" \
        "$KEY" "$CERT"
fi

echo "building the package"
makesis "$SIS_DIR/whmini.pkg" "$SIS_DIR/whmini.sis"

echo "signing"
signsis "$SIS_DIR/whmini.sis" "$SIS_DIR/whmini-signed.sis" "$CERT" "$KEY" "$PASS"

echo
echo "signed package: $SIS_DIR/whmini-signed.sis"
echo "copy it to the phone and open it from the file manager."

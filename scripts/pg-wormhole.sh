#!/bin/sh
# The reference magic-wormhole CLI, pointed at the PortalGems server.
#
# Why this exists: `wormhole receive <code>` against a code issued by a
# PortalGems client fails - usually with `ServerError: crowded`, sometimes
# with an unknown nameplate. Nothing is broken. The reference client
# defaults to the PUBLIC relay:
#
#     ws://relay.magic-wormhole.io:4000/v1
#
# so it looks for the code on a different server entirely, where that
# nameplate belongs to a stranger. The flags are simply required, and
# nobody wants to type them twice a day.
#
# Usage is exactly the CLI's:
#
#     scripts/pg-wormhole.sh send ./file
#     scripts/pg-wormhole.sh send ./folder
#     scripts/pg-wormhole.sh receive 7-crossover-clockwork
#
# Override the server with PG_RENDEZVOUS_URL and PG_TRANSIT_URL, the same
# names native/wormhole-core's examples use.
set -e

# Defaults match packages/core/src/servers.ts. Keep them in step.
RENDEZVOUS="${PG_RENDEZVOUS_URL:-wss://be-my-guest.io/v1}"
TRANSIT="${PG_TRANSIT_URL:-tcp://be-my-guest.io:4001}"

if [ $# -eq 0 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    cat <<USAGE
pg-wormhole - the magic-wormhole CLI, aimed at the PortalGems server

  pg-wormhole send <path>        a file or a folder
  pg-wormhole receive <code>
  pg-wormhole <any wormhole subcommand and flags>

Server (override with the environment):
  PG_RENDEZVOUS_URL  $RENDEZVOUS
  PG_TRANSIT_URL     $TRANSIT

A phone that cannot do TLS wants the cleartext mailbox instead:
  PG_RENDEZVOUS_URL=ws://be-my-guest.io:4000/v1 pg-wormhole receive <code>
USAGE
    exit 0
fi

if ! command -v wormhole >/dev/null 2>&1; then
    echo "pg-wormhole: the 'wormhole' command is not installed." >&2
    echo "  pipx install magic-wormhole   (or: pip install --user magic-wormhole)" >&2
    exit 127
fi

# The apps carry the transit relay as a URL, `tcp://host:port`, while the
# CLI wants `tcp:host:port`. Translating here means the same value can be
# copied from the app's settings without editing.
case "$TRANSIT" in
    tcp://*) HELPER="tcp:${TRANSIT#tcp://}" ;;
    *)       HELPER="$TRANSIT" ;;
esac

exec wormhole --relay-url "$RENDEZVOUS" --transit-helper "$HELPER" "$@"

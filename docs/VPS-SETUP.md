# Running your own PortalGems server

PortalGems meets two devices at a **rendezvous** (mailbox) server to exchange
the short code, then moves the file directly or through a **transit relay** when
a direct connection is not possible. By default the app uses the public
community server; you can also point it at your own.

Running your own means you never depend on anyone else's uptime. Because every
file is end-to-end encrypted, your server only ever sees ciphertext - it cannot
read anything that passes through it. You need a small always-on machine; a
cheap VPS is plenty.

This guide targets **Ubuntu/Debian with a domain name** (the recommended setup:
a domain lets you serve `wss://` over TLS, which mobile requires - Android
blocks cleartext `ws://` by default). Substitute `relay.example.com` with your
subdomain and `you`/`wormhole` with your usernames as needed.

Both servers live on one hostname: the mailbox behind TLS at
`wss://relay.example.com/v1`, and the transit relay at
`tcp://relay.example.com:4001`.

---

## 1. DNS

Create a single **A record** pointing your subdomain at the VPS's public IP:

```
relay.example.com.   A   <your VPS public IP>
```

## 2. Install the servers

Both are maintained by the magic-wormhole project and run on Python 3:

```bash
sudo apt update && sudo apt install -y python3-venv
sudo useradd --system --create-home --shell /usr/sbin/nologin wormhole
sudo -u wormhole python3 -m venv /home/wormhole/venv
sudo -u wormhole /home/wormhole/venv/bin/pip install --upgrade pip
sudo -u wormhole /home/wormhole/venv/bin/pip install \
    magic-wormhole-mailbox-server magic-wormhole-transit-relay
```

## 3. Run them as systemd services

**Mailbox** - bound to localhost only; Caddy fronts it with TLS:

```bash
sudo tee /etc/systemd/system/wormhole-mailbox.service >/dev/null <<'EOF'
[Unit]
Description=Magic Wormhole mailbox (rendezvous) server
After=network.target

[Service]
User=wormhole
# REQUIRED: the mailbox writes its channel DB (relay.sqlite) in its working
# directory. systemd's default cwd is `/`, which the service user can't write
# to, so without this it crash-loops on startup.
WorkingDirectory=/home/wormhole
ExecStart=/home/wormhole/venv/bin/twist wormhole-mailbox --port tcp:4000:interface=127.0.0.1
Restart=always

[Install]
WantedBy=multi-user.target
EOF
```

**Transit relay** - public on 4001 (the payload is already end-to-end
encrypted, so it needs no TLS):

```bash
sudo tee /etc/systemd/system/wormhole-transit.service >/dev/null <<'EOF'
[Unit]
Description=Magic Wormhole transit relay
After=network.target

[Service]
User=wormhole
ExecStart=/home/wormhole/venv/bin/twist transitrelay --port tcp:4001
Restart=always

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wormhole-mailbox wormhole-transit
sudo systemctl status wormhole-mailbox wormhole-transit --no-pager
```

## 4. Caddy for automatic HTTPS (the `wss://` endpoint)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
relay.example.com {
    reverse_proxy 127.0.0.1:4000
}
EOF
sudo systemctl restart caddy
```

Caddy fetches a Let's Encrypt certificate automatically (ports 80 and 443 must
be reachable). WebSocket upgrades pass through with no extra configuration.

**Already running another web server on port 80?** Caddy can serve the mailbox
on 443 without ever binding 80 - set a global `http_port` to an unused port so
it leaves 80 alone, and the certificate still issues via the TLS-ALPN challenge
on 443:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
{
    http_port 8080
}

relay.example.com {
    reverse_proxy 127.0.0.1:4000
}
EOF
sudo systemctl restart caddy
```

Your existing site on port 80 keeps working untouched.

## 5. Firewall

```bash
sudo ufw allow 22/tcp      # SSH (don't lock yourself out)
sudo ufw allow 80,443/tcp  # Caddy / TLS
sudo ufw allow 4001/tcp    # transit relay
sudo ufw enable
```

> **Also open the ports in your VPS provider's firewall.** Most hosts (IONOS,
> Hetzner, AWS, DigitalOcean, ...) have their own cloud firewall / security
> group in front of the machine. `ufw` alone is not enough: open **443** and
> **4001** (and 80, 22) there too. The classic symptom is that 443 works (the
> cert issued, so the challenge reached Caddy) but the non-standard **4001** is
> silently dropped upstream even though `ufw status` shows it allowed.

## 6. Verify - before touching the app

The PortalGems engine speaks the same protocol and uses the same app id as the
reference `wormhole` CLI, so the CLI is the quickest way to prove your server
works. On your laptop, point both sides at your server:

```bash
# terminal A (sender)
wormhole --relay-url wss://relay.example.com/v1 \
         --transit-helper tcp:relay.example.com:4001 \
         send somefile.txt

# terminal B (receiver) - use the code the sender prints
wormhole --relay-url wss://relay.example.com/v1 \
         --transit-helper tcp:relay.example.com:4001 \
         receive <code>
```

If that round-trips, the server is fully operational. Health checks:

```bash
curl -I https://relay.example.com          # Caddy up + valid cert
sudo journalctl -u wormhole-mailbox -f     # live mailbox log
```

## 7. Point the app at it

In **Settings -> Connection server**, choose **Custom** and enter:

- **Rendezvous URL:** `wss://relay.example.com/v1`
- **Transit relay URL:** `tcp://relay.example.com:4001`

Leave a field blank to keep the public default for just that server. Every
device you want to connect must use the **same** rendezvous server. Because
PortalGems keeps the standard magic-wormhole app id, the reference `wormhole`
CLI pointed at your server interoperates too.

### Making it the built-in "PortalGems" option

The picker's **PortalGems** entry is hidden until its URLs are real. To turn it
on, set both constants in
[`packages/core/src/servers.ts`](../packages/core/src/servers.ts) to your
deployed addresses:

```ts
export const PORTALGEMS_RENDEZVOUS_URL = 'wss://relay.example.com/v1';
export const PORTALGEMS_TRANSIT_URL = 'tcp://relay.example.com:4001';
```

Once they no longer contain `example`, the option appears automatically and can
be made the default in `DEFAULT_SERVER_SETTINGS`.

---

**Tip:** keep the subdomain generic (`relay.`) rather than tying it to a
specific host, so you can move the VPS later without breaking installed apps.

For the no-domain case (IP only): use `ws://<IP>:4000/v1` and
`tcp://<IP>:4001`. This works on desktop, but Android blocks cleartext `ws://`
by default - prefer a domain (a free one, e.g. DuckDNS, is enough) so the
mobile app can use `wss://`.

## Troubleshooting

Symptoms we actually hit, and their fixes:

- **`wormhole-mailbox` shows `Active: failed (Result: exit-code)` / crash-loops
  ("Start request repeated too quickly").** It can't create `relay.sqlite` in
  its working directory. Add `WorkingDirectory=/home/wormhole` to the unit (see
  step 3), then `sudo systemctl reset-failed wormhole-mailbox` and restart. Read
  the real error with `sudo journalctl -u wormhole-mailbox -n 30 --no-pager`.
- **The cert never issues.** Ports 80/443 aren't reachable, or DNS doesn't point
  at this box. Confirm `getent hosts <domain>` matches the VPS IP, that 80+443
  are open in *both* `ufw` and the provider firewall, and watch
  `sudo journalctl -u caddy -f` for the ACME result.
- **443 works but 4001 doesn't** (transfers connect but stall, or only work on
  the same Wi-Fi). The transit relay port is blocked upstream - open **4001** in
  your VPS provider's cloud firewall, not just `ufw`.
- **Desktop connects but a phone won't.** The phone is refusing cleartext
  `ws://`. Serve the mailbox over `wss://` (steps 3-4); that is the whole reason
  TLS is recommended.
- **Confirm the two services are actually listening where you expect:**
  `sudo ss -ltnp | grep -E ':4000|:4001'` - the mailbox on `127.0.0.1:4000`
  (behind Caddy) and the relay on `0.0.0.0:4001`.

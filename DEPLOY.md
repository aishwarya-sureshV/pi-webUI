# Deploying pi-web to the cloud (cheapest options)

The conversation header has a **split Deploy button**:

- **Primary click = Deploy (local)** — `npm run build` on your working tree
  *as-is* (uncommitted changes included) → restart the API server → reload
  the page. Nothing is pulled or pushed. Tooltip shows just the last local
  deploy time.
- **Caret ▾ opens the deploy menu** — two options:
  - **💻 Local — build + restart**: shows the last local deploy time.
  - **☁ Cloud — git pull + build + restart**: deploys the latest commit
    pushed to your remote. Shows the last deployed commit id and the current
    HEAD commit id — nothing else.

Both share one state file (`.pi-web-deploy.json`), which keeps `lastLocal`
and `lastCloud` history separately. The amber dot on the primary button means
the working tree differs from the most recent deploy of either kind (it
hashes HEAD + status + diff into a tree signature, so uncommitted edits count
too).

---

## Option 1 — Oracle Cloud Always Free ($0/mo, recommended)

Genuinely free forever (no trial expiry). As of June 2026 the ARM Ampere A1
allowance is 2 OCPU / 12 GB RAM — still enough for pi-web, `npm run build`,
and ollama with small models (7–8B q4). Sign-up needs a card for verification
but is not charged on Always Free resources.

Setup:

1. Sign up at cloud.oracle.com (pick a home region near you; if ARM shows
   "out of capacity", wait/retry or try another region).
2. Create an instance: VM.Standard.A1.Flex, 2 OCPU, 12 GB, Ubuntu 24.04,
   upload your SSH key. Save the public IP.
3. On the box:

   ```bash
   sudo apt update && sudo apt install -y git curl
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo adduser --disabled-password piweb
   sudo git clone <your-repo-url> /opt/pi-web
   sudo chown -R piweb:piweb /opt/pi-web
   cd /opt/pi-web && sudo -u piweb npm install && sudo -u piweb npm run build
   ```

4. Ollama (optional — see "Where should ollama run?" below):

   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   sudo -u piweb ollama pull qwen2.5-coder:7b   # or your model
   ```

5. systemd service — create `/etc/systemd/system/pi-web.service`:

   ```ini
   [Unit]
   Description=pi-web
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=piweb
   WorkingDirectory=/opt/pi-web
   Environment=PI_WEB_PORT=4319
   Environment=PI_WEB_HOST=0.0.0.0
   Environment=PI_WEB_TOKEN=change-me-to-a-long-random-string
   Environment=PI_WEB_DEPLOY_MODE=cloud
   ExecStart=/usr/bin/node server/index.js
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=multi-user.target
   ```

   `Restart=always` is what makes the Deploy button work here: after a deploy
   the old process SIGTERMs itself and systemd brings the new build up.

6. Start it: `sudo systemctl enable --now pi-web`, then visit
   `http://<instance-ip>:4319` (open port 4319 in the instance's security list
   - the default VCN security list). Log in with your PI_WEB_TOKEN.

Cost: **$0**. Downside: sign-up can be picky, ARM capacity is sometimes scarce.

## Option 2 — Fly.io (~$2–7/mo, easiest CLI deploy)

Pay-per-second micro-VMs; a shared-cpu-1x 256MB machine is ~$2/mo but that is
too small for `vite build` + the pi agent — use 1GB (~$5–7/mo). Ollama will not
fit comfortably; point `OLLAMA_HOST` at your Mac via Tailscale instead (below).
Downside: the Deploy button's git-pull flow assumes a persistent disk, which
needs an extra volume mount, and build steps happen in the container — workable
but more moving parts than a plain VPS.

## Option 3 — Hetzner CX23 (~€5.5/mo, most reliable cheap VPS)

EU-based, 2 vCPU / 4 GB RAM. Great uptime; 4 GB is fine for pi-web + builds,
tight for ollama (use their 8 GB CX34 if you want models on the box). Setup is
identical to Oracle steps 3–6 above.

## Option 4 — LowEndTalk budget VPS (€2–4/mo)

lowendtalk.com has frequent annual deals (VPSnet, RackNerd, etc.). Cheapest paid
option; quality/hardware varies. Same setup as Oracle steps 3–6.

---

## Where should ollama run?

pi-web reaches ollama at `OLLAMA_HOST` (default `http://127.0.0.1:11434`).

- **On the VPS** (only Oracle's 12 GB RAM makes this comfortable):
  install ollama locally on the box; nothing else to configure.
- **On your Mac, reached over Tailscale** (free, works with any VPS incl.
  Fly.io's tiny machines): install Tailscale on the Mac + VPS
  (`curl -fsSL https://tailscale.com/install.sh | sh`), start ollama on the
  Mac with `OLLAMA_ORIGINS="*" ollama serve` (binds to the tailscale
  interface), then set `Environment=OLLAMA_HOST=http://<mac-tailscale-ip>:11434`
  in the systemd unit. Your Mac's GPU does inference; the cloud box is just
  the always-on UI. Caveat: only works while your Mac is awake.

## HTTPS (strongly recommended)

`PI_WEB_HOST=0.0.0.0` with token auth is OK for testing but plain HTTP means
the token crosses the internet in the clear. Easiest free fix — Cloudflare
Tunnel (also hides the server's IP, no open inbound ports):

```bash
# on the VPS
sudo apt install -y cloudflared
cloudflared tunnel login
cloudflared tunnel create pi-web
cloudflared tunnel route dns pi-web piweb.<yourdomain>.com
cloudflared tunnel run --url http://127.0.0.1:4319 pi-web
# then run it as a service: sudo cloudflared service install
```

(Requires a domain you control; free domains work fine on Cloudflare.)

---

## Troubleshooting the Deploy button

- **"git pull failed"** — the cloud checkout must be clean and on the branch
  you push to; the pull is `--ff-only`, so push before deploying.
- **Button stuck on "Deploying…"** — status auto-marks stale after 15 min; a
  stuck build shows in the tooltip's log tail.
- **Nothing happens** — check `journalctl -u pi-web -f` (systemd) or the
  terminal running `npm run dev` (local): the deployer logs land in the state
  file, but supervisor/systemd restarts are visible there.

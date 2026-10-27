#!/bin/bash
# One-time setup inside the web container (Ubuntu 22.04): updates, Node 24 LTS, Caddy,
# and a locked-down service user. Safe to re-run.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
export PATH=/usr/local/bin:$PATH   # `pct exec` starts with a minimal PATH

apt-get update -qq
apt-get -y -qq -o Dpkg::Options::=--force-confold upgrade >/dev/null
apt-get -y -qq install curl ca-certificates xz-utils gnupg debian-keyring debian-archive-keyring \
  apt-transport-https unattended-upgrades fonts-dejavu-core >/dev/null   # dejavu: text in result pictures
systemctl disable --now ssh >/dev/null 2>&1 || true   # managed via `pct exec` from the host
echo "packages: ok"

# security updates for everything from apt (Ubuntu + the Caddy repo); Node is below
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52caddy-unattended <<'EOF'
Unattended-Upgrade::Origins-Pattern { "site=dl.cloudsmith.io"; };
EOF

# Node 24 LTS from nodejs.org, checksum-verified. Re-running this script installs the
# newest 24.x when one is out (Node has no apt feed here), so re-run it now and then.
cd /tmp
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
F=$(grep -o 'node-v24[.0-9]*-linux-x64.tar.xz' SHASUMS256.txt | head -1)
LATEST=${F#node-}; LATEST=${LATEST%-linux-x64.tar.xz}
if [ "$(node -v 2>/dev/null || true)" != "$LATEST" ]; then
  curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$F"
  grep " $F\$" SHASUMS256.txt | sha256sum -c -
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$F" -C /usr/local/lib/nodejs
  D="/usr/local/lib/nodejs/${F%.tar.xz}"
  for b in node npm npx; do ln -sf "$D/bin/$b" "/usr/local/bin/$b"; done
  rm -f "$F"
  # drop older installs
  find /usr/local/lib/nodejs -mindepth 1 -maxdepth 1 -type d ! -name "${F%.tar.xz}" -exec rm -rf {} +
  systemctl try-restart bracket-battle 2>/dev/null || true
fi
rm -f SHASUMS256.txt
echo "node: $(node -v)  npm: $(npm -v)"
# the app is IPv4-only; no reason for the container to speak IPv6 at all
printf 'net.ipv6.conf.all.disable_ipv6 = 1\nnet.ipv6.conf.default.disable_ipv6 = 1\n' > /etc/sysctl.d/90-no-ipv6.conf
sysctl -q --system >/dev/null 2>&1 || true

# Caddy from its official apt repo (caddyserver.com/docs/install)
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get -y -qq install caddy >/dev/null
  systemctl stop caddy   # started later, once the hostname and port forwards are ready
fi
echo "caddy: $(caddy version)"

# unprivileged user that owns and runs the app
id brackets >/dev/null 2>&1 || useradd --system --home /opt/bracket-battle --shell /usr/sbin/nologin brackets
echo "setup: done"

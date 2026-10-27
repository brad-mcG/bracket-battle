#!/bin/bash
# Runs INSIDE the web container: unpacks /tmp/bb.tgz over /opt/bracket-battle (code only,
# never data/ unless the bundle carries a first-time data seed), installs deps, restarts.
set -euo pipefail
export LANG=C.UTF-8 PATH=/usr/local/bin:$PATH
APP=/opt/bracket-battle

mkdir -p "$APP"
# list first, then grep: `tar | grep -q` under pipefail can report failure on a match
listing=$(tar tzf /tmp/bb.tgz)
if grep -q '^data/' <<<"$listing"; then
  if [ -n "$(ls -A "$APP/data/brackets" 2>/dev/null)" ]; then
    echo "refusing to overwrite existing server data in $APP/data" >&2
    rm -f /tmp/bb.tgz
    exit 1
  fi
  echo "seeding server data from this bundle"
fi
tar xzf /tmp/bb.tgz -C "$APP" --no-same-owner
rm -f /tmp/bb.tgz
cd "$APP"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

chown -R root:root "$APP"
mkdir -p "$APP/data/brackets" "$APP/data/games" "$APP/data/covers"
chown -R brackets:brackets "$APP/data"

install -m 644 deploy/bracket-battle.service /etc/systemd/system/bracket-battle.service
systemctl daemon-reload
systemctl enable --quiet bracket-battle
systemctl restart bracket-battle
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3002/api/brackets && break; sleep 0.5; done
systemctl is-active bracket-battle
echo "app answers: $(curl -s http://127.0.0.1:3002/api/brackets | head -c 120)"

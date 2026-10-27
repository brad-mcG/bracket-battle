#!/bin/bash
# Ship the app from this PC to the web container on Proxmox (run from Git Bash):
#   deploy/push.sh              code only; the server keeps its own brackets, games and covers
#   deploy/push.sh --with-data  first deploy: also seed the server with this PC's brackets and
#                               covers (refused if the server already has brackets)
set -euo pipefail
cd "$(dirname "$0")/.."
# the Proxmox host and container id live in deploy/local.sh (not committed): PVE=root@<host>  CT=<id>
[ -f deploy/local.sh ] && . deploy/local.sh
: "${PVE:?set PVE in deploy/local.sh}" "${CT:?set CT in deploy/local.sh}"

sed -i 's/\r$//' deploy/*.sh deploy/*.service   # Windows line endings break bash/systemd
npm run build --silent
files=(server.js package.json package-lock.json public src scripts deploy)
if [ "${1:-}" = "--with-data" ]; then files+=(data/brackets data/covers); fi
tar czf /tmp/bb.tgz --owner=0 --group=0 "${files[@]}"

scp -q -o BatchMode=yes /tmp/bb.tgz deploy/install.sh "$PVE:/tmp/"
rm -f /tmp/bb.tgz
ssh -o BatchMode=yes "$PVE" "pct push $CT /tmp/bb.tgz /tmp/bb.tgz && pct push $CT /tmp/install.sh /tmp/install.sh && \
  rm -f /tmp/bb.tgz /tmp/install.sh && pct exec $CT -- bash /tmp/install.sh"

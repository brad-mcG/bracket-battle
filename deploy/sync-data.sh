#!/bin/bash
# Copy this PC's brackets and covers up to the web container (run from Git Bash):
#   deploy/sync-data.sh
# Adds or replaces bracket files and covers by name; never touches the server's games or
# pictures. Use after importing or editing brackets on the local copy.
set -euo pipefail
cd "$(dirname "$0")/.."
# the Proxmox host and container id live in deploy/local.sh (not committed): PVE=root@<host>  CT=<id>
[ -f deploy/local.sh ] && . deploy/local.sh
: "${PVE:?set PVE in deploy/local.sh}" "${CT:?set CT in deploy/local.sh}"

# an import may be writing covers meanwhile: tar exit 1 only means "a file changed", keep going
tar czf /tmp/bb-data.tgz --owner=0 --group=0 --warning=no-file-changed data/brackets data/covers || [ $? -eq 1 ]
scp -q -o BatchMode=yes /tmp/bb-data.tgz "$PVE:/tmp/bb-data.tgz"
rm -f /tmp/bb-data.tgz
ssh -o BatchMode=yes "$PVE" "pct push $CT /tmp/bb-data.tgz /tmp/bb-data.tgz && rm -f /tmp/bb-data.tgz && \
  pct exec $CT -- bash -c 'cd /opt/bracket-battle && tar xzf /tmp/bb-data.tgz --no-same-owner && rm /tmp/bb-data.tgz && \
  chown -R brackets:brackets data/brackets data/covers && echo brackets: \$(ls data/brackets | wc -l) covers: \$(ls data/covers | wc -l)'"

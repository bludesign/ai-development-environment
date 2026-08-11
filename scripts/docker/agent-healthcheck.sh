#!/bin/sh
# Docker does not apply ENTRYPOINT to HEALTHCHECK. Drop privileges here before
# loading the node-owned control-agent bundle so writable application code can
# never be executed by the healthcheck as root.
set -e

if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=node --regid=node --init-groups \
    node /app/dist/control-agent.js status
fi

exec node /app/dist/control-agent.js status

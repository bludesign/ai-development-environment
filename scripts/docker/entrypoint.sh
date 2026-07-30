#!/bin/sh
# Volume ownership fixup, shared by Dockerfile and agent.Dockerfile.
#
# The documented run commands bind-mount host directories at the image's VOLUME paths, and
# those arrive owned by whoever created them on the host rather than by `node` (uid 1000).
# The server then cannot create /data/production.db and `prisma migrate deploy` aborts the
# boot; the agent cannot write /data/config.json. Take ownership while we still have root,
# then drop to `node` for the process itself.
#
# Running the container with an explicit `--user` skips the fixup: the caller has already
# chosen an identity, and a non-root process cannot chown anyway.
set -e

if [ "$(id -u)" = "0" ]; then
  for directory in ${ENTRYPOINT_OWNED_PATHS:-/data}; do
    mkdir -p "$directory"
    # Bind mounts backed by virtiofs (Docker Desktop) refuse chown while still being
    # writable, so a failure here is not worth aborting the boot over.
    chown -R node:node "$directory" 2>/dev/null || true
  done
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"

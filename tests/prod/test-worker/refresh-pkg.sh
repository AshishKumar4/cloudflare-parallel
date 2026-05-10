#!/bin/bash
# Rebuild the local cloudflare-parallel tarball that the test worker
# consumes, then re-install. Run from any directory; the script resolves
# its own location.
#
# Why a tarball? The test worker depends on the library's source tree
# above it. Bun's `file:../../../` install copies the WHOLE working
# directory including the library's own `node_modules`, which produces a
# recursive `examples/scheduler/node_modules/cloudflare-parallel/...`
# tree that exhausts inode and path limits. Installing from a packed
# tarball gives bun a closed dependency unit and avoids the recursion.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LIB_ROOT="${SCRIPT_DIR}/../../.."

cd "$LIB_ROOT"
bun run build
TGZ="$(npm pack --silent)"
mv "$TGZ" "${SCRIPT_DIR}/cloudflare-parallel-pkg.tgz"
echo "==> rebuilt ${SCRIPT_DIR}/cloudflare-parallel-pkg.tgz"

cd "$SCRIPT_DIR"
rm -rf node_modules/cloudflare-parallel
bun install
echo "==> reinstalled in test-worker"

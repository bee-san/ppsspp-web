#!/usr/bin/env sh
# Regenerate the scene and build EBOOT.PBP with the pspdev toolchain in Docker.
set -e
cd "$(dirname "$0")"
python3 gen_scene.py
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/src -w /src pspdev/pspdev:latest sh -c "make clean >/dev/null 2>&1 || true; make"
ls -la EBOOT.PBP

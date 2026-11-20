#!/usr/bin/env bash
# 在 Ubuntu / WSL 交叉編譯 Windows x64 的 pip_host.exe
#   sudo apt install gcc-mingw-w64-x86-64
set -euo pipefail
cd "$(dirname "$0")"
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -s -static-libgcc \
  pip_host.c -o pip_host.exe -luser32
echo "built: $(pwd)/pip_host.exe"

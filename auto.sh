#!/usr/bin/env sh
# Linux / macOS / Termux: setup + tes + (opsional) server. Pemakaian: ./auto.sh [setup|test|serve]
# Installer .exe dan APK hanya bisa dibangun di Windows (auto.bat).
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js belum terpasang. Pasang Node 22+ dari https://nodejs.org (Termux: pkg install nodejs)"; exit 1; }
exec node scripts/auto.js "$@"

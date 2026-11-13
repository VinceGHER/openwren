#!/bin/bash
# Measure the whole app: start-up time, memory, idle CPU and package sizes.
# The numbers in docs/benchmarks.md come from this script and from
# `cargo bench --bench engine` (see that file for how to read them).
#
#   scripts/bench.sh [messages]        default 50000
#
# Needs a release build (`pnpm tauri build --bundles deb`) and a desktop
# session: the app window opens and closes several times. It uses a synthetic
# mailbox in a temporary folder and never touches your own mail.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/src-tauri/target/release/openwren"
count=${1:-50000}
starts=${STARTS:-10}
idle=${IDLE_SECONDS:-300}
[ -x "$bin" ] || { echo "Build the app first: pnpm tauri build --bundles deb" >&2; exit 1; }
if pgrep -x openwren >/dev/null; then echo "Close OpenWren first." >&2; exit 1; fi

data=$(mktemp -d)
trap 'pkill -x openwren 2>/dev/null || true; rm -rf "$data"' EXIT
(cd "$root/src-tauri" && cargo run --quiet --release --example make_bench_data -- "$data" "$count")
export XDG_DATA_HOME="$data" OPENWREN_NO_STATS=1

# Every process the app started: itself and the web view's helpers.
tree() { local pid=$1; echo "$pid"; for child in $(pgrep -P "$pid" || true); do tree "$child"; done; }
median() { sort -n | awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : int((v[NR / 2] + v[NR / 2 + 1]) / 2) }'; }

echo "## Start-up ($count messages, $starts starts)"
inside=(); wall=()
for i in $(seq "$starts"); do
  t0=$(date +%s%N)
  ms=$(OPENWREN_TIMING=exit "$bin" 2>&1 >/dev/null | awk '/^openwren-ready-ms/ { print $2 }')
  t1=$(date +%s%N)
  inside+=("$ms"); wall+=("$(( (t1 - t0) / 1000000 ))")
  echo "start $i: inbox on screen after ${ms} ms (whole run, including quitting: ${wall[-1]} ms)"
done
echo "first start: ${inside[0]} ms"
echo "median of the others: $(printf '%s\n' "${inside[@]:1}" | median) ms"

echo
echo "## Memory and idle CPU"
"$bin" >/dev/null 2>&1 &
app=$!
sleep 60
pids=$(tree "$app")
pss=0
for pid in $pids; do
  kb=$(awk '/^Pss:/ { print $2 }' "/proc/$pid/smaps_rollup" 2>/dev/null || echo 0)
  pss=$((pss + ${kb:-0}))
done
echo "memory after 60 s idle with the inbox open: $((pss / 1024)) MB (proportional set size, $(echo "$pids" | wc -l) processes)"
ticks() { local total=0; for pid in $pids; do t=$(awk '{ print $14 + $15 }' "/proc/$pid/stat" 2>/dev/null || echo 0); total=$((total + t)); done; echo "$total"; }
before=$(ticks)
sleep "$idle"
after=$(ticks)
hz=$(getconf CLK_TCK)
echo "CPU time over $idle s idle: $(awk -v d=$((after - before)) -v hz="$hz" 'BEGIN { printf "%.2f", d / hz }') s"
kill "$app" 2>/dev/null || true
wait "$app" 2>/dev/null || true

echo
echo "## Size"
for file in "$root"/src-tauri/target/release/bundle/deb/*.deb "$root"/src-tauri/target/release/bundle/rpm/*.rpm "$root"/src-tauri/target/release/bundle/appimage/*.AppImage; do
  [ -f "$file" ] && echo "$(basename "$file"): $(du -h "$file" | cut -f1)"
done
deb=$(ls "$root"/src-tauri/target/release/bundle/deb/*.deb 2>/dev/null | head -1)
[ -n "$deb" ] && echo "installed size: $(dpkg-deb -f "$deb" Installed-Size) KB"
echo "program file: $(du -h "$bin" | cut -f1)"

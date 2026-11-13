#!/usr/bin/env bash
# Check a downloaded copy of the package repositories before anything in it is
# signed again.
#
#   OPENWREN_GPG_KEY=<fingerprint> scripts/verify-repo.sh <site-dir>
#
# The release adds new packages to what the bucket already holds and signs fresh
# indexes over all of it. Without this check, a file planted in the bucket would
# be listed in a validly signed index by the next release. So every package
# already there must be one a previous release published:
#   apt: listed, with the same SHA-256, in the Packages index named by an
#        InRelease file that carries a good signature of the OpenWren key;
#   rpm: signed by the OpenWren key itself.
# An empty bucket (the very first release) passes.
# Needs: gpg with the OpenWren public key in its keyring, sha256sum, awk, rpmkeys.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: OPENWREN_GPG_KEY=<fingerprint> $0 <site-dir>" >&2
  exit 2
fi
: "${OPENWREN_GPG_KEY:?set OPENWREN_GPG_KEY to the fingerprint of the signing key}"
key=$(printf '%s' "$OPENWREN_GPG_KEY" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
site=$(cd "$1" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "verify-repo: $*" >&2; exit 1; }

shopt -s nullglob globstar

# ----- apt -----
debs=("$site"/apt/pool/**/*.deb)
if [ ${#debs[@]} -gt 0 ]; then
  inrelease="$site/apt/dists/stable/InRelease"
  [ -f "$inrelease" ] || fail "apt/pool has packages but there is no signed InRelease"
  # The signed text itself is used below, not the separate Release file.
  gpg --batch --status-fd 3 --output "$work/Release" --decrypt "$inrelease" 3> "$work/status" 2> /dev/null \
    || fail "InRelease does not verify"
  grep -Eq "^\[GNUPG:\] VALIDSIG .* $key\$|^\[GNUPG:\] VALIDSIG $key " "$work/status" \
    || fail "InRelease is not signed by the OpenWren key"

  index=main/binary-amd64/Packages
  listed=$(awk -v f="$index" '/^SHA256:/ {on=1; next} /^[^ ]/ {on=0} on && $3 == f {print $1}' "$work/Release")
  [ -n "$listed" ] || fail "the signed Release does not list $index"
  actual=$(sha256sum "$site/apt/dists/stable/$index" | cut -d' ' -f1)
  [ "$listed" = "$actual" ] || fail "$index does not match the signed Release"

  for deb in "${debs[@]}"; do
    path=${deb#"$site/apt/"}
    want=$(awk -v f="$path" '$1 == "Filename:" {hit = ($2 == f)} $1 == "SHA256:" && hit {print $2; exit} /^$/ {hit = 0}' "$site/apt/dists/stable/$index")
    [ -n "$want" ] || fail "apt/$path is not in the signed index: it was not published by a release"
    have=$(sha256sum "$deb" | cut -d' ' -f1)
    [ "$want" = "$have" ] || fail "apt/$path differs from the signed index"
  done
  echo "apt: ${#debs[@]} package(s) match the signed index"
fi

# ----- rpm -----
rpms=("$site"/rpm/*.rpm)
if [ ${#rpms[@]} -gt 0 ]; then
  gpg --batch --armor --export "$key" > "$work/key.asc"
  mkdir "$work/rpmdb"
  rpmkeys --dbpath "$work/rpmdb" --import "$work/key.asc"
  for rpm in "${rpms[@]}"; do
    # "digests signatures OK" needs a signature made by the one key imported above.
    result=$(rpmkeys --dbpath "$work/rpmdb" --checksig "$rpm" 2>&1) || true
    case "$result" in
      *"signatures OK") ;;
      *) fail "rpm/$(basename "$rpm") is not signed by the OpenWren key: it was not published by a release" ;;
    esac
  done
  echo "rpm: ${#rpms[@]} package(s) carry the OpenWren signature"
fi

#!/usr/bin/env bash
# Build (or update) a signed apt repository of static files.
#
#   OPENWREN_GPG_KEY=<key id or fingerprint> scripts/make-apt-repo.sh <dir-with-debs> <output-dir>
#
# Layout written under <output-dir>:
#   pool/main/<letter>/<package>/<file>.deb
#   dists/stable/main/binary-amd64/Packages, Packages.gz
#   dists/stable/Release, InRelease, Release.gpg
#   key.gpg (binary) and key.asc (armored): the public signing key
#
# Packages already in <output-dir>/pool are kept and indexed again, so running
# this on the previous repository plus one new .deb adds a version.
# Needs: apt-ftparchive (apt-utils), dpkg-deb, gpg, gzip. The secret key must be
# in the gpg keyring (GNUPGHOME is respected) and have no passphrase.
set -euo pipefail

suite=stable
component=main
arch=amd64

if [ $# -ne 2 ]; then
  echo "usage: OPENWREN_GPG_KEY=<key> $0 <dir-with-debs> <output-dir>" >&2
  exit 2
fi
: "${OPENWREN_GPG_KEY:?set OPENWREN_GPG_KEY to the id or fingerprint of the signing key}"

for tool in apt-ftparchive dpkg-deb gpg gzip; do
  command -v "$tool" >/dev/null || { echo "$0: $tool is not installed" >&2; exit 1; }
done

debs=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)

shopt -s nullglob
new=("$debs"/*.deb)
if [ ${#new[@]} -eq 0 ] && [ ! -d "$out/pool" ]; then
  echo "$0: no .deb files in $debs and no existing pool in $out" >&2
  exit 1
fi

# 1. Copy the new packages into the pool.
for deb in "${new[@]}"; do
  package=$(dpkg-deb -f "$deb" Package)
  dir="$out/pool/$component/${package:0:1}/$package"
  mkdir -p "$dir"
  cp -f "$deb" "$dir/"
  echo "pool: $component/${package:0:1}/$package/$(basename "$deb")"
done

# 2. Index everything in the pool. Paths in Packages are relative to <output-dir>.
index="dists/$suite/$component/binary-$arch"
mkdir -p "$out/$index"
cd "$out"
apt-ftparchive --arch "$arch" packages pool > "$index/Packages"
gzip -9 -n -c "$index/Packages" > "$index/Packages.gz"

# 3. Release file with the checksums of the indexes. Written elsewhere first so
#    that it does not list itself or a stale signature.
rm -f "dists/$suite/Release" "dists/$suite/InRelease" "dists/$suite/Release.gpg"
release=$(mktemp)
trap 'rm -f "$release"' EXIT
apt-ftparchive \
  -o "APT::FTPArchive::Release::Origin=OpenWren" \
  -o "APT::FTPArchive::Release::Label=OpenWren" \
  -o "APT::FTPArchive::Release::Suite=$suite" \
  -o "APT::FTPArchive::Release::Codename=$suite" \
  -o "APT::FTPArchive::Release::Architectures=$arch" \
  -o "APT::FTPArchive::Release::Components=$component" \
  -o "APT::FTPArchive::Release::Description=OpenWren packages" \
  release "dists/$suite" > "$release"
install -m 644 "$release" "dists/$suite/Release"

# 4. Sign: InRelease (inline) and Release.gpg (detached).
sign=(gpg --batch --yes --local-user "$OPENWREN_GPG_KEY" --digest-algo SHA256)
"${sign[@]}" --clearsign --output "dists/$suite/InRelease" "dists/$suite/Release"
"${sign[@]}" --armor --detach-sign --output "dists/$suite/Release.gpg" "dists/$suite/Release"

# 5. Public key, in both forms.
gpg --batch --yes --export "$OPENWREN_GPG_KEY" > key.gpg
gpg --batch --yes --armor --export "$OPENWREN_GPG_KEY" > key.asc

echo "apt repository ready in $out ($(grep -c '^Package:' "$index/Packages") package entries)"

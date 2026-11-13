#!/usr/bin/env bash
# Build (or update) a signed rpm (dnf/yum) repository of static files.
#
#   OPENWREN_GPG_KEY=<key id or fingerprint> scripts/make-rpm-repo.sh <dir-with-rpms> <output-dir>
#
# Written under <output-dir>:
#   <file>.rpm            each package, signed with the key
#   repodata/             metadata from createrepo_c
#   repodata/repomd.xml.asc   detached signature of repomd.xml
#   openwren.repo         what users put in /etc/yum.repos.d/
#
# Packages already in <output-dir> are kept and indexed again.
# Needs: rpmsign (package rpm-sign on Fedora, rpm on Debian/Ubuntu),
# createrepo_c, gpg. The secret key must be in the gpg keyring (GNUPGHOME is
# respected) and have no passphrase.
set -euo pipefail

base_url=https://packages.openwren.app/rpm
key_url=https://packages.openwren.app/key.asc

if [ $# -ne 2 ]; then
  echo "usage: OPENWREN_GPG_KEY=<key> $0 <dir-with-rpms> <output-dir>" >&2
  exit 2
fi
: "${OPENWREN_GPG_KEY:?set OPENWREN_GPG_KEY to the id or fingerprint of the signing key}"

for tool in rpmsign createrepo_c gpg; do
  command -v "$tool" >/dev/null || { echo "$0: $tool is not installed" >&2; exit 1; }
done

rpms=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)

shopt -s nullglob
new=("$rpms"/*.rpm)
existing=("$out"/*.rpm)
if [ ${#new[@]} -eq 0 ] && [ ${#existing[@]} -eq 0 ]; then
  echo "$0: no .rpm files in $rpms and none in $out" >&2
  exit 1
fi

# rpm's built-in path to gpg is wrong on some systems (Ubuntu 22.04 looks for gpg2).
gpg_bin=$(command -v gpg)

# 1. Copy the new packages in and sign the copies (the input is left untouched).
#    --resign replaces any signature already there, so a rerun is harmless.
for rpm in "${new[@]}"; do
  copy="$out/$(basename "$rpm")"
  cp -f "$rpm" "$copy"
  rpmsign --resign \
    --define "_openpgp_sign gpg" \
    --define "__gpg $gpg_bin" \
    --define "_gpg_name $OPENWREN_GPG_KEY" \
    --define "_gpg_digest_algo sha256" \
    "$copy"
  echo "signed: $(basename "$copy")"
done

# 2. Metadata for everything in the directory.
createrepo_c --update --quiet "$out"

# 3. Detached signature of repomd.xml (checked by repo_gpgcheck=1).
gpg --batch --yes --local-user "$OPENWREN_GPG_KEY" --digest-algo SHA256 \
  --armor --detach-sign --output "$out/repodata/repomd.xml.asc" "$out/repodata/repomd.xml"

# 4. The .repo file users install.
cat > "$out/openwren.repo" <<EOF
[openwren]
name=OpenWren
baseurl=$base_url
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$key_url
EOF

count=("$out"/*.rpm)
echo "rpm repository ready in $out (${#count[@]} packages)"

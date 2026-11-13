# Packaging and releases

How a tag becomes signed apt and rpm repositories, an AppImage and a GitHub Release.

## How the pieces fit

| Piece | What it does |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.targets` lists `deb`, `rpm`, `appimage`; `bundle.linux.deb.depends` and `bundle.linux.rpm.depends` name the runtime libraries |
| `scripts/make-apt-repo.sh <dir-with-debs> <output-dir>` | Copies the `.deb` files into `pool/`, writes `dists/stable/main/binary-amd64/Packages(.gz)` and `dists/stable/Release`, signs them (`InRelease`, `Release.gpg`), exports the public key as `key.gpg` (binary) and `key.asc` |
| `scripts/make-rpm-repo.sh <dir-with-rpms> <output-dir>` | Copies and signs the `.rpm` files, runs `createrepo_c`, signs `repodata/repomd.xml` (`repomd.xml.asc`), writes `openwren.repo` |
| `.github/workflows/release.yml` | On a tag `v*`: builds the three packages, writes `SHA256SUMS`, downloads the bucket, runs both scripts, creates the GitHub Release, uploads the bucket |
| `.github/workflows/packages.yml` | On pull requests: builds the `.deb` and `.rpm`, installs them in Ubuntu 22.04, Ubuntu 24.04, Debian 12 and Fedora containers, runs `openwren --version` |

Both scripts take the signing key from the environment variable `OPENWREN_GPG_KEY` (key id or fingerprint) and keep what is already in the output directory: old versions stay installable, and the index is rebuilt from everything present. That is why the release workflow downloads the bucket before running them.

The repositories are plain files in the Cloudflare R2 bucket `openwren-packages`, served read-only at `packages.openwren.app` by the small Worker in `packages/`:

```
key.gpg  key.asc                 public signing key (binary and armored)
apt/dists/stable/...             apt index and signatures
apt/pool/main/o/open-wren/...    .deb files
apt/key.gpg  apt/key.asc         same key (written by the apt script)
rpm/*.rpm                        signed .rpm files
rpm/repodata/...                 rpm index and repomd.xml.asc
rpm/openwren.repo
```

Package name: Tauri derives it from `productName`, so the package itself is called **`open-wren`** (the installed program is `/usr/bin/openwren`). Both packages declare `Provides: openwren`, so `apt install openwren` and `dnf install openwren` work and are what the documentation tells users to run; package lists and `apt remove` show `open-wren`.

## One-time setup

### 1. Signing key

One GPG key signs the packages and the repository indexes. Create it without a passphrase (CI cannot type one), for signing only. RSA is understood by every rpm and apt version in use.

```bash
export GNUPGHOME=$(mktemp -d)        # keep it out of your everyday keyring
gpg --batch --passphrase '' --quick-generate-key "OpenWren Packages <packages@openwren.app>" rsa4096 sign 2y

gpg --list-secret-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}'   # the fingerprint
gpg --armor --export <FINGERPRINT> > key.asc                                 # public part
gpg --armor --export-secret-keys <FINGERPRINT> > private.asc                 # goes into the GitHub secret
```

Publish the fingerprint on the website so users can compare it. Keep a copy of `private.asc` offline, then delete it and the temporary `GNUPGHOME`. When the key nears its expiry, extend it (`gpg --quick-set-expire <FINGERPRINT> 2y`), export it again, update the secret, and cut a release so `key.gpg` and `key.asc` are republished.

### 2. Cloudflare R2

1. The R2 bucket `openwren-packages` exists and is served at `packages.openwren.app` by the Worker in `packages/` (`wrangler deploy` there after changing it).
2. Create an R2 API token with "Object Read & Write" on that bucket only. Note the access key id, the secret access key and the Cloudflare account id.

### 3. GitHub repository settings

Settings → Secrets and variables → Actions.

| Kind | Name | Value |
|---|---|---|
| Secret | `GPG_PRIVATE_KEY` | Contents of `private.asc` (armored private key) |
| Secret | `R2_ACCOUNT_ID` | Cloudflare account id (the workflow uses `https://<id>.r2.cloudflarestorage.com`) |
| Secret | `R2_ACCESS_KEY_ID` | R2 API token: access key id |
| Secret | `R2_SECRET_ACCESS_KEY` | R2 API token: secret access key |
| Variable | `GPG_KEY_ID` | Fingerprint of the signing key |
| Variable | `R2_BUCKET` | Name of the bucket |

With the GitHub CLI:

```bash
gh secret set GPG_PRIVATE_KEY < private.asc
gh secret set R2_ACCOUNT_ID
gh secret set R2_ACCESS_KEY_ID
gh secret set R2_SECRET_ACCESS_KEY
gh variable set GPG_KEY_ID --body <FINGERPRINT>
gh variable set R2_BUCKET --body <bucket-name>
```

## Cutting a release

1. Set the new version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, and commit. The workflow stops if the tag and the version in `tauri.conf.json` differ.
2. Tag and push:

```bash
git tag v0.2.0 && git push --tags
```

The release workflow then publishes a GitHub Release with the `.deb`, `.rpm`, `.AppImage` and `SHA256SUMS`, and updates both repositories. Packages are uploaded before the indexes, so an index never points at a missing file. If the run fails after the GitHub Release was created, delete that release before re-running (`gh release delete v0.2.0`); re-running the repository steps is safe.

## Installing (what users run)

Debian, Ubuntu and derivatives:

```bash
curl -fsSL https://packages.openwren.app/key.gpg | sudo tee /usr/share/keyrings/openwren.gpg > /dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openwren.gpg] https://packages.openwren.app/apt stable main" | sudo tee /etc/apt/sources.list.d/openwren.list
sudo apt update && sudo apt install openwren
```

Fedora, RHEL and derivatives (dnf or yum):

```bash
sudo curl -fsSL -o /etc/yum.repos.d/openwren.repo https://packages.openwren.app/rpm/openwren.repo
sudo dnf install openwren
```

dnf asks once to accept the signing key; the fingerprint it shows should match the published one.

AppImage: download it from the GitHub Release, check it against `SHA256SUMS`, `chmod +x`, run.

## Testing locally

The scripts need `apt-ftparchive` (package `apt-utils`), `dpkg-deb`, `gpg`, and for rpm `rpmsign` (`rpm` on Debian/Ubuntu, `rpm-sign` on Fedora) and `createrepo_c` (`createrepo-c` on Debian/Ubuntu). Use a throwaway key so nothing touches your real keyring:

```bash
work=$(mktemp -d)
export GNUPGHOME=$work/gnupg && mkdir -m 700 "$GNUPGHOME"
gpg --batch --passphrase '' --quick-generate-key "Test <test@example.invalid>" rsa3072 sign 1d
export OPENWREN_GPG_KEY=$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}')

mkdir "$work/in"
cp src-tauri/target/release/bundle/deb/OpenWren_*.deb "$work/in/"
scripts/make-apt-repo.sh "$work/in" "$work/apt"
```

Install from it in a clean container:

```bash
docker run --rm -v "$work/apt":/repo:ro ubuntu:24.04 bash -c '
  install -m 644 /repo/key.gpg /usr/share/keyrings/openwren.gpg
  echo "deb [signed-by=/usr/share/keyrings/openwren.gpg] file:///repo stable main" > /etc/apt/sources.list.d/openwren.list
  apt-get update && apt-get install -y open-wren && openwren --version'
```

The rpm side, in Fedora (mount the scripts, the key directory and a directory holding an `.rpm`):

```bash
docker run --rm -v "$PWD/scripts":/scripts:ro -v "$GNUPGHOME":/gnupg-src:ro -v "$work/in":/in:ro \
  -e OPENWREN_GPG_KEY fedora:latest bash -c '
  dnf install -y -q rpm-sign createrepo_c gnupg2
  cp -r /gnupg-src /root/gnupg && chmod 700 /root/gnupg && export GNUPGHOME=/root/gnupg
  /scripts/make-rpm-repo.sh /in /out
  gpg --armor --export "$OPENWREN_GPG_KEY" > /tmp/key.asc
  sed -e "s#^baseurl=.*#baseurl=file:///out#" -e "s#^gpgkey=.*#gpgkey=file:///tmp/key.asc#" /out/openwren.repo > /etc/yum.repos.d/openwren.repo
  dnf -y --repo openwren makecache'
```

Clean up with `rm -rf "$work"`. Lint with `shellcheck scripts/make-*-repo.sh` and `actionlint`.

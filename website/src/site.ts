export const REPO_URL = 'https://github.com/VinceGHER/openwren';
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const ADVISORY_URL = `${REPO_URL}/security/advisories/new`;
export const DEFAULT_STATS_URL = 'https://stats.openwren.app';

const FILES = 'https://packages.openwren.app';

/** What the download page offers: the newest published release. */
export interface Release {
  version: string;
  appImage: string;
  windows: string;
  mac: string;
  /** Which Macs the macOS download runs on. */
  macNote: string;
  checksums: string;
  /** True when the app tells users about new versions and installs them itself. */
  selfUpdating: boolean;
}

/**
 * Read when the site is built, from the same latest.json the app checks, so the
 * page never links to a file that is not there. Deploy the site after a release
 * to show the new version. Before the first release with latest.json, the page
 * offers the earlier builds.
 */
async function publishedRelease(): Promise<Release> {
  try {
    const response = await fetch(`${FILES}/latest.json`);
    if (response.ok) {
      const { version } = (await response.json()) as { version: string };
      if (/^\d+\.\d+\.\d+$/.test(version)) {
        const base = `${FILES}/releases/${version}`;
        return {
          version,
          appImage: `${base}/openwren_${version}_amd64.AppImage`,
          windows: `${base}/OpenWren_${version}_x64-setup.exe`,
          mac: `${base}/OpenWren_${version}_universal.dmg`,
          macNote: 'For all Macs, Apple silicon and Intel, with macOS 11 or later.',
          checksums: `${base}/SHA256SUMS`,
          selfUpdating: true,
        };
      }
    }
  } catch {
    // No network while building: fall through to the earlier builds.
  }
  return {
    version: '0.1.3',
    appImage: `${REPO_URL}/releases/latest`,
    windows: `${FILES}/preview/OpenWren-windows-x64-setup.exe`,
    mac: `${FILES}/preview/OpenWren-macos-arm64.dmg`,
    macNote: 'For Macs with Apple silicon (M1 or later), macOS 11 or later.',
    checksums: `${FILES}/preview/SHA256SUMS`,
    selfUpdating: false,
  };
}

export const RELEASE = await publishedRelease();

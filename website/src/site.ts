import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_URL = 'https://github.com/VinceGHER/openwren';
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const ADVISORY_URL = `${REPO_URL}/security/advisories/new`;
export const DEFAULT_STATS_URL = 'https://stats.openwren.app';

/**
 * The released version, read when the site is built from the app's own settings
 * (the release tag is checked against the same file). Deploy the site after each
 * release so the download page names the new version.
 */
export const VERSION: string = JSON.parse(readFileSync(join(process.cwd(), '..', 'src-tauri', 'tauri.conf.json'), 'utf8')).version;

/** Where the files of that release are served from. */
export const RELEASE_FILES = `https://packages.openwren.app/releases/${VERSION}`;

import { readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { binaryPaths } = require('selenium-webdriver/common/seleniumManager');

export async function resolveElectronDriver(address) {
    const response = await fetch(`http://${address}/json/version`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`Debugging endpoint returned HTTP ${response.status}`);
    const info = await response.json();
    const version = /(?:Chrome|Chromium)\/(\d+\.\d+\.\d+\.\d+)/.exec(`${info.Browser || ''} ${info['User-Agent'] || ''}`)?.[1];
    if (!version) throw new Error('Debugging endpoint did not report a Chromium version');
    const platform = process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : process.platform === 'linux' && process.arch === 'x64' ? 'linux64' : null;
    if (!platform) throw new Error('Automatic ChromeDriver selection is not supported on this platform');
    const root = join(homedir(), '.cache', 'selenium', 'chromedriver', platform);
    const versions = await readdir(root).catch(() => []);
    const build = version.split('.').slice(0, 3).join('.');
    const candidates = versions.filter(v => v.startsWith(`${build}.`) && /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort((a, b) => Number(b.split('.')[3]) - Number(a.split('.')[3]));
    for (const candidate of candidates) {
        const path = join(root, candidate, process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver');
        try { await access(path); return path; } catch { /* try another cached driver */ }
    }
    // const result = binaryPaths(['--browser', 'chrome', '--browser-version', version, '--avoid-browser-download', '--skip-driver-in-path', '--avoid-stats', '--timeout', '30', '--output', 'json']);
    // if (!result.driverPath) throw new Error('Selenium Manager did not return a ChromeDriver path');
    // return result.driverPath;
    throw new Error(`No cached ChromeDriver found for Chromium ${version}`);
}

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/chrome.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

async function getChromiumBuild(address) {
    const result = await fetch(`http://${address}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error(`Version endpoint returned HTTP ${result.status}`);
    const data = await result.json();
    const match = /^Chrome\/(\d+\.\d+\.\d+)\.\d+$/.exec(data.Browser ?? '');
    if (!match) throw new Error('Version endpoint did not report a valid Chromium version');
    return match[1];
}

async function resolveChromeDriver(build) {
    const directory = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform];
    if (!directory) throw new Error(`Unsupported platform: ${process.platform}`);
    const binary = process.env.SE_MANAGER_PATH || path.join(
        path.dirname(require.resolve('selenium-webdriver/package.json')),
        'bin', directory, process.platform === 'win32' ? 'selenium-manager.exe' : 'selenium-manager',
    );
    // Manager owns cache discovery and downloads; do not use an unrelated driver on PATH.
    const { stdout } = await run(binary, ['--browser', 'chrome', '--browser-version', build,
        '--skip-driver-in-path', '--avoid-browser-download', '--output', 'json'], { timeout: 120000 });
    const result = JSON.parse(stdout).result;
    if (result?.code !== 0 || !result.driver_path) throw new Error(result?.message || 'Selenium Manager returned no driver path');
    const version = await run(result.driver_path, ['--version'], { timeout: 10000 });
    const match = /\bChromeDriver\s+(\d+\.\d+\.\d+)\.\d+\b/.exec(version.stdout);
    if (!match || match[1] !== build) throw new Error(`Resolved ChromeDriver does not match Chromium build ${build}`);
    return result.driver_path;
}

const selenium = { Driver, Options, ServiceBuilder, getChromiumBuild, resolveChromeDriver };
const response = (text, isError = false) => ({
    ...(isError && { isError: true }),
    content: [{ type: 'text', text }],
});

export function validAddress(value) {
    if (typeof value !== 'string') return false;

    const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/.exec(value);
    if (!match) return false;

    const [, host, port] = match;
    if (Number(port) < 1 || Number(port) > 65535) return false;
    if (host.startsWith('[')) return isIP(host.slice(1, -1)) === 6;
    if (/^[0-9.]+$/.test(host)) return isIP(host) === 4;
    return host.length <= 253 && host.split('.').every(
        label => /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/.test(label),
    );
}

export async function attachElectron({ address }, state, api = selenium) {
    if (!validAddress(address)) {
        return response('Invalid debugging address; expected hostname or IP address and port, without a URL scheme.', true);
    }

    let service;
    let driver;
    let stage = 'Reading Chromium version';
    try {
        const build = await api.getChromiumBuild(address);
        stage = 'Resolving ChromeDriver';
        const driverPath = await api.resolveChromeDriver(build);
        stage = 'Attaching to Electron';
        service = new api.ServiceBuilder(driverPath).build();
        const options = new api.Options().debuggerAddress(address);
        driver = api.Driver.createSession(options, service);
        await driver.getSession();

        // Only register the session after confirming there is one unambiguous target.
        const handles = await driver.getAllWindowHandles();
        if (handles.length !== 1) {
            throw new Error('Expected exactly one browser window');
        }
        await driver.switchTo().window(handles[0]);
        const id = `electron_${randomUUID()}`;
        state.drivers.set(id, driver);
        state.currentSession = id;
        return response('Attached to Electron; the connected session is now current.');
    } catch (error) {
        // Attempt both cleanup steps even if one fails.
        let cleanupFailed = false;
        if (driver) {
            try { await driver.quit(); } catch { cleanupFailed = true; }
        }
        if (service) {
            try { await service.kill(); } catch { cleanupFailed = true; }
        }
        const reason = `${stage}: ${error.message}`;
        const cleanupWarning = cleanupFailed ? ' Cleanup encountered an error; check for a remaining ChromeDriver process.' : '';
        return response(`Electron attachment failed: ${reason}${cleanupWarning}`, true);
    }
}

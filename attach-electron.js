import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Driver, Options, ServiceBuilder } from 'selenium-webdriver/chrome.js';
import { resolveElectronDriver } from './electron-driver.js';

export function validAddress(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/.exec(value);
    if (!match || +match[2] < 1 || +match[2] > 65535) return false;
    const host = match[1];
    if (host.startsWith('[')) return isIP(host.slice(1, -1)) === 6;
    if (/^[0-9.]+$/.test(host)) return isIP(host) === 4;
    return host.length <= 253 && host.split('.').every(label => /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/.test(label));
}

export async function attachElectron({ address }, state, api = { Driver, Options, ServiceBuilder }) {
    if (!validAddress(address)) return { isError: true, content: [{ type: 'text', text: 'Invalid debugging address; expected hostname or IP address and port, without a URL scheme.' }] };
    let service, driver;
    try {
        const driverPath = await (api.resolveElectronDriver || resolveElectronDriver)(address);
        service = new api.ServiceBuilder(driverPath).build();
        const options = new api.Options().debuggerAddress(address);
        driver = api.Driver.createSession(options, service);
        await driver.getSession();
        const handles = await driver.getAllWindowHandles();
        if (handles.length !== 1) throw new Error('window count');
        await driver.switchTo().window(handles[0]);
        const id = `electron_${randomUUID()}`;
        state.drivers.set(id, driver);
        state.currentSession = id;
        return { content: [{ type: 'text', text: 'Attached to Electron; the connected session is now current.' }] };
    } catch (error) {
        let cleanupFailed = false;
        if (driver) {
            try { await driver.quit(); } catch { cleanupFailed = true; }
        }
        if (service) {
            try { await service.kill(); } catch { cleanupFailed = true; }
        }
        const reason = error.message === 'window count'
            ? 'Expected exactly one browser window; close extra windows or expose a single target before attaching.'
            : `Could not attach: ${error.message}`;
        return { isError: true, content: [{ type: 'text', text: `Electron attachment failed: ${reason}${cleanupFailed ? ' Cleanup encountered an error; check for a remaining ChromeDriver process.' : ''}` }] };
    }
}

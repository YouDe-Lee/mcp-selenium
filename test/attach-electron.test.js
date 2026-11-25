import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachElectron, validAddress } from '../attach-electron.js';

function fixture({ handles = ['one'], fail = false } = {}) {
    const calls = [];
    const driver = {
        getSession: async () => { if (fail) throw new Error('connection failed'); },
        getAllWindowHandles: async () => handles,
        switchTo: () => ({ window: async value => calls.push(['window', value]) }),
        quit: async () => calls.push(['quit'])
    };
    const api = {
        ServiceBuilder: class { constructor(path) { calls.push(['path', path]); } build() { return { kill: async () => calls.push(['kill']) }; } },
        Options: class { debuggerAddress(value) { calls.push(['address', value]); return this; } },
        Driver: { createSession: (options, service) => { calls.push(['create', options, service]); return driver; } }
    };
    return { api, calls, driver };
}

test('validates host and port without accepting URLs or credentials', () => {
    for (const value of ['localhost:9222', '127.0.0.1:1234', '[::1]:9222']) assert.equal(validAddress(value), true);
    for (const value of ['', 'http://localhost:9222', 'user@host:9222', 'localhost:0', 'host:65536', '999.1.1.1:1']) assert.equal(validAddress(value), false);
});

test('creates and registers the attached driver', async () => {
    const f = fixture(); const state = { drivers: new Map(), currentSession: null };
    const result = await attachElectron({ address: 'localhost:9222', chromeDriverPath: 'driver' }, state, f.api);
    assert.equal(result.isError, undefined);
    assert.equal(state.drivers.get(state.currentSession), f.driver);
    assert.deepEqual(f.calls.slice(0, 2), [['path', 'driver'], ['address', 'localhost:9222']]);
    assert.deepEqual(f.calls.at(-1), ['window', 'one']);
});

test('rejects bad inputs before creating a service', async () => {
    const f = fixture(); const state = { drivers: new Map(), currentSession: null };
    assert.equal((await attachElectron({ address: 'bad' }, state, f.api)).isError, true);
    assert.equal((await attachElectron({ address: 'host:1', chromeDriverPath: ' ' }, state, f.api)).isError, true);
    assert.equal(f.calls.length, 0);
});

test('cleans up failures and preserves the current session', async () => {
    for (const options of [{ fail: true }, { handles: [] }, { handles: ['one', 'two'] }]) {
        const f = fixture(options); const old = {}; const state = { drivers: new Map([['old', old]]), currentSession: 'old' };
        const result = await attachElectron({ address: 'host:9222' }, state, f.api);
        assert.equal(result.isError, true);
        assert.equal(state.currentSession, 'old');
        assert.equal(state.drivers.size, 1);
        assert.ok(f.calls.some(call => call[0] === 'quit'));
        assert.ok(f.calls.some(call => call[0] === 'kill'));
    }
});

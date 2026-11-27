import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinks, coreView, parseCdp, parseLldp, siteName } from './topology.js';

test('CDP is preferred and LLDP is the fallback', () => {
  const devices = [
    { ip: '10.0.0.1', sysName: 'core.example.net', sysLocation: 'Main', addresses: ['10.0.0.1'] },
    { ip: '10.0.0.2', sysName: 'edge', sysLocation: '', addresses: ['10.0.0.2', '10.9.9.2'] },
    { ip: '10.0.0.3', sysName: 'access.example.net', sysLocation: 'Annex' },
  ];
  const links = buildLinks(devices, [
    {
      ip: '10.0.0.1',
      cdp: [{ localIf: '1', remoteName: 'edge.example.net', remotePort: 'Gi0/1', remoteAddr: '' }],
      lldp: [{ localIf: '2', remoteName: 'access', remotePort: 'Te1/1', remoteAddr: '' }],
    },
    {
      ip: '10.0.0.3',
      cdp: [],
      lldp: [{ localIf: '4', remoteName: 'core', remotePort: 'Gi1/0/1', remoteAddr: '' }],
    },
  ]);
  assert.equal(links.length, 2);
  const coreEdge = links.find((link) => link.a === '10.0.0.1' && link.b === '10.0.0.2');
  assert.equal(coreEdge.protocol, 'cdp');
  const coreAccess = links.find((link) => link.b === '10.0.0.3');
  assert.equal(coreAccess.protocol, 'lldp');
  assert.equal(siteName(devices[0]), 'Main');
  assert.equal(siteName(devices[1]), 'No location');
});

test('neighbors are matched by address and unknown devices are dropped', () => {
  const devices = [
    { ip: '10.0.0.1', sysName: 'core', addresses: ['10.0.0.1'] },
    { ip: '10.0.0.2', sysName: 'edge', addresses: ['10.8.8.2'] },
  ];
  const links = buildLinks(devices, [
    {
      ip: '10.0.0.1',
      cdp: [
        { localIf: '1', remoteName: '', remotePort: 'Gi0', remoteAddr: '10.8.8.2' },
        { localIf: '2', remoteName: 'not-in-nms', remotePort: 'Gi1', remoteAddr: '192.0.2.9' },
      ],
      lldp: [],
    },
  ]);
  assert.equal(links.length, 1);
  assert.equal(links[0].b, '10.0.0.2');
});

test('CDP and LLDP table indexes keep the local interface', () => {
  const cdp = parseCdp({
    '5.1': { 4: Buffer.from([10, 0, 0, 2]), 6: 'edge', 7: 'Gi0/1' },
  });
  assert.equal(cdp[0].localIf, '5');
  assert.equal(cdp[0].remoteAddr, '10.0.0.2');
  const lldp = parseLldp({ '0.12.1': { 7: 'Te1/1', 9: 'core.example.net' } });
  assert.equal(lldp[0].localIf, '12');
  assert.equal(lldp[0].remoteName, 'core.example.net');
});

test('the core site stands alone and other sites show the path to it', () => {
  const sites = [
    { name: 'Annex', devices: [{ ip: '10.1.0.1' }] },
    { name: 'Main', devices: [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }] },
    { name: 'Remote', devices: [{ ip: '10.2.0.1' }] },
  ];
  const links = [
    { a: '10.0.0.1', b: '10.1.0.1' },
    { a: '10.1.0.1', b: '10.2.0.1' },
    { a: '10.0.0.2', b: '10.8.0.1' },
  ];
  const core = coreView(sites, links, 'Main', 'Main');
  assert.deepEqual(core.sites.map((site) => site.name), ['Main']);
  assert.equal(core.links.length, 0);
  assert.equal(core.note, 'Core');
  const remote = coreView(sites, links, 'Remote', 'Main');
  assert.deepEqual(remote.sites.map((site) => site.name), ['Main', 'Annex', 'Remote']);
  assert.deepEqual(remote.sites.find((site) => site.name === 'Main').devices.map((device) => device.ip), ['10.0.0.1']);
  assert.equal(remote.links.length, 2);
  assert.equal(remote.note, 'Path from Remote to the core');
  const island = coreView([...sites, { name: 'Island', devices: [{ ip: '10.9.0.1' }] }], links, 'Island', 'Main');
  assert.deepEqual(island.sites.map((site) => site.name), ['Island']);
  assert.equal(island.note, 'No neighbor path from Island to the core');
  const missing = coreView(sites, links, 'Remote', 'Absent');
  assert.equal(missing.note, 'The core site is not on the map.');
});

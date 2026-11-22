const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function fetchDevice(host?: string, community?: string) {
  const params = new URLSearchParams();
  if (host) params.set('host', host);
  if (community) params.set('community', community);
  const url = `${API}/api/device${params.toString() ? '?' + params : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSystem(host?: string, community?: string) {
  const params = new URLSearchParams();
  if (host) params.set('host', host);
  if (community) params.set('community', community);
  const res = await fetch(`${API}/api/system?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchInterfaces(host?: string, community?: string) {
  const params = new URLSearchParams();
  if (host) params.set('host', host);
  if (community) params.set('community', community);
  const res = await fetch(`${API}/api/interfaces?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

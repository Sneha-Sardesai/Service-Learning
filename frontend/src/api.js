const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error('Cannot reach the backend. Start the Express API and check its URL.');
  }
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

export async function upload(path, file, { mappings, sheet, resolutions } = {}) {
  const params = new URLSearchParams({ filename: file.name });
  if (sheet) params.set('sheet', sheet);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(mappings ? { 'X-Import-Mappings': JSON.stringify(mappings) } : {}),
        ...(resolutions ? { 'X-Import-Resolutions': JSON.stringify(resolutions) } : {}),
      },
      body: file,
    });
  } catch {
    throw new Error('Cannot reach the backend. Start the Express API and check its URL.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

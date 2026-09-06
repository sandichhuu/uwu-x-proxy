// Never expose raw upstream HTML, OAuth codes or token bodies in diagnostics.
export async function oauthJson(response, stage) {
  let data;
  try { data = await response.json(); }
  catch { throw Object.assign(new Error(`${stage} returned a non-JSON response (HTTP ${response.status}). Check network/proxy interception or upstream availability.`), { status: 502, publicMessage: true }); }
  if (!response.ok) throw Object.assign(new Error(`${stage} failed (HTTP ${response.status}). Retry sign-in; check OAuth configuration if this persists.`), { status: 502, publicMessage: true });
  return data;
}

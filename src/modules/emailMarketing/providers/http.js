'use strict';

/**
 * HTTP for the email-marketing providers: a timeout, no redirects, and the
 * README's error codes. Credentials never go into a message.
 */

function err(code, status, message) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function call(method, url, { headers = {}, body, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw err('EMAIL_MARKETING_UNAVAILABLE', 502, `The service could not be reached (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
  }
  let json = null;
  try {
    json = res.status === 204 ? {} : await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401 || res.status === 403) throw err('EMAIL_MARKETING_INVALID_CREDENTIALS', 422, 'The service refused the API key');
  if (res.status === 404) throw err('EMAIL_MARKETING_LIST_NOT_FOUND', 404, 'That list was not found');
  if (res.status === 400 || res.status === 422) {
    const reason = json && (json.detail || json.title || (json.errors && json.errors[0] && json.errors[0].detail));
    throw err('EMAIL_MARKETING_REJECTED', 409, `The service refused it: ${String(reason || res.status).slice(0, 300)}`);
  }
  if (!res.ok) throw err('EMAIL_MARKETING_UNAVAILABLE', 502, `The service answered ${res.status}`);
  return json;
}

module.exports = { call, err };

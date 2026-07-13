// fetch-source.mjs
// Resolves a source_url into raw code text. Supports GitHub (blob or raw),
// GitLab (blob or raw), Bitbucket, and any direct raw-text URL as a fallback.

const MAX_SOURCE_BYTES = 200000;

function normalizeSourceUrl(sourceUrl) {
  const githubBlob = sourceUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/
  );
  if (githubBlob) {
    const [, owner, repo, path] = githubBlob;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`;
  }

  if (sourceUrl.startsWith('https://raw.githubusercontent.com/')) {
    return sourceUrl;
  }

  const gitlabBlob = sourceUrl.match(
    /^https:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/blob\/(.+)$/
  );
  if (gitlabBlob) {
    const [, owner, repo, path] = gitlabBlob;
    return `https://gitlab.com/${owner}/${repo}/-/raw/${path}`;
  }

  const bitbucketSrc = sourceUrl.match(
    /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/src\/(.+)$/
  );
  if (bitbucketSrc) {
    const [, owner, repo, path] = bitbucketSrc;
    return `https://bitbucket.org/${owner}/${repo}/raw/${path}`;
  }

  return sourceUrl;
}

export async function fetchSource(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return { ok: false, error: 'source_url must be a non-empty string.' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return { ok: false, error: `Malformed URL: ${sourceUrl}` };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'Only https:// URLs are supported.' };
  }

  const fetchUrl = normalizeSourceUrl(sourceUrl);

  let res;
  try {
    res = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'contract-auditor-asp/1.0' },
    });
  } catch (err) {
    return { ok: false, error: `Network error fetching source: ${err.message}` };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `Failed to fetch source (HTTP ${res.status}): ${fetchUrl}`,
    };
  }

  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      error: `Source file too large (${contentLengthHeader} bytes). Limit is ${MAX_SOURCE_BYTES} bytes.`,
    };
  }

  const text = await res.text();

  if (!text || text.trim().length === 0) {
    return { ok: false, error: 'Fetched source is empty.' };
  }
  if (text.length > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      error: `Source file too large (${text.length} bytes). Limit is ${MAX_SOURCE_BYTES} bytes.`,
    };
  }

  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    return {
      ok: false,
      error: 'Fetched content looks like an HTML page, not source code. The URL may require authentication or point to a private repo.',
    };
  }

  return { ok: true, code: text, resolved_url: fetchUrl };
}

export function inferLanguageFromUrl(sourceUrl) {
  const lower = sourceUrl.toLowerCase();
  if (lower.endsWith('.sol')) return 'solidity';
  if (lower.endsWith('.move')) return 'move';
  return null;
}

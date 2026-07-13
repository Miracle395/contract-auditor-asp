// server.mjs
// HTTP server for the Contract Auditor ASP. Plain Node http module, no framework,
// no bundler - matches the mobile/Codespaces-friendly, CDN-only workflow.

import { createServer } from 'http';
import { auditCode } from './audit-engine.mjs';
import { fetchSource, inferLanguageFromUrl } from './fetch-source.mjs';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = 60000;

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

function readBody(req, maxBytes = 500000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleAudit(req, res) {
  const timeout = setTimeout(() => {
    if (!res.writableEnded) {
      sendJson(res, 504, {
        status: 'error',
        error_code: 'timeout',
        message: 'Audit took too long to complete.',
      });
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const raw = await readBody(req);

    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      clearTimeout(timeout);
      return sendJson(res, 400, {
        status: 'error',
        error_code: 'invalid_input',
        message: 'Request body must be valid JSON.',
      });
    }

    const { language, code, source_url, context } = input;

    if (!code && !source_url) {
      clearTimeout(timeout);
      return sendJson(res, 400, {
        status: 'error',
        error_code: 'invalid_input',
        message: 'Provide either "code" or "source_url".',
      });
    }
    if (code && source_url) {
      clearTimeout(timeout);
      return sendJson(res, 400, {
        status: 'error',
        error_code: 'invalid_input',
        message: 'Provide only one of "code" or "source_url", not both.',
      });
    }

    let resolvedCode = code;
    let resolvedLanguage = language;

    if (source_url) {
      const fetched = await fetchSource(source_url);
      if (!fetched.ok) {
        clearTimeout(timeout);
        return sendJson(res, 422, {
          status: 'error',
          error_code: 'fetch_failed',
          message: fetched.error,
        });
      }
      resolvedCode = fetched.code;
      if (!resolvedLanguage) {
        resolvedLanguage = inferLanguageFromUrl(source_url);
      }
    }

    if (!resolvedLanguage) {
      clearTimeout(timeout);
      return sendJson(res, 400, {
        status: 'error',
        error_code: 'invalid_input',
        message: 'Could not determine language. Specify "language": "solidity" | "move".',
      });
    }
    if (!['solidity', 'move'].includes(resolvedLanguage)) {
      clearTimeout(timeout);
      return sendJson(res, 400, {
        status: 'error',
        error_code: 'unsupported_language',
        message: `Unsupported language: ${resolvedLanguage}. Supported: solidity, move.`,
      });
    }

    const result = await auditCode({ language: resolvedLanguage, code: resolvedCode });
    clearTimeout(timeout);
    const statusCode = result.status === 'ok' ? 200 : 500;
    return sendJson(res, statusCode, result);
  } catch (err) {
    clearTimeout(timeout);
    if (!res.writableEnded) {
      return sendJson(res, 500, {
        status: 'error',
        error_code: 'internal_error',
        message: err.message,
      });
    }
  }
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/audit') {
    return handleAudit(req, res);
  }
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'contract-auditor-asp',
      supported_languages: ['solidity', 'move'],
    });
  }
  sendJson(res, 404, { status: 'error', error_code: 'not_found', message: 'Unknown route. Use POST /audit or GET /health.' });
});

server.listen(PORT, () => {
  console.log(`Contract Auditor ASP listening on port ${PORT}`);
  console.log(`Health check: GET http://localhost:${PORT}/health`);
  console.log(`Audit endpoint: POST http://localhost:${PORT}/audit`);
});

// server.mjs
// HTTP server for the Contract Auditor ASP. Plain Node http module, no framework,
// no bundler - matches the mobile/Codespaces-friendly, CDN-only workflow.

import { createServer } from 'http';
import { auditCode } from './audit-engine.mjs';
import { fetchSource, inferLanguageFromUrl } from './fetch-source.mjs';
import { getPaymentRequirements, buildX402Challenge, decodePaymentHeader, verifyPayment, settlePayment } from './x402.mjs';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = 60000;

function sendJson(res, statusCode, obj, extraHeaders = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
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
  // Log full request details for debugging
  console.log('[x402] Request received:', {
    method: req.method,
    url: req.url,
    headers: Object.keys(req.headers),
    hasPayment: !!req.headers['x-payment'],
  });

  const resourceUrl = `https://${req.headers.host}/audit`;
  const paymentRequirements = getPaymentRequirements(resourceUrl);
  const paymentHeader = req.headers['x-payment'];

  if (!paymentHeader) {
    const challenge = buildX402Challenge(resourceUrl);
    const challengeB64 = Buffer.from(JSON.stringify(challenge)).toString('base64');
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': challengeB64,
    });
    res.end(JSON.stringify(challenge, null, 2));
    return;
  }

  const paymentPayload = decodePaymentHeader(paymentHeader);
  if (!paymentPayload) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'error',
      error_code: 'invalid_payment',
      message: 'X-PAYMENT header could not be decoded.',
    }, null, 2));
    return;
  }

  console.log('[x402] Payment received:', {
    payer: paymentPayload.payer || paymentPayload.from,
    amount: paymentPayload.amount,
    allPayloadKeys: Object.keys(paymentPayload)
  });

  console.log('[x402] Verifying payment...');
  const verifyResult = await verifyPayment(paymentPayload, paymentRequirements);
  console.log('[x402] Verify result:', { success: verifyResult?.data?.success, code: verifyResult?.code });
  if (!verifyResult?.data?.success) {
    console.error('[x402] Payment verification failed:', JSON.stringify(verifyResult, null, 2));
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'error',
      error_code: 'payment_verification_failed',
      message: verifyResult?.data?.errorMessage || 'Payment verification failed.',
      debug: process.env.NODE_ENV === 'development' ? verifyResult : undefined,
    }, null, 2));
    return;
  }

  const settleResult = await settlePayment(paymentPayload, paymentRequirements);
  if (!settleResult?.data?.success) {
    console.error('[x402] Payment settlement failed:', JSON.stringify(settleResult, null, 2));
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'error',
      error_code: 'payment_settlement_failed',
      message: settleResult?.data?.errorMessage || 'Payment settlement failed.',
      debug: process.env.NODE_ENV === 'development' ? settleResult : undefined,
    }, null, 2));
    return;
  }

  // Build PAYMENT-RESPONSE header with settlement receipt per x402 v2 standard
  const paymentResponse = {
    status: 'success',
    amount: paymentRequirements.amount,
    asset: paymentRequirements.asset,
    network: paymentRequirements.network,
    payTo: paymentRequirements.payTo,
    payer: paymentPayload.payer || paymentPayload.from,
    transaction: settleResult.data?.transactionHash || settleResult.data?.txHash,
    timestamp: new Date().toISOString(),
  };
  const paymentResponseB64 = Buffer.from(JSON.stringify(paymentResponse)).toString('base64');

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
    console.log('[x402] Request body length:', raw.length, 'bytes');

    let input;
    try {
      input = raw ? JSON.parse(raw) : {};
      console.log('[x402] Parsed input fields:', Object.keys(input));
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
    return sendJson(res, statusCode, result, { 'PAYMENT-RESPONSE': paymentResponseB64 });
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
  if (req.url === '/audit' && (req.method === 'POST' || req.method === 'GET')) {
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

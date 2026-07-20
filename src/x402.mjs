// x402.mjs
// Handles x402 payment gating for the Contract Auditor ASP /audit endpoint,
// using OKX Onchain OS as the facilitator (verify + settle).

import crypto from 'crypto';

const OKX_BASE_URL = 'https://web3.okx.com';
const PAY_TO_ADDRESS = '0xf1E2d92708B21d49878997BAad7BF60a26808e1b';
const NETWORK = 'eip155:196'; // X Layer
const ASSET_USDT = '0x779ded0c9e1022225f8e0630b35a9b54be713736'; // USDT on X Layer (6 decimals) - OKX AI task system address
const PRICE_USDT_BASE_UNITS = '100000'; // $0.10 USDT
const RESOURCE_DESCRIPTION = 'Smart contract security audit (Solidity/Move) - single call';

function sign(secretKey, timestamp, method, requestPath, body) {
  const prehash = timestamp + method + requestPath + body;
  return crypto.createHmac('sha256', secretKey).update(prehash).digest('base64');
}

function buildAuthHeaders(method, requestPath, bodyStr) {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error('Missing OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE env vars.');
  }

  const timestamp = new Date().toISOString();
  const sig = sign(secretKey, timestamp, method, requestPath, bodyStr);

  return {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sig,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'OK-ACCESS-TIMESTAMP': timestamp,
  };
}

export function getPaymentRequirements(resourceUrl) {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: PRICE_USDT_BASE_UNITS,
    asset: ASSET_USDT,
    payTo: PAY_TO_ADDRESS,
    maxTimeoutSeconds: 60,
    decimals: 6,
    extra: {
      name: 'USDT',
      version: '2',
    },
  };
}

export function buildX402Challenge(resourceUrl) {
  const paymentRequirements = getPaymentRequirements(resourceUrl);
  return {
    x402Version: 2,
    resource: resourceUrl,
    accepts: [paymentRequirements],
  };
}

export function decodePaymentHeader(headerValue) {
  try {
    const json = Buffer.from(headerValue, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function verifyPayment(paymentPayload, paymentRequirements) {
  const requestPath = '/api/v6/pay/x402/verify';
  const body = { x402Version: 2, paymentPayload, paymentRequirements };
  const bodyStr = JSON.stringify(body);
  const headers = buildAuthHeaders('POST', requestPath, bodyStr);

  const res = await fetch(OKX_BASE_URL + requestPath, { method: 'POST', headers, body: bodyStr });
  return res.json();
}

export async function settlePayment(paymentPayload, paymentRequirements) {
  const requestPath = '/api/v6/pay/x402/settle';
  const body = { x402Version: 2, paymentPayload, paymentRequirements };
  const bodyStr = JSON.stringify(body);
  const headers = buildAuthHeaders('POST', requestPath, bodyStr);

  const res = await fetch(OKX_BASE_URL + requestPath, { method: 'POST', headers, body: bodyStr });
  return res.json();
}

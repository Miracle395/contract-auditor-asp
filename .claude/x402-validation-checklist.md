# x402 Standard Validation Checklist

OKX's x402 standard validation tests the **complete payment flow**, not just the initial 402 challenge. Here's what was missing and what's required:

## ✅ Initial 402 Challenge (Working)

- [x] HTTP 402 status code
- [x] `PAYMENT-REQUIRED` header with base64-encoded JSON challenge
- [x] Response body contains the same challenge (decoded)
- [x] Challenge structure:
  ```json
  {
    "x402Version": 2,
    "resource": "https://...",
    "accepts": [{
      "scheme": "exact",
      "network": "eip155:196",
      "amount": "100000",
      "asset": "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
      "payTo": "0x...",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    }]
  }
  ```

## ✅ Payment Verification & Settlement (Working)

- [x] Accept `X-PAYMENT` header (base64-encoded payment payload)
- [x] Decode payment payload
- [x] Call OKX `/api/v6/pay/x402/verify` with facilitator authentication
- [x] Call OKX `/api/v6/pay/x402/settle` on successful verification
- [x] Check `data.success` in verify/settle responses

## ✅ **SUCCESS RESPONSE (CRITICAL - WAS MISSING)**

When payment is verified and settled, the HTTP 200 response **MUST** include:

### Required Header: `PAYMENT-RESPONSE`

Base64-encoded JSON containing the settlement receipt:

```json
{
  "status": "success",
  "amount": "100000",
  "asset": "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
  "network": "eip155:196",
  "payTo": "0x...",
  "payer": "0x...",
  "transaction": "0x...",
  "timestamp": "2026-07-19T17:20:13.000Z"
}
```

**This was the missing piece causing validation failure.**

## Facilitator Authentication

All OKX API calls require these headers:

```javascript
{
  'Content-Type': 'application/json',
  'OK-ACCESS-KEY': process.env.OKX_API_KEY,
  'OK-ACCESS-SIGN': hmac_sha256(secretKey, timestamp + method + path + body),
  'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE,
  'OK-ACCESS-TIMESTAMP': new Date().toISOString()
}
```

## Common Validation Failure Reasons

1. **No PAYMENT-RESPONSE header on success** ← This was our issue
2. Missing or malformed PAYMENT-REQUIRED header
3. Incorrect x402Version (must be 2)
4. Resource URL must match the actual endpoint (use HTTPS)
5. Facilitator authentication fails (wrong API keys or signature)
6. Not calling both verify AND settle in sequence
7. Wrong response status codes (should be 200 on success, 402 on payment failure)

## Testing the Full Flow

1. **Initial request without payment:**
   ```bash
   curl -i https://your-endpoint.com/audit \
     -H "Content-Type: application/json" \
     -d '{"contract_address":"0x123"}'
   ```
   Expected: HTTP 402 with `PAYMENT-REQUIRED` header

2. **Request with valid X-PAYMENT header:**
   ```bash
   curl -i https://your-endpoint.com/audit \
     -H "Content-Type: application/json" \
     -H "X-PAYMENT: <base64_payment_payload>" \
     -d '{"contract_address":"0x123"}'
   ```
   Expected: HTTP 200 with `PAYMENT-RESPONSE` header + business response body

## OKX Validation Tests

OKX's validator likely performs:

1. GET/POST to endpoint without payment → expects 402 + PAYMENT-REQUIRED
2. Decode challenge and generate test payment
3. Replay request with X-PAYMENT header
4. Check for HTTP 200 + PAYMENT-RESPONSE header
5. Verify PAYMENT-RESPONSE decodes and contains expected fields
6. May also test timeout scenarios and error handling

## References

- x402 v2 spec: https://x402.org
- OKX Payment SDK: https://web3.okx.com/onchainos/dev-docs/okxai/howtokmcp
- OKX x402 endpoints: `/api/v6/pay/x402/verify` and `/api/v6/pay/x402/settle`

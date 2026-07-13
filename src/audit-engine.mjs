// audit-engine.mjs
// Core audit logic: takes { language, code } -> returns schema-conformant JSON.
// No mock data, no placeholder findings. Real analysis via Claude on Bedrock, grounded
// in taxonomy/*.json (real bug classes from actual shipped debugging history).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TAXONOMIES = {
  solidity: JSON.parse(readFileSync(join(__dirname, '../taxonomy/solidity.json'), 'utf-8')),
  move: JSON.parse(readFileSync(join(__dirname, '../taxonomy/move.json'), 'utf-8')),
};

const TAXONOMY_VERSION = '1.0.0';

function buildSystemPrompt(language) {
  const tax = TAXONOMIES[language];
  const categoryBlock = tax.categories
    .map(c => `### ${c.id} — ${c.name} (default severity: ${c.severity_default})\n` +
      c.patterns.map(p => `- ${p}`).join('\n'))
    .join('\n\n');

  return `You are a smart contract security auditor specialized in ${language}.

You audit against a specific taxonomy of failure classes drawn from real production
deployments and real debugging history — not generic textbook checklists. Prioritize
finding instances of THESE patterns, but you may also flag other genuine issues you
find with equal rigor.

TAXONOMY:

${categoryBlock}

RULES:
1. Only report findings that are ACTUALLY PRESENT in the submitted code. Never invent
   or force a finding to pad the report.
2. Every finding must cite the real line range from the submitted code.
3. description and fix_suggestion must reference the ACTUAL code found - quote variable
   names, function names, specific patterns - never generic boilerplate text.
4. Assign confidence honestly: "high" only if you are certain, "low" if it's a plausible
   but uncertain read.
5. If the code is clean of taxonomy issues, return an empty findings array. This is a
   valid and complete result.
6. Respond with ONLY valid JSON matching the schema below. No markdown fences, no preamble.

OUTPUT SCHEMA:
{
  "status": "ok",
  "language": "${language}",
  "summary": { "findings_count": number, "highest_severity": "critical"|"high"|"medium"|"low"|"none", "overall_risk": "critical"|"high"|"medium"|"low"|"clean" },
  "findings": [
    {
      "id": "taxonomy-id-or-custom",
      "category": "string",
      "severity": "critical"|"high"|"medium"|"low",
      "location": { "line_start": number, "line_end": number, "function": "string|null" },
      "description": "string",
      "rationale": "string",
      "fix_suggestion": "string",
      "confidence": "high"|"medium"|"low"
    }
  ]
}`;
}

export async function auditCode({ language, code }) {
  if (!TAXONOMIES[language]) {
    return {
      status: 'error',
      error_code: 'unsupported_language',
      message: `Unsupported language: ${language}. Supported: solidity, move.`,
    };
  }
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return {
      status: 'error',
      error_code: 'invalid_input',
      message: 'No source code provided.',
    };
  }

  const systemPrompt = buildSystemPrompt(language);
  const lineCount = code.split('\n').length;

  try {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');

    const region = process.env.AWS_REGION || 'us-east-1';
    const modelId = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-4-6-v1';

    const client = new BedrockRuntimeClient({ region });

    const requestBody = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Audit this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\`` },
      ],
    });

    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: requestBody,
    });

    const bedrockResponse = await client.send(command);
    const data = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'));

    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) {
      return { status: 'error', error_code: 'internal_error', message: 'No text response from model.' };
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return {
        status: 'error',
        error_code: 'internal_error',
        message: 'Model returned non-JSON output.',
      };
    }

    return {
      ...parsed,
      meta: {
        audited_at: new Date().toISOString(),
        lines_analyzed: lineCount,
        taxonomy_version: TAXONOMY_VERSION,
      },
    };
  } catch (err) {
    return {
      status: 'error',
      error_code: 'internal_error',
      message: err.message,
    };
  }
}

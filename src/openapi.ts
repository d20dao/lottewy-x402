import type { Env } from "./config";
const string = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});
const integer = (description: string, minimum: number, maximum: number) => ({
  type: "integer",
  description,
  minimum,
  maximum,
});
const hash = string(
  "A 32-byte Keccak-256 hash encoded as 0x-prefixed hexadecimal.",
  { pattern: "^0x[a-fA-F0-9]{64}$" },
);
export function openapi(env: Env) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Lottewy Agent Giveaway API",
      version: "0.1.0",
      description:
        "Create and pay for verifiable giveaway draws. Arc Testnet execution; test USDC payments through Circle Gateway.",
      contact: { email: env.SUPPORT_EMAIL },
      "x-guidance":
        "Call POST /v1/giveaways with the EVM owner address that will pay and a participant list, title, rules and winner counts. This prepares a client-held encrypted draft without charging or publishing it. Save draftToken and privateArchive securely. Pay POST /v1/roll with draftToken using an x402 client and a Gateway-funded testnet wallet; payment payer must match owner. The fixed price includes one draw and execution. A 200 response acknowledges the durable paid operation; poll the returned status URL until completed. Read the public proof JSON to independently replay selection and verify VRF evidence. Retry with the same draftToken; never make a new payment for an uncertain operation. Only test networks are accepted. The API uses an authorized service relayer and an upgradeable consumer; it does not hold or deliver giveaway prizes.",
    },
    servers: [
      {
        url: env.PUBLIC_ORIGIN,
        description: "Testnet API. No mainnet payments or mainnet draws.",
      },
    ],
    externalDocs: {
      url: `${env.PUBLIC_ORIGIN}/docs`,
      description: "Workflow, privacy, payment recovery and examples.",
    },
    paths: {
      "/health": {
        get: {
          operationId: "health",
          summary: "Read API readiness",
          responses: {
            "200": { description: "Service configuration and network." },
          },
        },
      },
      "/v1/giveaways": {
        post: {
          operationId: "prepareGiveaway",
          summary: "Prepare a private client-held giveaway draft",
          description:
            "No payment is taken here. Raw entries and salts are returned privately and are not persisted by the API.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["owner", "draft"],
                  properties: {
                    owner: string(
                      "EVM wallet that will pay through Circle Gateway and own the onchain draw.",
                      { pattern: "^0x[a-fA-F0-9]{40}$" },
                    ),
                    draft: {
                      $ref: "#/components/schemas/Draft",
                      description:
                        "Participant list and public giveaway rules.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Prepared draft, private archive, manifest commitment and roll instructions.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Prepared" },
                },
              },
            },
            "400": {
              description: "Invalid fields or locally blocked public wording.",
            },
            "429": {
              description: "Request limit exceeded; no payment was taken.",
            },
          },
        },
      },
      "/v1/roll": {
        post: {
          operationId: "payAndRoll",
          summary: "Pay once and queue the prepared giveaway draw",
          description:
            "Return 402 if unpaid. Validate and moderate the draft before settlement. On successful settlement, return the stable operation and status URL; completion is asynchronous. Replay uses the same draftToken and never charges for a second draw. Uncertain payment or draw submissions remain locked for reconciliation.",
          "x-payment-info": {
            price: { mode: "fixed", currency: "USDC", amount: env.PRICE_USDC },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["draftToken"],
                  properties: {
                    draftToken: string(
                      "Opaque encrypted draftToken returned by prepareGiveaway. Preserve exactly and reuse for retries; do not publish it.",
                    ),
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Payment recorded or an existing paid operation returned. Poll until completed.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Operation" },
                },
              },
            },
            "202": {
              description:
                "Payment reconciliation pending. Poll the original operation; do not authorize another payment.",
            },
            "402": {
              description:
                "Payment required or payment rejected. PAYMENT-REQUIRED contains the base64 x402 v2 accepts array.",
              headers: {
                "PAYMENT-REQUIRED": {
                  description:
                    "Base64-encoded x402 v2 payment requirements with supported testnet networks.",
                  schema: { type: "string" },
                },
              },
            },
            "409": {
              description:
                "Operation already exists or execution capacity changed. Check status before retrying.",
            },
            "422": {
              description:
                "Public content review rejected the request before payment capture.",
            },
            "429": {
              description: "Review quota exceeded before payment capture.",
            },
            "503": {
              description:
                "Dependency unavailable or payment status uncertain. Follow the response code and status URL.",
            },
          },
        },
      },
      "/v1/giveaways/{id}": {
        get: {
          operationId: "getGiveaway",
          summary: "Read a public paid operation and its result",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              description: "Giveaway UUID returned when preparing the draft.",
              schema: string("Giveaway UUID", { format: "uuid" }),
            },
          ],
          responses: {
            "200": {
              description: "Operation, public manifest and result if complete.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Operation" },
                },
              },
            },
            "404": { description: "No paid operation exists for this ID." },
          },
        },
      },
      "/v1/giveaways/{id}/proof": {
        get: {
          operationId: "downloadProof",
          summary: "Download an independently verified public proof bundle",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              description: "Completed giveaway UUID.",
              schema: string("Giveaway UUID", { format: "uuid" }),
            },
          ],
          responses: {
            "200": {
              description:
                "Public manifest, hashes, selected order, VRF packet and transaction references. No raw entries or salts.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    description:
                      "Versioned lottewy-proof-bundle-v1 JSON document.",
                  },
                },
              },
            },
            "409": { description: "Draw not complete." },
            "503": {
              description:
                "Onchain proof could not be verified; no unchecked proof is returned.",
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Draft: {
          type: "object",
          description:
            "Normalized giveaway inputs. Only title, description and rules go to content review.",
          additionalProperties: false,
          required: ["title", "rules", "entries", "winners"],
          properties: {
            title: string("Public giveaway title.", {
              minLength: 3,
              maxLength: 120,
            }),
            description: string(
              "Optional public description; omit for an empty description.",
              { maxLength: 4000, default: "" },
            ),
            rules: string(
              "Public eligibility, selection and prize-delivery rules. Entry must be free.",
              { minLength: 5, maxLength: 4000 },
            ),
            entries: {
              type: "array",
              description:
                "Unique participant values, in original order. Each value is at most 256 UTF-8 bytes; addresses remain public, other values are masked.",
              minItems: 2,
              maxItems: 10000,
              items: string(
                "One participant name, username, email address or wallet address.",
              ),
            },
            winners: integer("Number of unique winners.", 1, 100),
            reserves: {
              ...integer("Number of ordered alternates after winners.", 0, 100),
              default: 0,
            },
            weights: {
              type: "array",
              description:
                "Optional positive integer weights in entry order. Same length as entries; selecting an entry removes its whole weight.",
              minItems: 2,
              maxItems: 10000,
              items: integer(
                "Relative weight for the corresponding entry.",
                1,
                1000,
              ),
            },
          },
        },
        Prepared: {
          type: "object",
          description:
            "Client-held draft; not yet a paid or published giveaway.",
          properties: {
            id: string("Stable giveaway UUID.", { format: "uuid" }),
            status: string("Always prepared."),
            draftToken: string(
              "Encrypted draft that must be preserved for payment and retries.",
            ),
            commitment: hash,
            manifest: {
              type: "object",
              description: "Public masked manifest that the commitment hashes.",
            },
            privateArchive: {
              type: "object",
              description:
                "Raw entries and salts for the creator to keep privately. Never publish this archive.",
            },
            expiresAt: integer(
              "Unix expiry timestamp for initiating payment.",
              0,
              9999999999,
            ),
            price: {
              type: "object",
              description: "Fixed total price in test USDC.",
              properties: {
                amount: string("Decimal USDC amount."),
                currency: string("USDC."),
              },
            },
            next: {
              type: "object",
              description: "Paid method and endpoint.",
              properties: {
                method: string("POST."),
                url: string("Absolute HTTPS roll endpoint.", { format: "uri" }),
              },
            },
          },
        },
        Operation: {
          type: "object",
          description:
            "Durable operation. Payment settlement and randomness fulfillment are distinct stages.",
          properties: {
            id: string("Stable giveaway UUID."),
            status: string(
              "settling, payment_uncertain, manual_review, payment_failed, paid, submitting, waiting, callback, completed, expired or refund_due.",
            ),
            payment: {
              type: "object",
              description:
                "Public payment summary without the signed authorization.",
            },
            giveaway: {
              type: "object",
              description:
                "Public masked giveaway manifest and finalized onchain evidence when available.",
            },
            result: {
              type: "object",
              description:
                "Ordered winner and alternate entry IDs after completion.",
            },
            links: {
              type: "object",
              description: "Status, proof and public-view URLs.",
            },
            errorCode: string("Machine-readable recovery condition, if any."),
          },
        },
      },
    },
  };
}

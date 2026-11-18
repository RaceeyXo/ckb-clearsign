/**
 * Optional: verify a recorded fixture against the live public testnet.
 * Skipped unless CLEARSIGN_LIVE=1 (run with `npm run test:live`).
 * Set CKB_RPC_URL to use your own node.
 */
import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { explainTransaction, verifyInputs } from "../src/index.js";
import { fixtureTx, loadAllFixtures } from "./fixtures.js";

const LIVE = process.env.CLEARSIGN_LIVE === "1";

describe.skipIf(!LIVE)("live testnet", () => {
  it("verifies a recorded xUDT transaction's inputs against the public RPC", async () => {
    const url = process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/";
    const client = new ccc.ClientPublicTestnet({ url, fallbacks: [url] });
    const f = loadAllFixtures().find((x) => x.hasXudt)!;
    const tx = fixtureTx(f);

    const verified = await verifyInputs(tx, client);
    expect(verified).toHaveLength(tx.inputs.length);
    const report = await explainTransaction(tx, verified, client);
    expect(report.inputDataVerified).toBe(true);
    expect(report.movements.some((m) => m.tokens.length > 0)).toBe(true);
  });
});

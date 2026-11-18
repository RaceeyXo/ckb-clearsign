import { ccc } from "@ckb-ccc/core";
import { describe, expect, it, vi } from "vitest";
import {
  ClearSignRejectedError,
  ClearSignSigner,
  InputVerificationError,
  type ClearSignReport,
} from "../src/index.js";
import { FixtureClient, fixtureTx, loadAllFixtures } from "./fixtures.js";

const fixtures = loadAllFixtures();
const CKB = 100_000_000n;
const PRIVATE_KEY = "0x" + "01".repeat(32);

/** A synthetic tx spending a cell owned by the private-key signer. */
async function ownedTx(client: FixtureClient, signer: ccc.Signer) {
  const { script: lock } = await signer.getRecommendedAddressObj();
  const other = ccc.Script.from({ ...lock, args: "0x" + "bb".repeat(20) });
  const originHash = client.addTransaction({
    outputs: [{ capacity: 1000n * CKB, lock }],
    outputsData: ["0x"],
  });
  return ccc.Transaction.from({
    inputs: [{ previousOutput: { txHash: originHash, index: 0 } }],
    outputs: [
      { capacity: 300n * CKB, lock: other },
      { capacity: 699n * CKB, lock },
    ],
    outputsData: ["0x", "0x"],
  });
}

describe("ClearSignSigner", () => {
  it("verifies, explains, confirms, then lets the wrapped signer sign", async () => {
    const client = new FixtureClient([]);
    const inner = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const confirm = vi.fn(async (_r: ClearSignReport) => true);
    const signer = new ClearSignSigner(inner, { confirm });

    const tx = await ownedTx(client, inner);
    const signed = await signer.signTransaction(tx);

    expect(confirm).toHaveBeenCalledOnce();
    const report = confirm.mock.calls[0]![0];
    expect(report.inputDataVerified).toBe(true);
    expect(report.chainStateVerified).toBe(false);
    expect(report.feeShannons).toBe(1n * CKB);

    // A real secp256k1 signature landed in witness 0, and the raw tx is unchanged.
    const witness = signed.getWitnessArgsAt(0);
    expect(witness?.lock).toBeDefined();
    expect(ccc.bytesFrom(witness!.lock!).length).toBe(65);
    const prepared = await inner.prepareTransaction(tx);
    expect(signed.hash()).toBe(prepared.hash());
    expect(signer.type).toBe(inner.type);
    expect(await signer.getInternalAddress()).toBe(await inner.getInternalAddress());
  });

  it("hands the wrapped signer verified input data, not indexer data", async () => {
    const client = new FixtureClient(fixtures);
    const inner = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const spy = vi.spyOn(inner, "signOnlyTransaction");
    const signer = new ClearSignSigner(inner, { confirm: () => true });
    const f = fixtures.find((x) => x.hasXudt)!;

    await signer.signOnlyTransaction(fixtureTx(f));
    const passed = spy.mock.calls[0]![0] as ccc.Transaction;
    for (const input of passed.inputs) {
      const origin = ccc.Transaction.from(
        f.origins[input.previousOutput.txHash] as ccc.TransactionLike,
      );
      expect(input.cellOutput!.eq(origin.outputs[Number(input.previousOutput.index)]!)).toBe(true);
      expect(input.outputData).toBe(origin.outputsData[Number(input.previousOutput.index)]);
    }
  });

  it("does not sign when the user declines", async () => {
    const client = new FixtureClient([]);
    const inner = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const spy = vi.spyOn(inner, "signOnlyTransaction");
    const signer = new ClearSignSigner(inner, { confirm: async () => false });

    const err = await signer.signTransaction(await ownedTx(client, inner)).catch((e) => e);
    expect(err).toBeInstanceOf(ClearSignRejectedError);
    expect(err.reason).toBe("USER_REJECTED");
    expect(err.report.feeShannons).toBe(1n * CKB);
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops before confirm when an input fails verification (lying RPC)", async () => {
    const f = fixtures[0]!;
    const client = new FixtureClient(fixtures, (_h, tx) => {
      tx.outputs.forEach((o) => (o.capacity += 1n));
      return tx;
    });
    const inner = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const spy = vi.spyOn(inner, "signOnlyTransaction");
    const confirm = vi.fn(() => true);
    const signer = new ClearSignSigner(inner, { confirm });

    await expect(signer.signOnlyTransaction(fixtureTx(f))).rejects.toBeInstanceOf(
      InputVerificationError,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("can verify through a separate client than the one the dApp/signer uses", async () => {
    const f = fixtures[0]!;
    const lying = new FixtureClient(fixtures, (_h, tx) => {
      tx.outputs.forEach((o) => (o.capacity += 1n));
      return tx;
    });
    const honest = new FixtureClient(fixtures);
    const inner = new ccc.SignerCkbPrivateKey(lying, PRIVATE_KEY);
    const signer = new ClearSignSigner(inner, { confirm: () => true, verifyClient: honest });
    await expect(signer.signOnlyTransaction(fixtureTx(f))).resolves.toBeInstanceOf(ccc.Transaction);
  });

  it("rejectUnrecognised refuses unknown type scripts before asking the user", async () => {
    const client = new FixtureClient(fixtures);
    const inner = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    const confirm = vi.fn(() => true);
    const signer = new ClearSignSigner(inner, { confirm, rejectUnrecognised: true });

    const withUnknown = fixtures.find((f) =>
      fixtureTx(f).outputs.some((o) => o.type),
    )!;
    const tx = fixtureTx(withUnknown);
    const report = (await new ClearSignSigner(inner, { confirm }).review(tx)).report;
    expect(report.unrecognisedTypeScripts.length).toBeGreaterThan(0);

    const err = await signer.signOnlyTransaction(tx).catch((e) => e);
    expect(err).toBeInstanceOf(ClearSignRejectedError);
    expect(err.reason).toBe("UNRECOGNISED_TYPE_SCRIPT");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("throws if the wrapped signer changes the transaction after confirmation", async () => {
    const client = new FixtureClient([]);
    const inner = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
    vi.spyOn(inner, "signOnlyTransaction").mockImplementation(async (txLike) => {
      const tx = ccc.Transaction.from(txLike).clone();
      tx.outputs[0]!.capacity += 1n; // e.g. a compromised signer redirecting funds
      return tx;
    });
    const signer = new ClearSignSigner(inner, { confirm: () => true });
    const err = await signer.signTransaction(await ownedTx(client, inner)).catch((e) => e);
    expect(err).toBeInstanceOf(ClearSignRejectedError);
    expect(err.reason).toBe("SIGNER_MODIFIED_TRANSACTION");
  });
});

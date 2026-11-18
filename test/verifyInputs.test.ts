import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { InputVerificationError, verifyInputs, withVerifiedInputs } from "../src/index.js";
import { FixtureClient, fixtureTx, loadAllFixtures, type Fixture } from "./fixtures.js";

const fixtures = loadAllFixtures();
const xudtFixture = fixtures.find((f) => f.hasXudt && fixtureTx(f).inputs.length > 2)!;

/** A lying client: serves the origin of `inputIndex` of fixture `f` mutated by `mutate`. */
function lyingClient(
  f: Fixture,
  inputIndex: number,
  mutate: (out: ccc.CellOutput, tx: ccc.Transaction, outIndex: number) => void,
): FixtureClient {
  const target = fixtureTx(f).inputs[inputIndex]!.previousOutput;
  return new FixtureClient(fixtures, (hash, tx) => {
    if (hash !== target.txHash) return tx;
    const i = Number(target.index);
    mutate(tx.outputs[i]!, tx, i);
    return tx;
  });
}

async function expectFailure(
  p: Promise<unknown>,
  reason: InputVerificationError["reason"],
  inputIndex?: number,
): Promise<InputVerificationError> {
  const err = await p.then(
    () => {
      throw new Error("expected verification to fail");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InputVerificationError);
  const e = err as InputVerificationError;
  expect(e.reason).toBe(reason);
  if (inputIndex !== undefined) expect(e.inputIndex).toBe(inputIndex);
  return e;
}

describe("verifyInputs — honest data", () => {
  it("has 5 fixtures, at least 2 with xUDT", () => {
    expect(fixtures).toHaveLength(5);
    expect(fixtures.filter((f) => f.hasXudt).length).toBeGreaterThanOrEqual(2);
  });

  for (const f of fixtures) {
    it(`verifies every input of ${f.hash.slice(0, 18)}…`, async () => {
      const client = new FixtureClient(fixtures);
      const tx = fixtureTx(f);
      const verified = await verifyInputs(tx, client);

      expect(verified).toHaveLength(tx.inputs.length);
      verified.forEach((v, i) => {
        const op = tx.inputs[i]!.previousOutput;
        expect(v.inputIndex).toBe(i);
        expect(v.outPoint.eq(op)).toBe(true);
        const origin = ccc.Transaction.from(f.origins[op.txHash] as ccc.TransactionLike);
        expect(origin.hash()).toBe(op.txHash);
        expect(v.cellOutput.eq(origin.outputs[Number(op.index)]!)).toBe(true);
        expect(v.outputData).toBe(origin.outputsData[Number(op.index)]);
      });
    });
  }

  it("fetches each distinct origin tx once and reuses a shared cache", async () => {
    const client = new FixtureClient(fixtures);
    const tx = fixtureTx(xudtFixture);
    const distinct = new Set(tx.inputs.map((i) => i.previousOutput.txHash)).size;
    expect(distinct).toBeLessThan(tx.inputs.length);

    const cache = new Map();
    await verifyInputs(tx, client, { cache });
    expect(client.calls).toBe(distinct);
    await verifyInputs(tx, client, { cache });
    expect(client.calls).toBe(distinct);
  });

  it("accepts pre-filled input data when it matches the verified data", async () => {
    const client = new FixtureClient(fixtures);
    const tx = fixtureTx(xudtFixture);
    const verified = await verifyInputs(tx, client);
    const filled = withVerifiedInputs(tx, verified);
    expect(filled.inputs.every((i) => i.cellOutput && i.outputData !== undefined)).toBe(true);
    await expect(verifyInputs(filled, client)).resolves.toHaveLength(tx.inputs.length);
  });
});

describe("verifyInputs — lying RPC", () => {
  const f = xudtFixture;
  const victim = 1; // an input whose origin we tamper with

  it("rejects tampered capacity", async () => {
    const client = lyingClient(f, victim, (o) => {
      o.capacity += 1_000_000_00000000n;
    });
    await expectFailure(verifyInputs(fixtureTx(f), client), "ORIGIN_TX_HASH_MISMATCH");
  });

  it("rejects a tampered lock script", async () => {
    const client = lyingClient(f, victim, (o) => {
      o.lock = ccc.Script.from({ ...o.lock, args: "0x" + "ab".repeat(20) });
    });
    await expectFailure(verifyInputs(fixtureTx(f), client), "ORIGIN_TX_HASH_MISMATCH");
  });

  it("rejects a tampered type script", async () => {
    const client = lyingClient(f, victim, (o) => {
      o.type = o.type
        ? undefined
        : ccc.Script.from({ codeHash: "0x" + "cd".repeat(32), hashType: "type", args: "0x" });
    });
    await expectFailure(verifyInputs(fixtureTx(f), client), "ORIGIN_TX_HASH_MISMATCH");
  });

  it("rejects tampered cell data", async () => {
    const client = lyingClient(f, victim, (_o, tx, i) => {
      tx.outputsData[i] = ccc.hexFrom(ccc.numLeToBytes(10n ** 30n, 16));
    });
    await expectFailure(verifyInputs(fixtureTx(f), client), "ORIGIN_TX_HASH_MISMATCH");
  });

  it("attributes the failure to the first input spending the tampered origin", async () => {
    const tx = fixtureTx(f);
    const target = tx.inputs[victim]!.previousOutput.txHash;
    const firstIdx = tx.inputs.findIndex((i) => i.previousOutput.txHash === target);
    const client = lyingClient(f, victim, (o) => {
      o.capacity += 1n;
    });
    await expectFailure(verifyInputs(tx, client), "ORIGIN_TX_HASH_MISMATCH", firstIdx);
  });

  it("rejects a different (real) transaction served under the requested hash", async () => {
    const other = fixtureTx(fixtures.find((x) => x !== f)!);
    const client = new FixtureClient(fixtures, () => other.clone());
    await expectFailure(verifyInputs(fixtureTx(f), client), "ORIGIN_TX_HASH_MISMATCH", 0);
  });

  it("rejects a wrong (out-of-range) output index", async () => {
    const client = new FixtureClient(fixtures);
    const tx = fixtureTx(f);
    const origin = await client.getTransaction(tx.inputs[victim]!.previousOutput.txHash);
    tx.inputs[victim]!.previousOutput.index = BigInt(origin!.transaction.outputs.length);
    await expectFailure(verifyInputs(tx, client), "OUTPUT_INDEX_OUT_OF_RANGE", victim);
  });

  it("rejects a missing origin transaction", async () => {
    const client = new FixtureClient(fixtures, () => undefined);
    await expectFailure(verifyInputs(fixtureTx(f), client), "ORIGIN_TX_NOT_FOUND", 0);
  });

  it("rejects a pre-filled cellOutput that disagrees with verified data", async () => {
    const client = new FixtureClient(fixtures);
    const tx = withVerifiedInputs(fixtureTx(f), await verifyInputs(fixtureTx(f), client));
    tx.inputs[victim]!.cellOutput!.capacity *= 10n; // what a lying indexer would show
    await expectFailure(verifyInputs(tx, client), "PREFILLED_CELL_OUTPUT_MISMATCH", victim);
  });

  it("rejects pre-filled outputData that disagrees with verified data", async () => {
    const client = new FixtureClient(fixtures);
    const tx = withVerifiedInputs(fixtureTx(f), await verifyInputs(fixtureTx(f), client));
    tx.inputs[victim]!.outputData = "0xdeadbeef";
    await expectFailure(verifyInputs(tx, client), "PREFILLED_OUTPUT_DATA_MISMATCH", victim);
  });

  it("does not put unverified transactions in the shared cache", async () => {
    const cache = new Map();
    const liar = lyingClient(f, victim, (o) => {
      o.capacity += 1n;
    });
    await expect(verifyInputs(fixtureTx(f), liar, { cache })).rejects.toThrow();
    for (const [hash, tx] of cache) expect(tx.hash()).toBe(hash);
    const bad = fixtureTx(f).inputs[victim]!.previousOutput.txHash;
    expect(cache.has(bad)).toBe(false);
  });
});

import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { explainTransaction, verifyInputs } from "../src/index.js";
import { FixtureClient, fixtureTx, loadAllFixtures } from "./fixtures.js";

const fixtures = loadAllFixtures();

const lockA = ccc.Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: "0x" + "aa".repeat(20),
});
const lockB = ccc.Script.from({ ...lockA, args: "0x" + "bb".repeat(20) });

async function xudtType(client: ccc.Client, args = "0x" + "11".repeat(32)): Promise<ccc.Script> {
  const info = await client.getKnownScript(ccc.KnownScript.XUdt);
  return ccc.Script.from({ codeHash: info.codeHash, hashType: info.hashType, args });
}

function amount(n: bigint, trailing = "0x"): ccc.Hex {
  return ccc.hexFrom(ccc.bytesConcat(ccc.numLeToBytes(n, 16), trailing));
}

const CKB = 100_000_000n;

/** Build origin + spending tx; the origin is served by the client under its real hash. */
function synthetic(
  client: FixtureClient,
  origin: { outputs: ccc.CellOutputLike[]; outputsData: ccc.HexLike[] },
  spend: { outputs: ccc.CellOutputLike[]; outputsData: ccc.HexLike[] },
): ccc.Transaction {
  const originHash = client.addTransaction(ccc.Transaction.from(origin));
  return ccc.Transaction.from({
    inputs: origin.outputs.map((_, index) => ({ previousOutput: { txHash: originHash, index } })),
    ...spend,
  });
}

describe("explainTransaction — real testnet fixtures", () => {
  for (const f of fixtures) {
    it(`fee for ${f.hash.slice(0, 18)}… = verified inputs − outputs`, async () => {
      const client = new FixtureClient(fixtures);
      const tx = fixtureTx(f);
      const verified = await verifyInputs(tx, client);
      const report = await explainTransaction(tx, verified, client);

      const ins = verified.reduce((a, v) => a + v.cellOutput.capacity, 0n);
      const outs = tx.outputs.reduce((a, o) => a + o.capacity, 0n);
      expect(report.feeShannons).toBe(ins - outs);
      expect(report.feeShannons).toBeGreaterThan(0n);
      // Cross-check against CCC's own (indexer-trusting) fee on honest data.
      expect(report.feeShannons).toBe(await tx.getFee(client));

      // Per-address nets plus fee must balance to zero.
      const net = report.movements.reduce((a, m) => a + m.ckbNetShannons, 0n);
      expect(net + report.feeShannons).toBe(0n);

      expect(report.inputDataVerified).toBe(true);
      expect(report.chainStateVerified).toBe(false);
      expect(report.text).toContain("Input data verified: YES");
      expect(report.text).toContain("Chain state verified: NO");
    });
  }

  it("decodes the recorded xUDT transfers and conserves tokens", async () => {
    const client = new FixtureClient(fixtures);
    for (const f of fixtures.filter((x) => x.hasXudt)) {
      const tx = fixtureTx(f);
      const report = await explainTransaction(tx, await verifyInputs(tx, client), client);
      const tokens = report.movements.flatMap((m) => m.tokens);
      expect(tokens.length).toBeGreaterThan(0);

      // Independent recomputation from raw verified data.
      const verified = await verifyInputs(tx, client);
      const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
      const isX = (o: ccc.CellOutput) =>
        o.type?.codeHash === xudt.codeHash && o.type.hashType === xudt.hashType;
      const inSum = verified
        .filter((v) => isX(v.cellOutput))
        .reduce((a, v) => a + ccc.numLeFromBytes(ccc.bytesFrom(v.outputData).slice(0, 16)), 0n);
      const outSum = tx.outputs.reduce(
        (a, o, i) => (isX(o) ? a + ccc.numLeFromBytes(ccc.bytesFrom(tx.outputsData[i]!).slice(0, 16)) : a),
        0n,
      );
      expect(tokens.reduce((a, t) => a + t.sent, 0n)).toBe(inSum);
      expect(tokens.reduce((a, t) => a + t.received, 0n)).toBe(outSum);
      expect(tokens.reduce((a, t) => a + t.net, 0n)).toBe(outSum - inSum);
      if (inSum === outSum) expect(report.tokenSupplyChanges).toHaveLength(0);
    }
  });
});

describe("explainTransaction — synthetic transactions", () => {
  it("computes xUDT movements (u128 LE, first 16 bytes) and the fee", async () => {
    const client = new FixtureClient([]);
    const type = await xudtType(client);
    const tx = synthetic(
      client,
      {
        outputs: [
          { capacity: 200n * CKB, lock: lockA, type },
          { capacity: 1000n * CKB, lock: lockA },
        ],
        // Trailing bytes after the 16-byte amount must be ignored.
        outputsData: [amount(1_000_000n, "0xcafe"), "0x"],
      },
      {
        outputs: [
          { capacity: 143n * CKB, lock: lockB, type },
          { capacity: 143n * CKB, lock: lockA, type },
          { capacity: 913n * CKB, lock: lockA },
        ],
        outputsData: [amount(250_000n), amount(750_000n), "0x"],
      },
    );
    const report = await explainTransaction(tx, await verifyInputs(tx, client), client);

    expect(report.feeShannons).toBe(1200n * CKB - 1199n * CKB);
    const a = report.movements.find((m) => m.lock.eq(lockA))!;
    const b = report.movements.find((m) => m.lock.eq(lockB))!;
    expect(a.ckbSentShannons).toBe(1200n * CKB);
    expect(a.ckbReceivedShannons).toBe(1056n * CKB);
    expect(a.ckbNetShannons).toBe(-144n * CKB);
    expect(b.ckbNetShannons).toBe(143n * CKB);
    expect(a.tokens).toEqual([
      expect.objectContaining({ kind: "xUDT", sent: 1_000_000n, received: 750_000n, net: -250_000n }),
    ]);
    expect(b.tokens).toEqual([
      expect.objectContaining({ sent: 0n, received: 250_000n, net: 250_000n }),
    ]);
    expect(a.tokens[0]!.typeHash).toBe(type.hash());
    expect(report.tokenSupplyChanges).toHaveLength(0);
    expect(report.unrecognisedTypeScripts).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(a.address).toBe(ccc.Address.fromScript(lockA, client).toString());
    expect(report.text).toContain("Fee: 1 CKB");
    expect(report.text).toContain("sends 250000 units");
    expect(report.text).toContain("receives 250000 units");
  });

  it("keeps different xUDT tokens apart and reports mint/burn", async () => {
    const client = new FixtureClient([]);
    const t1 = await xudtType(client, "0x" + "11".repeat(32));
    const t2 = await xudtType(client, "0x" + "22".repeat(32));
    const tx = synthetic(
      client,
      {
        outputs: [{ capacity: 300n * CKB, lock: lockA, type: t1 }],
        outputsData: [amount(500n)],
      },
      {
        outputs: [
          { capacity: 150n * CKB, lock: lockA, type: t1 },
          { capacity: 149n * CKB, lock: lockB, type: t2 },
        ],
        outputsData: [amount(100n), amount(42n)],
      },
    );
    const report = await explainTransaction(tx, await verifyInputs(tx, client), client);
    const changes = new Map(report.tokenSupplyChanges.map((c) => [c.typeHash, c.change]));
    expect(changes.get(t1.hash())).toBe(-400n);
    expect(changes.get(t2.hash())).toBe(42n);
    expect(report.warnings.some((w) => w.includes("(burn)"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("(mint)"))).toBe(true);
  });

  it("flags unrecognised and known-but-undecoded type scripts instead of guessing", async () => {
    const client = new FixtureClient([]);
    const dao = await client.getKnownScript(ccc.KnownScript.NervosDao);
    const mystery = ccc.Script.from({ codeHash: "0x" + "ee".repeat(32), hashType: "data1", args: "0x" });
    const tx = synthetic(
      client,
      {
        outputs: [{ capacity: 500n * CKB, lock: lockA, type: mystery }],
        outputsData: ["0x1234"],
      },
      {
        outputs: [
          {
            capacity: 499n * CKB,
            lock: lockA,
            type: { codeHash: dao.codeHash, hashType: dao.hashType, args: "0x" },
          },
        ],
        outputsData: ["0x0000000000000000"],
      },
    );
    const report = await explainTransaction(tx, await verifyInputs(tx, client), client);
    expect(report.unrecognisedTypeScripts).toHaveLength(2);
    const [i0, o0] = report.unrecognisedTypeScripts;
    expect(i0).toMatchObject({ location: "input", index: 0, reason: "type script not recognised" });
    expect(i0!.knownName).toBeUndefined();
    expect(o0).toMatchObject({ location: "output", index: 0, knownName: "NervosDao" });
    expect(report.movements.every((m) => m.tokens.length === 0)).toBe(true);
    expect(report.text).toContain("NOT explained");
  });

  it("flags malformed xUDT data (< 16 bytes) rather than reading a bogus amount", async () => {
    const client = new FixtureClient([]);
    const type = await xudtType(client);
    const tx = synthetic(
      client,
      { outputs: [{ capacity: 200n * CKB, lock: lockA }], outputsData: ["0x"] },
      { outputs: [{ capacity: 199n * CKB, lock: lockB, type }], outputsData: ["0x01020304"] },
    );
    const report = await explainTransaction(tx, await verifyInputs(tx, client), client);
    expect(report.unrecognisedTypeScripts).toEqual([
      expect.objectContaining({ location: "output", index: 0, knownName: "XUdt" }),
    ]);
    expect(report.movements.flatMap((m) => m.tokens)).toHaveLength(0);
  });

  it("warns when outputs exceed inputs (negative fee)", async () => {
    const client = new FixtureClient([]);
    const tx = synthetic(
      client,
      { outputs: [{ capacity: 100n * CKB, lock: lockA }], outputsData: ["0x"] },
      { outputs: [{ capacity: 101n * CKB, lock: lockB }], outputsData: ["0x"] },
    );
    const report = await explainTransaction(tx, await verifyInputs(tx, client), client);
    expect(report.feeShannons).toBe(-1n * CKB);
    expect(report.warnings.some((w) => w.includes("Outputs exceed inputs"))).toBe(true);
  });

  it("refuses verified inputs that don't belong to the transaction", async () => {
    const client = new FixtureClient(fixtures);
    const [f1, f2] = fixtures;
    const verified = await verifyInputs(fixtureTx(f1!), client);
    await expect(explainTransaction(fixtureTx(f2!), verified, client)).rejects.toThrow(
      /call verifyInputs on this exact transaction/,
    );
  });

  it("explains from verified data, never from pre-filled input.cellOutput", async () => {
    const client = new FixtureClient([]);
    const tx = synthetic(
      client,
      { outputs: [{ capacity: 100n * CKB, lock: lockA }], outputsData: ["0x"] },
      { outputs: [{ capacity: 99n * CKB, lock: lockB }], outputsData: ["0x"] },
    );
    const verified = await verifyInputs(tx, client);
    // Indexer lies *after* verification ran: explanation must still use verified data.
    tx.inputs[0]!.cellOutput = ccc.CellOutput.from({ capacity: 5000n * CKB, lock: lockB });
    const report = await explainTransaction(tx, verified, client);
    expect(report.feeShannons).toBe(1n * CKB);
    expect(report.movements.find((m) => m.lock.eq(lockA))!.ckbSentShannons).toBe(100n * CKB);
  });
});

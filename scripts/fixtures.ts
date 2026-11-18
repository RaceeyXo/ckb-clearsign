/**
 * Record real CKB testnet transactions (plus every origin tx their inputs
 * spend) into test/fixtures so tests and the demo can run offline.
 *
 *   npm run fixtures                # pick 3 plain-CKB + 2 xUDT txs automatically
 *   npm run fixtures -- 0xabc… 0xdef…  # record specific tx hashes instead
 *
 * Every recorded tx is re-hashed locally before it is written, so a fixture
 * can never contain data that doesn't match its hash.
 */
import { ccc } from "@ckb-ccc/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture, FixtureIndex } from "../test/fixtures.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const WANT_PLAIN = 3;
const WANT_XUDT = 2;

const RPC = process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/";
const client = new ccc.ClientPublicTestnet({ url: RPC, fallbacks: [RPC, "https://testnet.ckbapp.dev/"] });

async function fetchVerified(hash: ccc.Hex): Promise<ccc.Transaction> {
  const res = await client.getTransaction(hash);
  if (!res) throw new Error(`tx ${hash} not found`);
  const tx = res.transaction;
  if (tx.hash() !== hash) throw new Error(`tx ${hash} re-hashes to ${tx.hash()} — refusing to record`);
  return tx;
}

function isCellbase(tx: ccc.Transaction): boolean {
  return tx.inputs.length === 1 && /^0x0{64}$/.test(tx.inputs[0]!.previousOutput.txHash);
}

async function record(hash: ccc.Hex, xudt: ccc.ScriptInfo): Promise<Fixture> {
  const tx = await fetchVerified(hash);
  const origins: Record<string, unknown> = {};
  for (const h of new Set(tx.inputs.map((i) => i.previousOutput.txHash))) {
    origins[h] = JSON.parse(ccc.stringify(await fetchVerified(h)));
  }
  const hasXudt = tx.outputs.some(
    (o) => o.type && o.type.codeHash === xudt.codeHash && o.type.hashType === xudt.hashType,
  );
  return {
    network: "testnet",
    hash,
    hasXudt,
    recordedAt: new Date().toISOString(),
    tx: JSON.parse(ccc.stringify(tx)),
    origins,
  };
}

async function findXudtTxs(xudt: ccc.ScriptInfo, want: number): Promise<ccc.Hex[]> {
  const found: ccc.Hex[] = [];
  for await (const t of client.findTransactions(
    {
      script: { codeHash: xudt.codeHash, hashType: xudt.hashType, args: "0x" },
      scriptType: "type",
      scriptSearchMode: "prefix",
      groupByTransaction: true,
    },
    "desc",
    50,
  )) {
    if (found.includes(t.txHash)) continue;
    const tx = await fetchVerified(t.txHash);
    if (isCellbase(tx) || tx.inputs.length > 12) continue;
    // Want a real transfer: xUDT on both an input and an output.
    const outHasXudt = tx.outputs.some(
      (o) => o.type?.codeHash === xudt.codeHash && o.type.hashType === xudt.hashType,
    );
    const inHasXudt = t.cells.some((c) => c.isInput);
    if (!outHasXudt || !inHasXudt) continue;
    found.push(t.txHash);
    if (found.length >= want) break;
  }
  return found;
}

async function findPlainTxs(want: number): Promise<ccc.Hex[]> {
  const found: ccc.Hex[] = [];
  const seenLocks = new Set<string>();
  let n = await client.getTip();
  for (let scanned = 0; found.length < want && scanned < 5000; scanned++, n--) {
    const block = await client.getBlockByNumber(n);
    for (const tx of block?.transactions ?? []) {
      if (isCellbase(tx) || tx.inputs.length > 8 || tx.outputs.length < 2) continue;
      if (tx.outputs.some((o) => o.type)) continue;
      // Skip repeats from the same bot/sender so fixtures stay varied.
      const lockKey = tx.outputs.map((o) => o.lock.hash()).sort().join();
      if (seenLocks.has(lockKey)) continue;
      seenLocks.add(lockKey);
      found.push(tx.hash());
      if (found.length >= want) break;
    }
  }
  return found;
}

async function main(): Promise<void> {
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  const args = process.argv.slice(2).filter((a) => a.startsWith("0x")) as ccc.Hex[];

  let hashes: ccc.Hex[];
  if (args.length > 0) {
    hashes = args;
  } else {
    console.log("Searching testnet for xUDT transfers…");
    const x = await findXudtTxs(xudt, WANT_XUDT);
    console.log("Searching recent blocks for plain CKB transfers…");
    const p = await findPlainTxs(WANT_PLAIN);
    hashes = [...p, ...x];
  }

  await mkdir(OUT_DIR, { recursive: true });
  const index: FixtureIndex = { network: "testnet", fixtures: [] };
  for (const hash of hashes) {
    const f = await record(hash, xudt);
    const file = `${hash}.json`;
    await writeFile(join(OUT_DIR, file), JSON.stringify(f, null, 2) + "\n");
    index.fixtures.push({ hash, file, hasXudt: f.hasXudt, origins: Object.keys(f.origins).length });
    console.log(`  recorded ${hash} (xUDT: ${f.hasXudt}, origin txs: ${Object.keys(f.origins).length})`);
  }
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${index.fixtures.length} fixtures to ${OUT_DIR}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

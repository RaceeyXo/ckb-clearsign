/**
 * CKB ClearSign demo: a lying RPC vs. verify-before-sign.
 *
 *   npm run demo -- <testnet tx hash>     # live public testnet
 *   npm run demo -- --offline [tx hash]   # recorded fixtures, no network
 *
 * The lying client is an ordinary ccc.ClientPublicTestnet whose
 * getTransaction() inflates the capacity of the cell the tx spends. CCC trusts
 * it; ClearSign re-hashes the origin tx and refuses.
 */
import { ccc } from "@ckb-ccc/core";
import {
  ClearSignSigner,
  InputVerificationError,
  type ClearSignReport,
} from "../src/index.js";
import { FixtureClient, fixtureTx, loadAllFixtures, loadIndex } from "../test/fixtures.js";

const INFLATE_BY = 10_000n * 100_000_000n; // +10,000 CKB

/** A public-testnet client that lies about one cell's capacity. */
export class LyingTestnetClient extends ccc.ClientPublicTestnet {
  constructor(
    private readonly victim: ccc.OutPoint,
    config?: ConstructorParameters<typeof ccc.ClientPublicTestnet>[0],
  ) {
    super(config);
  }

  override async getTransaction(
    txHashLike: ccc.HexLike,
  ): Promise<ccc.ClientTransactionResponse | undefined> {
    const res = await super.getTransaction(txHashLike);
    if (!res || ccc.hexFrom(txHashLike) !== this.victim.txHash) return res;
    const forged = res.clone();
    const out = forged.transaction.outputs[Number(this.victim.index)];
    if (out) out.capacity += INFLATE_BY;
    return forged; // note: the RPC still *claims* this is victim.txHash
  }
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const indent = (s: string) => s.replace(/^/gm, "    ");
const ckb = (n: bigint) => `${ccc.fixedPointToString(n, 8)} CKB`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  let hash = args.find((a) => a.startsWith("0x")) as ccc.Hex | undefined;

  let honest: ccc.Client;
  let lying: ccc.Client;
  let tx: ccc.Transaction;

  if (offline || !hash) {
    if (!hash) {
      hash = loadIndex().fixtures.find((f) => f.hasXudt)!.hash;
      console.log(`No tx hash given — using recorded fixture ${hash} offline.`);
      console.log(`(Run \`npm run demo -- <testnet tx hash>\` for the live version.)\n`);
    }
    const fixtures = loadAllFixtures();
    const f = fixtures.find((x) => x.hash === hash);
    if (!f) throw new Error(`no fixture for ${hash}; run without --offline`);
    tx = fixtureTx(f);
    const victim = tx.inputs[0]!.previousOutput;
    honest = new FixtureClient(fixtures);
    lying = new FixtureClient(fixtures, (h, t) => {
      if (h === victim.txHash) t.outputs[Number(victim.index)]!.capacity += INFLATE_BY;
      return t;
    });
  } else {
    const url = process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/";
    const config = { url, fallbacks: [url, "https://testnet.ckbapp.dev/"] };
    honest = new ccc.ClientPublicTestnet(config);
    const res = await honest.getTransaction(hash);
    if (!res) throw new Error(`tx ${hash} not found on testnet`);
    tx = ccc.Transaction.from(res.transaction).clone();
    if (tx.hash() !== hash) throw new Error(`RPC returned a tx that hashes to ${tx.hash()}`);
    if (tx.inputs.length === 0 || /^0x0{64}$/.test(tx.inputs[0]!.previousOutput.txHash)) {
      throw new Error("pick a non-cellbase transaction");
    }
    lying = new LyingTestnetClient(tx.inputs[0]!.previousOutput, config);
  }

  // Strip any input data so every client has to look it up itself.
  const bare = () => {
    const t = tx.clone();
    t.inputs.forEach((i) => {
      i.cellOutput = undefined;
      i.outputData = undefined;
    });
    return t;
  };
  const victim = tx.inputs[0]!.previousOutput;
  console.log(bold(`Transaction ${hash}`));
  console.log(`  ${tx.inputs.length} input(s), ${tx.outputs.length} output(s)`);
  console.log(`  Lying RPC will inflate input #0 (${victim.txHash.slice(0, 12)}…:${victim.index}) by ${ckb(INFLATE_BY)}\n`);

  // A throwaway key: the demo never broadcasts and this key owns none of the inputs.
  const keyFor = (client: ccc.Client) =>
    new ccc.SignerCkbPrivateKey(client, "0x" + "42".repeat(32));
  const shown: ClearSignReport[] = [];
  const confirm = async (r: ClearSignReport) => {
    shown.push(r);
    return true; // a wallet would show r.text and wait for the user here
  };

  let ok = true;

  // 1. Plain CCC with the lying RPC: the forged number goes straight through.
  console.log(bold("1. Plain CCC + lying RPC"));
  const naiveIn = await bare().getInputsCapacity(lying);
  const honestIn = await bare().getInputsCapacity(honest);
  const naiveFee = await bare().getFee(lying);
  console.log(`    inputs capacity reported: ${ckb(naiveIn)}  (truth: ${ckb(honestIn)})`);
  console.log(`    fee reported:             ${naiveFee < 0n ? "-" + ckb(-naiveFee) : ckb(naiveFee)}`);
  console.log(red(`    ✗ CCC accepted the forged cell — a wallet would show the user the wrong amounts.\n`));
  ok &&= naiveIn === honestIn + INFLATE_BY;

  // 2. ClearSign with the honest RPC.
  console.log(bold("2. ClearSignSigner + honest RPC"));
  try {
    await new ClearSignSigner(keyFor(honest), { confirm }).signOnlyTransaction(bare());
    console.log(green("    ✓ all inputs verified; report shown to user:"));
    console.log(indent(shown.at(-1)!.text) + "\n");
  } catch (e) {
    ok = false;
    console.log(red(`    unexpected failure: ${e instanceof Error ? e.message : String(e)}\n`));
  }

  // 3. ClearSign with the lying RPC.
  console.log(bold("3. ClearSignSigner + lying RPC"));
  const before = shown.length;
  try {
    await new ClearSignSigner(keyFor(lying), { confirm }).signOnlyTransaction(bare());
    ok = false;
    console.log(red("    ✗ lying RPC was NOT caught\n"));
  } catch (e) {
    if (e instanceof InputVerificationError) {
      console.log(green(`    ✓ caught before the user was asked anything (confirm calls: ${shown.length - before})`));
      console.log(`    ${e.name} inputIndex=${e.inputIndex} reason=${e.reason}`);
      console.log(`    ${e.message}\n`);
      ok &&= shown.length === before;
    } else throw e;
  }

  // 4. dApp pre-fills lies into input.cellOutput; wallet verifies via its own node.
  console.log(bold("4. dApp pre-fills forged input.cellOutput; wallet verifies via honest RPC"));
  const prefilled = bare();
  await prefilled.inputs[0]!.completeExtraInfos(lying); // the dApp's lying indexer fills it in
  try {
    await new ClearSignSigner(keyFor(lying), { confirm, verifyClient: honest }).signOnlyTransaction(prefilled);
    ok = false;
    console.log(red("    ✗ pre-filled lie was NOT caught\n"));
  } catch (e) {
    if (e instanceof InputVerificationError) {
      console.log(green(`    ✓ caught: reason=${e.reason} inputIndex=${e.inputIndex}\n`));
      ok &&= e.reason === "PREFILLED_CELL_OUTPUT_MISMATCH";
    } else throw e;
  }

  console.log(ok ? green(bold("Demo result: honest data passes, lies are caught.")) : red(bold("Demo result: UNEXPECTED")));
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);

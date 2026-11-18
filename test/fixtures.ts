import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** On-disk format written by scripts/fixtures.ts. */
export interface Fixture {
  network: "testnet";
  hash: ccc.Hex;
  hasXudt: boolean;
  recordedAt: string;
  /** The transaction under test, as `ccc.stringify` JSON. */
  tx: unknown;
  /** Every origin tx its inputs spend, keyed by hash. */
  origins: Record<string, unknown>;
}

export interface FixtureIndex {
  network: "testnet";
  fixtures: { hash: ccc.Hex; file: string; hasXudt: boolean; origins: number }[];
}

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadIndex(): FixtureIndex {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "index.json"), "utf8")) as FixtureIndex;
}

export function loadFixture(hash: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${hash}.json`), "utf8")) as Fixture;
}

export function loadAllFixtures(): Fixture[] {
  return loadIndex().fixtures.map((f) => loadFixture(f.hash));
}

export function fixtureTx(f: Fixture): ccc.Transaction {
  return ccc.Transaction.from(f.tx as ccc.TransactionLike);
}

/**
 * A testnet client that never touches the network for transactions: it
 * serves origin txs from recorded fixtures. Known-script info (xUDT etc.)
 * comes from CCC's built-in testnet table, which is also offline.
 *
 * `tamper` lets a test mutate a served transaction to simulate a lying RPC.
 */
export class FixtureClient extends ccc.ClientPublicTestnet {
  readonly txs = new Map<string, ccc.Transaction>();
  calls = 0;

  constructor(
    fixtures: Fixture[],
    private readonly tamper?: (hash: ccc.Hex, tx: ccc.Transaction) => ccc.Transaction | undefined,
  ) {
    super();
    for (const f of fixtures) {
      this.txs.set(f.hash, fixtureTx(f));
      for (const [h, t] of Object.entries(f.origins)) {
        this.txs.set(h, ccc.Transaction.from(t as ccc.TransactionLike));
      }
    }
  }

  /** Serve an extra (e.g. synthetic) transaction under its locally computed hash. */
  addTransaction(txLike: ccc.TransactionLike): ccc.Hex {
    const tx = ccc.Transaction.from(txLike);
    const hash = tx.hash();
    this.txs.set(hash, tx.clone());
    return hash;
  }

  override async getTransaction(
    txHashLike: ccc.HexLike,
  ): Promise<ccc.ClientTransactionResponse | undefined> {
    this.calls += 1;
    const hash = ccc.hexFrom(txHashLike);
    const stored = this.txs.get(hash);
    if (!stored) return undefined;
    const served = this.tamper ? this.tamper(hash, stored.clone()) : stored.clone();
    if (!served) return undefined;
    return ccc.ClientTransactionResponse.from({ transaction: served, status: "committed" });
  }
}

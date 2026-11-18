import { ccc } from "@ckb-ccc/core";
import { assertMatchesInputs, type VerifiedInput } from "./verifyInputs.js";

/** Movement of one xUDT token for one address. Amounts are raw integer units (decimals unknown). */
export interface TokenMovement {
  kind: "xUDT";
  /** The xUDT type script identifying the token. */
  typeScript: ccc.Script;
  /** `typeScript.hash()` — a stable identifier for the token. */
  typeHash: ccc.Hex;
  /** Units leaving this address (sum over verified input cells). */
  sent: bigint;
  /** Units arriving at this address (sum over output cells). */
  received: bigint;
  /** `received - sent`. Negative means the address loses tokens. */
  net: bigint;
}

/** Everything that happens to one lock script (address) in the transaction. */
export interface AddressMovement {
  address: string;
  lock: ccc.Script;
  /** Capacity of verified input cells locked by this address. */
  ckbSentShannons: bigint;
  /** Capacity of output cells locked by this address. */
  ckbReceivedShannons: bigint;
  /** `ckbReceivedShannons - ckbSentShannons`. */
  ckbNetShannons: bigint;
  tokens: TokenMovement[];
}

/** A type script ClearSign cannot decode. Its effect is NOT reflected in the explanation. */
export interface UnrecognisedTypeScript {
  location: "input" | "output";
  /** Index into `tx.inputs` or `tx.outputs`. */
  index: number;
  script: ccc.Script;
  /** If CCC knows this script by name (e.g. "NervosDao"), the name. ClearSign still does not decode it. */
  knownName?: string;
  reason: string;
}

/** Net change of a token's total supply inside this transaction (mint > 0, burn < 0). */
export interface TokenSupplyChange {
  typeScript: ccc.Script;
  typeHash: ccc.Hex;
  inputTotal: bigint;
  outputTotal: bigint;
  change: bigint;
}

export interface ClearSignReport {
  movements: AddressMovement[];
  /**
   * `sum(verified input capacity) - sum(output capacity)`. Negative values are
   * possible (e.g. Nervos DAO withdrawals add interest) and are flagged in
   * `warnings`; v0.1 does not decode DAO.
   */
  feeShannons: bigint;
  unrecognisedTypeScripts: UnrecognisedTypeScript[];
  /** Per-token mint/burn inside the tx (only tokens whose total changes). */
  tokenSupplyChanges: TokenSupplyChange[];
  /**
   * True: every input cell used for this report was taken from an origin
   * transaction whose hash ClearSign recomputed locally.
   */
  inputDataVerified: boolean;
  /**
   * Always false in v0.1: ClearSign does not prove the origin transactions are
   * committed on chain, nor that the input cells are still unspent.
   */
  chainStateVerified: boolean;
  warnings: string[];
  /** Plain-language explanation built only from the fields above. */
  text: string;
}

export interface ExplainOptions {
  /** CKB decimals for display. Default 8. */
  ckbDecimals?: number;
}

const XUDT_AMOUNT_BYTES = 16;

function scriptIdKey(s: Pick<ccc.Script, "codeHash" | "hashType">): string {
  return `${s.codeHash.toLowerCase()}:${s.hashType}`;
}

async function knownScriptNames(client: ccc.Client): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const name of Object.values(ccc.KnownScript)) {
    try {
      const info = await client.getKnownScript(name);
      names.set(scriptIdKey(info), name);
    } catch {
      // Not deployed on this network.
    }
  }
  return names;
}

function formatCkb(shannons: bigint, decimals: number): string {
  const abs = shannons < 0n ? -shannons : shannons;
  return `${ccc.fixedPointToString(abs, decimals)} CKB`;
}

function short(hex: string, head = 10, tail = 6): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function shortAddress(address: string): string {
  return short(address, 14, 8);
}

/**
 * Explain `txLike` in plain language, using ONLY the transaction's own outputs
 * and the `verified` input cells (from `verifyInputs`). Pre-filled
 * `input.cellOutput` / `input.outputData` are ignored.
 *
 * Scope (v0.1): CKB capacity and xUDT amounts. Every other type script is
 * listed in `unrecognisedTypeScripts` rather than guessed at.
 */
export async function explainTransaction(
  txLike: ccc.TransactionLike,
  verified: readonly VerifiedInput[],
  client: ccc.Client,
  options: ExplainOptions = {},
): Promise<ClearSignReport> {
  const tx = ccc.Transaction.from(txLike);
  assertMatchesInputs(tx, verified);
  const decimals = options.ckbDecimals ?? 8;

  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  const xudtKey = scriptIdKey(xudt);
  const names = await knownScriptNames(client);

  const warnings: string[] = [];
  const unrecognised: UnrecognisedTypeScript[] = [];
  const byLock = new Map<ccc.Hex, AddressMovement>();
  const supply = new Map<ccc.Hex, TokenSupplyChange>();

  const movementFor = (lock: ccc.Script): AddressMovement => {
    const key = lock.hash();
    let m = byLock.get(key);
    if (!m) {
      m = {
        address: ccc.Address.fromScript(lock, client).toString(),
        lock: lock.clone(),
        ckbSentShannons: 0n,
        ckbReceivedShannons: 0n,
        ckbNetShannons: 0n,
        tokens: [],
      };
      byLock.set(key, m);
    }
    return m;
  };

  const tokenFor = (m: AddressMovement, type: ccc.Script): TokenMovement => {
    const typeHash = type.hash();
    let t = m.tokens.find((x) => x.typeHash === typeHash);
    if (!t) {
      t = { kind: "xUDT", typeScript: type.clone(), typeHash, sent: 0n, received: 0n, net: 0n };
      m.tokens.push(t);
    }
    return t;
  };

  const visit = (
    location: "input" | "output",
    index: number,
    output: ccc.CellOutput,
    data: ccc.Hex,
  ): void => {
    const m = movementFor(output.lock);
    if (location === "input") m.ckbSentShannons += output.capacity;
    else m.ckbReceivedShannons += output.capacity;

    const type = output.type;
    if (!type) return;

    if (scriptIdKey(type) === xudtKey) {
      const bytes = ccc.bytesFrom(data);
      if (bytes.length < XUDT_AMOUNT_BYTES) {
        warnings.push(
          `${location} #${index} has an xUDT type script but only ${bytes.length} bytes of data (need ${XUDT_AMOUNT_BYTES}); its amount cannot be read.`,
        );
        unrecognised.push({
          location,
          index,
          script: type.clone(),
          knownName: "XUdt",
          reason: "malformed xUDT cell data (shorter than 16 bytes)",
        });
        return;
      }
      const amount = ccc.numLeFromBytes(bytes.slice(0, XUDT_AMOUNT_BYTES));
      const t = tokenFor(m, type);
      if (location === "input") t.sent += amount;
      else t.received += amount;

      const typeHash = type.hash();
      let s = supply.get(typeHash);
      if (!s) {
        s = { typeScript: type.clone(), typeHash, inputTotal: 0n, outputTotal: 0n, change: 0n };
        supply.set(typeHash, s);
      }
      if (location === "input") s.inputTotal += amount;
      else s.outputTotal += amount;
      return;
    }

    const knownName = names.get(scriptIdKey(type));
    unrecognised.push({
      location,
      index,
      script: type.clone(),
      ...(knownName ? { knownName } : {}),
      reason: knownName
        ? `${knownName} is not decoded by ClearSign v0.1`
        : "type script not recognised",
    });
  };

  verified.forEach((v) => visit("input", v.inputIndex, v.cellOutput, v.outputData));
  tx.outputs.forEach((o, i) => visit("output", i, o, ccc.hexFrom(tx.outputsData[i] ?? "0x")));

  if (tx.outputsData.length !== tx.outputs.length) {
    warnings.push(
      `outputsData has ${tx.outputsData.length} entries but there are ${tx.outputs.length} outputs; the node will reject this transaction.`,
    );
  }

  const movements = [...byLock.values()];
  for (const m of movements) {
    m.ckbNetShannons = m.ckbReceivedShannons - m.ckbSentShannons;
    for (const t of m.tokens) t.net = t.received - t.sent;
  }

  const inputCapacity = verified.reduce((acc, v) => acc + v.cellOutput.capacity, 0n);
  const outputCapacity = tx.outputs.reduce((acc, o) => acc + o.capacity, 0n);
  const feeShannons = inputCapacity - outputCapacity;
  if (feeShannons < 0n) {
    warnings.push(
      `Outputs exceed inputs by ${formatCkb(-feeShannons, decimals)}. This is only valid for special cases such as a Nervos DAO withdrawal, which ClearSign v0.1 does not decode.`,
    );
  }

  const tokenSupplyChanges = [...supply.values()]
    .map((s) => ({ ...s, change: s.outputTotal - s.inputTotal }))
    .filter((s) => s.change !== 0n);
  for (const s of tokenSupplyChanges) {
    warnings.push(
      `xUDT ${short(s.typeHash)} total ${s.change > 0n ? "increases" : "decreases"} by ${s.change > 0n ? s.change : -s.change} units in this transaction (${s.change > 0n ? "mint" : "burn"}).`,
    );
  }

  if (unrecognised.length > 0) {
    warnings.push(
      `${unrecognised.length} cell(s) carry type scripts ClearSign does not decode; their effects are NOT described here.`,
    );
  }

  const report: Omit<ClearSignReport, "text"> = {
    movements,
    feeShannons,
    unrecognisedTypeScripts: unrecognised,
    tokenSupplyChanges,
    inputDataVerified: true,
    chainStateVerified: false,
    warnings,
  };
  return { ...report, text: renderText(report, verified.length, decimals) };
}

function renderText(
  r: Omit<ClearSignReport, "text">,
  inputCount: number,
  decimals: number,
): string {
  const lines: string[] = [];
  lines.push("CKB ClearSign — transaction explanation");
  lines.push(
    r.inputDataVerified
      ? `  Input data verified: YES — all ${inputCount} input cell(s) were re-derived from origin transactions whose hashes were recomputed locally.`
      : "  Input data verified: NO",
  );
  lines.push(
    r.chainStateVerified
      ? "  Chain state verified: YES"
      : "  Chain state verified: NO — ClearSign v0.1 does not prove the origin transactions are on chain or that the inputs are unspent.",
  );
  lines.push("");

  for (const m of r.movements) {
    lines.push(`${shortAddress(m.address)}`);
    const net = m.ckbNetShannons;
    const verb =
      net < 0n ? `sends ${formatCkb(net, decimals)}` : net > 0n ? `receives ${formatCkb(net, decimals)}` : "no net CKB change";
    lines.push(
      `  CKB: ${verb} (spends ${formatCkb(m.ckbSentShannons, decimals)}, gets ${formatCkb(m.ckbReceivedShannons, decimals)})`,
    );
    for (const t of m.tokens) {
      const tverb =
        t.net < 0n ? `sends ${-t.net}` : t.net > 0n ? `receives ${t.net}` : "no net change";
      lines.push(
        `  xUDT ${short(t.typeHash)}: ${tverb} units (spends ${t.sent}, gets ${t.received}; raw units, decimals unknown)`,
      );
    }
  }
  lines.push("");
  lines.push(
    r.feeShannons >= 0n
      ? `Fee: ${formatCkb(r.feeShannons, decimals)} (inputs − outputs)`
      : `Fee: NEGATIVE (−${formatCkb(-r.feeShannons, decimals)}); see warnings`,
  );

  if (r.unrecognisedTypeScripts.length > 0) {
    lines.push("");
    lines.push("Unrecognised type scripts (NOT explained):");
    for (const u of r.unrecognisedTypeScripts) {
      lines.push(
        `  ${u.location} #${u.index}: code hash ${short(u.script.codeHash)} (${u.script.hashType})${u.knownName ? ` [${u.knownName}]` : ""} — ${u.reason}`,
      );
    }
  }
  if (r.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("");
  lines.push(
    "ClearSign describes asset movements. It does not predict what any contract will do with them.",
  );
  return lines.join("\n");
}

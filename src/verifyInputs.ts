import { ccc } from "@ckb-ccc/core";

/**
 * An input cell whose contents were derived from an origin transaction that
 * ClearSign fetched and re-hashed locally. Nothing in here comes from
 * `input.cellOutput` / `input.outputData` or from an indexer.
 */
export interface VerifiedInput {
  /** Position of this input in `tx.inputs`. */
  inputIndex: number;
  /** The out point being spent. */
  outPoint: ccc.OutPoint;
  /** `outputs[index]` of the verified origin transaction. */
  cellOutput: ccc.CellOutput;
  /** `outputsData[index]` of the verified origin transaction. */
  outputData: ccc.Hex;
}

export type InputVerificationReason =
  /** The client returned nothing for the origin tx hash. */
  | "ORIGIN_TX_NOT_FOUND"
  /** The client returned a tx whose locally computed hash is not the one requested. */
  | "ORIGIN_TX_HASH_MISMATCH"
  /** `previousOutput.index` points past the end of the verified origin tx's outputs. */
  | "OUTPUT_INDEX_OUT_OF_RANGE"
  /** The verified origin tx has no `outputsData` entry for that index. */
  | "OUTPUT_DATA_MISSING"
  /** `input.cellOutput` was pre-filled and differs from the verified output. */
  | "PREFILLED_CELL_OUTPUT_MISMATCH"
  /** `input.outputData` was pre-filled and differs from the verified data. */
  | "PREFILLED_OUTPUT_DATA_MISMATCH";

export class InputVerificationError extends Error {
  override readonly name = "InputVerificationError";

  constructor(
    public readonly inputIndex: number,
    public readonly reason: InputVerificationReason,
    detail?: string,
  ) {
    super(
      `Input #${inputIndex} failed verification (${reason})${detail ? `: ${detail}` : ""}`,
    );
  }
}

/**
 * Cache of origin transactions keyed by tx hash. Only transactions whose hash
 * was recomputed locally and matched the key are ever written into it, so it
 * is safe to share one cache across many `verifyInputs` calls.
 */
export type OriginTxCache = Map<ccc.Hex, ccc.Transaction>;

export interface VerifyInputsOptions {
  /** Share verified origin txs across calls. Defaults to a fresh per-call cache. */
  cache?: OriginTxCache;
}

/**
 * Fetch `txHash` through `client`, recompute its hash locally (blake2b over the
 * molecule-serialised raw transaction) and return it only if the hash matches.
 *
 * Returns either the verified transaction or a failure reason; it never throws
 * for verification failures so the caller can attribute them to an input.
 */
async function fetchVerifiedTx(
  client: ccc.Client,
  txHash: ccc.Hex,
  cache: OriginTxCache,
): Promise<
  | { ok: true; tx: ccc.Transaction }
  | { ok: false; reason: InputVerificationReason; detail: string }
> {
  const cached = cache.get(txHash);
  if (cached) return { ok: true, tx: cached };

  let response: ccc.ClientTransactionResponse | undefined;
  try {
    response = await client.getTransaction(txHash);
  } catch (err) {
    return {
      ok: false,
      reason: "ORIGIN_TX_NOT_FOUND",
      detail: `client.getTransaction(${txHash}) threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response) {
    return {
      ok: false,
      reason: "ORIGIN_TX_NOT_FOUND",
      detail: `client returned no transaction for ${txHash}`,
    };
  }

  // Work on our own deep copy so later mutation of the client's object (or of
  // its cache) cannot change what we verified.
  const tx = ccc.Transaction.from(response.transaction).clone();
  const computed = tx.hash();
  if (computed !== txHash) {
    return {
      ok: false,
      reason: "ORIGIN_TX_HASH_MISMATCH",
      detail: `requested ${txHash}, but the returned transaction hashes to ${computed}`,
    };
  }

  cache.set(txHash, tx);
  return { ok: true, tx };
}

/**
 * Independently verify every input of `txLike`.
 *
 * For each input, the transaction referenced by `previousOutput.txHash` is
 * fetched, re-serialised and re-hashed locally; if the hash differs the input
 * is rejected. The input cell is then taken from `outputs[index]` /
 * `outputsData[index]` of that verified transaction.
 *
 * `input.cellOutput` / `input.outputData` are never trusted. If they are
 * pre-filled and disagree with the verified data, verification fails.
 *
 * @throws {InputVerificationError} on the first input that fails (lowest index).
 */
export async function verifyInputs(
  txLike: ccc.TransactionLike,
  client: ccc.Client,
  options: VerifyInputsOptions = {},
): Promise<VerifiedInput[]> {
  const tx = ccc.Transaction.from(txLike);
  const cache: OriginTxCache = options.cache ?? new Map();

  // Fetch each distinct origin tx once, in parallel.
  const hashes = [...new Set(tx.inputs.map((i) => ccc.hexFrom(i.previousOutput.txHash)))];
  const fetched = new Map(
    await Promise.all(
      hashes.map(async (h) => [h, await fetchVerifiedTx(client, h, cache)] as const),
    ),
  );

  return tx.inputs.map((input, inputIndex): VerifiedInput => {
    const outPoint = input.previousOutput.clone();
    const result = fetched.get(ccc.hexFrom(outPoint.txHash));
    if (!result) {
      // Unreachable: every hash was fetched above.
      throw new InputVerificationError(inputIndex, "ORIGIN_TX_NOT_FOUND", "internal: not fetched");
    }
    if (!result.ok) {
      throw new InputVerificationError(inputIndex, result.reason, result.detail);
    }

    const origin = result.tx;
    const index = outPoint.index;
    if (index < 0n || index >= BigInt(origin.outputs.length)) {
      throw new InputVerificationError(
        inputIndex,
        "OUTPUT_INDEX_OUT_OF_RANGE",
        `origin tx ${outPoint.txHash} has ${origin.outputs.length} outputs, input spends index ${index}`,
      );
    }
    const i = Number(index);
    const verifiedOutput = origin.outputs[i];
    const verifiedData = origin.outputsData[i];
    if (verifiedOutput === undefined) {
      throw new InputVerificationError(inputIndex, "OUTPUT_INDEX_OUT_OF_RANGE");
    }
    if (verifiedData === undefined) {
      throw new InputVerificationError(
        inputIndex,
        "OUTPUT_DATA_MISSING",
        `origin tx ${outPoint.txHash} has no outputsData[${i}]`,
      );
    }

    if (input.cellOutput !== undefined && !input.cellOutput.eq(verifiedOutput)) {
      throw new InputVerificationError(
        inputIndex,
        "PREFILLED_CELL_OUTPUT_MISMATCH",
        `supplied cellOutput ${ccc.stringify(input.cellOutput)} != verified ${ccc.stringify(verifiedOutput)}`,
      );
    }
    if (
      input.outputData !== undefined &&
      ccc.hexFrom(input.outputData) !== ccc.hexFrom(verifiedData)
    ) {
      throw new InputVerificationError(
        inputIndex,
        "PREFILLED_OUTPUT_DATA_MISMATCH",
        `supplied outputData ${input.outputData} != verified ${verifiedData}`,
      );
    }

    return {
      inputIndex,
      outPoint,
      cellOutput: verifiedOutput.clone(),
      outputData: ccc.hexFrom(verifiedData),
    };
  });
}

/**
 * Return a copy of `txLike` whose `inputs[i].cellOutput` / `outputData` are
 * replaced with the verified values, so downstream code (e.g. a signer that
 * calls `completeExtraInfos`) uses verified data instead of re-querying an
 * indexer.
 */
export function withVerifiedInputs(
  txLike: ccc.TransactionLike,
  verified: readonly VerifiedInput[],
): ccc.Transaction {
  const tx = ccc.Transaction.from(txLike).clone();
  assertMatchesInputs(tx, verified);
  verified.forEach((v, i) => {
    const input = tx.inputs[i]!;
    input.cellOutput = v.cellOutput.clone();
    input.outputData = v.outputData;
  });
  return tx;
}

/** @internal Ensure `verified` lines up 1:1 with `tx.inputs`. */
export function assertMatchesInputs(
  tx: ccc.Transaction,
  verified: readonly VerifiedInput[],
): void {
  if (verified.length !== tx.inputs.length) {
    throw new Error(
      `verified inputs (${verified.length}) do not match tx inputs (${tx.inputs.length}); call verifyInputs on this exact transaction`,
    );
  }
  verified.forEach((v, i) => {
    if (v.inputIndex !== i || !v.outPoint.eq(tx.inputs[i]!.previousOutput)) {
      throw new Error(
        `verified input #${i} does not correspond to tx input #${i}; call verifyInputs on this exact transaction`,
      );
    }
  });
}

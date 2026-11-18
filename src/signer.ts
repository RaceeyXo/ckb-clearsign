import { ccc } from "@ckb-ccc/core";
import { explainTransaction, type ClearSignReport } from "./explain.js";
import {
  verifyInputs,
  withVerifiedInputs,
  type OriginTxCache,
} from "./verifyInputs.js";

export interface ClearSignSignerOptions {
  /**
   * Show the report to the user and resolve `true` to sign, `false` to refuse.
   * This is the wallet's confirmation screen.
   */
  confirm: (report: ClearSignReport) => Promise<boolean> | boolean;
  /** Refuse to sign (before calling `confirm`) if any type script is unrecognised. Default false. */
  rejectUnrecognised?: boolean;
  /**
   * Client used to fetch origin transactions. Defaults to the wrapped signer's
   * client. Any client works — data is re-hashed — but an independent node
   * reduces the chance of a denial-of-service by a lying RPC.
   */
  verifyClient?: ccc.Client;
  /** Share verified origin txs across signatures. */
  cache?: OriginTxCache;
}

export type ClearSignRejectionReason =
  | "USER_REJECTED"
  | "UNRECOGNISED_TYPE_SCRIPT"
  | "SIGNER_MODIFIED_TRANSACTION";

export class ClearSignRejectedError extends Error {
  override readonly name = "ClearSignRejectedError";

  constructor(
    public readonly reason: ClearSignRejectionReason,
    public readonly report: ClearSignReport,
    message?: string,
  ) {
    super(message ?? `ClearSign refused to sign: ${reason}`);
  }
}

/**
 * Wraps any `ccc.Signer`. Before the wrapped signer signs, it:
 *
 *  1. verifies every input against its re-hashed origin transaction
 *     (throws `InputVerificationError` on any mismatch),
 *  2. builds a plain-language report from verified data only,
 *  3. optionally refuses unrecognised type scripts,
 *  4. awaits `confirm(report)`,
 *  5. hands the wrapped signer a copy of the tx whose inputs carry the
 *     verified cell data, and checks the signed tx's hash is unchanged.
 *
 * `signTransaction` / `sendTransaction` go through `signOnlyTransaction`
 * (CCC's base `Signer` flow), so they are covered too.
 */
export class ClearSignSigner extends ccc.Signer {
  private readonly options: ClearSignSignerOptions;
  private readonly cache: OriginTxCache;

  constructor(
    public readonly inner: ccc.Signer,
    options: ClearSignSignerOptions,
  ) {
    super(inner.client);
    this.options = options;
    this.cache = options.cache ?? new Map();
  }

  get type(): ccc.SignerType {
    return this.inner.type;
  }

  get signType(): ccc.SignerSignType {
    return this.inner.signType;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }

  override disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  override onReplaced(listener: () => void): () => void {
    return this.inner.onReplaced(listener);
  }

  isConnected(): Promise<boolean> {
    return this.inner.isConnected();
  }

  getInternalAddress(): Promise<string> {
    return this.inner.getInternalAddress();
  }

  override getIdentity(): Promise<string> {
    return this.inner.getIdentity();
  }

  getAddressObjs(): Promise<ccc.Address[]> {
    return this.inner.getAddressObjs();
  }

  override getRecommendedAddressObj(preference?: unknown): Promise<ccc.Address> {
    return this.inner.getRecommendedAddressObj(preference);
  }

  override signMessageRaw(message: string | ccc.BytesLike): Promise<string> {
    return this.inner.signMessageRaw(message);
  }

  override verifyMessage(
    message: string | ccc.BytesLike,
    signature: string | ccc.Signature,
  ): Promise<boolean> {
    return this.inner.verifyMessage(message, signature);
  }

  override prepareTransaction(tx: ccc.TransactionLike): Promise<ccc.Transaction> {
    return this.inner.prepareTransaction(tx);
  }

  /** Verify, explain and confirm without signing. Useful for previews. */
  async review(txLike: ccc.TransactionLike): Promise<{
    report: ClearSignReport;
    verifiedTx: ccc.Transaction;
  }> {
    const tx = ccc.Transaction.from(txLike).clone();
    const client = this.options.verifyClient ?? this.client;
    const verified = await verifyInputs(tx, client, { cache: this.cache });
    const report = await explainTransaction(tx, verified, client);
    return { report, verifiedTx: withVerifiedInputs(tx, verified) };
  }

  override async signOnlyTransaction(txLike: ccc.TransactionLike): Promise<ccc.Transaction> {
    const { report, verifiedTx } = await this.review(txLike);

    if (this.options.rejectUnrecognised && report.unrecognisedTypeScripts.length > 0) {
      throw new ClearSignRejectedError(
        "UNRECOGNISED_TYPE_SCRIPT",
        report,
        `ClearSign refused to sign: ${report.unrecognisedTypeScripts.length} unrecognised type script(s)`,
      );
    }

    if (!(await this.options.confirm(report))) {
      throw new ClearSignRejectedError("USER_REJECTED", report);
    }

    const expectedHash = verifiedTx.hash();
    const signed = await this.inner.signOnlyTransaction(verifiedTx);
    const signedHash = ccc.Transaction.from(signed).hash();
    if (signedHash !== expectedHash) {
      throw new ClearSignRejectedError(
        "SIGNER_MODIFIED_TRANSACTION",
        report,
        `wrapped signer changed the transaction after confirmation (${expectedHash} -> ${signedHash})`,
      );
    }
    return signed;
  }
}

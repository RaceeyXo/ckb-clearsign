# CKB ClearSign — threat model (v0.1)

## Asset

The user's intent. When a user approves a transaction, what they approve
should be what the transaction actually does to their CKB and tokens.

## Background

A CKB transaction references each input only by out point
(`previousOutput = { txHash, index }`). The input cell's capacity, lock, type
and data are **not** in the transaction. To show the user what a transaction
does, a wallet must look those cells up. CCC (`Transaction.getInputsCapacity`,
`getFee`, `CellInput.completeExtraInfos`, …) asks its client — an RPC node
and/or indexer — and trusts the answer, and will also use `input.cellOutput` /
`input.outputData` if a dApp has already filled them in.

The signature itself is over the transaction hash (which commits to out
points, not cell contents), so the *signature* is never "wrong" — the danger is
entirely in what the user is **shown** before signing.

## Attacker

Anyone who controls data the wallet uses to describe inputs:

| Attacker | Capability |
|---|---|
| **Lying RPC node** | Returns forged transactions from `get_transaction`; forged cells from `get_live_cell`. |
| **Lying indexer** | Returns forged cells from `get_cells` / `get_transactions`. |
| **Malicious / compromised dApp** | Builds the transaction and pre-fills `input.cellOutput` / `input.outputData` with whatever it wants the wallet to display. |
| Network MITM between wallet and any of the above | Same as a lying RPC. |

Example attack: the user spends a cell that really holds 10,288 CKB, but the
RPC says it holds 288 CKB. The dApp's change output sends the difference to
the attacker. CCC shows a ~0.0001 CKB fee and a normal-looking transfer; on
chain, 10,000 CKB moves to the attacker. (Or the reverse: inflate a cell to
hide a large outflow as "change".)

## Defence: re-hashing

For each input, ClearSign:

1. fetches the transaction `previousOutput.txHash` from any client;
2. recomputes `blake2b(serialize(raw tx))` locally (`ccc.Transaction.hash()`);
3. rejects the input unless the computed hash equals `previousOutput.txHash`
   (`ORIGIN_TX_HASH_MISMATCH`);
4. takes the cell from `outputs[index]` / `outputsData[index]` of that verified
   transaction (`OUTPUT_INDEX_OUT_OF_RANGE` / `OUTPUT_DATA_MISSING` otherwise);
5. if `input.cellOutput` / `input.outputData` were pre-filled, requires them to
   equal the verified values (`PREFILLED_*_MISMATCH`).

Because the out point *is* the origin tx hash, an attacker cannot change any
field of an input cell without breaking blake2b. Only verified transactions
enter ClearSign's cache.

The explanation (`explainTransaction`) is computed only from these verified
cells plus the transaction's own outputs, which are committed by the hash being
signed. `ClearSignSigner` additionally:

- hands the wrapped signer a copy of the transaction whose inputs carry the
  verified data, so downstream code doesn't re-query the indexer;
- checks the signed transaction hashes to the same value as the one the user
  confirmed (`SIGNER_MODIFIED_TRANSACTION`);
- can refuse any transaction with type scripts it cannot explain
  (`rejectUnrecognised`).

**Where it must run.** A malicious dApp can skip a library call or render its
own text. ClearSign only protects users when it runs in the component that
shows the confirmation and holds the key — the wallet/signer. Used inside a
dApp, it protects that dApp's users only from a lying RPC, i.e. it helps
*honest* dApps only.

## Out of scope (v0.1)

| Not covered | Why it matters | Notes |
|---|---|---|
| **Chain inclusion** | A lying RPC can fabricate an origin transaction that hashes correctly but was never committed. ClearSign would explain it; the network would reject the real tx (inputs don't exist). | `chainStateVerified` is always `false`. Future: verify inclusion via block header + transactions root (Merkle proof, `get_transaction_proof`) against headers from multiple sources or a light client. |
| **Liveness (unspent)** | The input may already be spent. Same outcome: the network rejects the tx. | Not a theft vector for the displayed amounts, but a DoS / confusion vector. |
| **Liveness / availability of the RPC** | A lying RPC can refuse to answer (`ORIGIN_TX_NOT_FOUND`) and block signing. | Use `verifyClient` to point at an independent node. |
| **Unknown scripts** | Lock and type scripts are arbitrary code. ClearSign flags type scripts it doesn't understand (everything except xUDT in v0.1, including DAO, Spore, iCKB, sUDT) but cannot say what they do. Lock scripts are shown as addresses without interpretation. | `rejectUnrecognised` for strict wallets. |
| **Contract outcomes** | Whether the tx passes script verification, and what a contract "means" by a state change. | We explain movements, not outcomes. |
| **Cell deps & header deps** | Cell deps supply script code and data (e.g. oracles) and can change how scripts behave; header deps affect DAO maths. They are not explained. | Their contents could also be verified by re-hashing in a later version. |
| **Witnesses** | Not explained (other than the signer's own signature). | |
| **Compromised UI / host** | If the wallet process, its renderer or the device is compromised, the attacker controls what `report.text` looks like on screen and what `confirm` returns. | Outside any library's reach. |
| **Address book / phishing** | ClearSign shows addresses; it doesn't know which ones are "yours" or trusted. | Wallet's job. |
| **Token metadata** | xUDT amounts are raw integers; decimals and symbols are not known or verified. | Future: verified metadata (e.g. unique-type info cells), still re-hashed. |
| **Mainnet-specific config** | Script identification uses `client.getKnownScript`, i.e. CCC's built-in tables for the client's network. A wrong client network means wrong recognition. | Use a client matching the transaction's network. |

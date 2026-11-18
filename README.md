# CKB ClearSign

**Verify before you sign.** ClearSign is a TypeScript library and a
[CCC](https://github.com/ckb-devrel/ccc) (`@ckb-ccc/core`) signer wrapper that,
before a CKB transaction is signed:

1. **Independently verifies every input.** For each `input.previousOutput`, it
   fetches the origin transaction, re-serialises it and recomputes its blake2b
   hash locally. If the hash doesn't match, the input is rejected. The input
   cell is then taken from `outputs[index]` / `outputsData[index]` of that
   *verified* transaction. `input.cellOutput` / `input.outputData` supplied by
   an RPC, indexer or dApp are never trusted — if they're pre-filled and
   disagree with the verified data, ClearSign throws.
2. **Explains the transaction in plain language from verified data only:**
   per-address CKB sent/received, xUDT token movements, fee (inputs − outputs),
   mint/burn, and a list of type scripts it *doesn't* understand — flagged, not
   guessed at.

## Why

A CKB transaction commits to its inputs only by out point (`txHash:index`).
The capacity, lock, type and data of those cells are not in the transaction —
a wallet has to look them up. CCC, like most tooling, asks its indexer/RPC and
trusts the answer. A lying (or compromised, or MITM'd) RPC can therefore make
a user approve a transaction whose real effect differs from what they were
shown — e.g. a "0.0001 CKB fee" that is really 10,000 CKB, or a token amount
that isn't what's actually being spent.

But the origin transaction's hash *is* the out point. Re-hashing it locally
turns "the RPC says this cell holds X" into "this cell provably holds X (if
the origin tx exists)". That check is cheap, and it belongs in the wallet.
ClearSign makes it a one-line wrap.

## Guarantees (v0.1)

| | Status | What it means |
|---|---|---|
| **`inputDataVerified`** | ✅ `true` after re-hashing | Every input cell's capacity, lock, type and data were taken from an origin tx whose hash ClearSign recomputed and matched against the out point. A lying RPC/indexer/dApp cannot change them undetected. |
| **`chainStateVerified`** | ❌ always `false` in v0.1 | We do **not** prove the origin tx is committed on chain, nor that the input cell is still unspent. A lying RPC can still claim a fabricated-but-self-consistent tx exists; such a tx would be rejected by the network, but ClearSign alone doesn't tell you that. |
| Outputs / outputs data | ✅ by construction | They are part of the transaction being signed. |
| CKB movements & fee | ✅ from verified data | Per lock script (address): sent, received, net. Fee = Σ verified inputs − Σ outputs. Negative fee is flagged. |
| xUDT movements | ✅ from verified data | Detected via `client.getKnownScript(KnownScript.XUdt)`; amount = first 16 bytes of cell data, u128 little-endian. Raw units (decimals unknown). Mint/burn flagged. |
| Other type scripts | ⚠️ flagged, not decoded | Listed in `unrecognisedTypeScripts` (with CCC's name if known, e.g. `NervosDao`). Their effects are **not** in the explanation. Use `rejectUnrecognised` to refuse them outright. |
| Contract outcomes | ❌ not promised | We explain asset movements. We don't predict what a script will do or whether the tx will pass verification. |
| Cell deps / header deps / witnesses | ❌ not explained | See [threat model](docs/threat-model.md). |

### Honesty rules

- Two separate flags, `inputDataVerified` and `chainStateVerified`, in every
  report — never merged into one "verified" badge.
- ClearSign **explains movements; it does not promise contract outcomes.**
- **A library alone only protects against honest dApps.** If the dApp builds,
  verifies and displays the transaction itself, a malicious dApp can simply
  skip the check or show a different text. Real protection comes from running
  ClearSign inside the signer/wallet — the component the user trusts to say
  what they're signing. That's why `ClearSignSigner` exists.

## Install

```sh
npm install ckb-clearsign @ckb-ccc/core
```

(Not yet published to npm — see roadmap. For now: clone, `npm install`, `npm run build`.)

## Usage

### Wrap a signer (recommended — do this in the wallet)

```ts
import { ccc } from "@ckb-ccc/core";
import { ClearSignSigner, ClearSignRejectedError, InputVerificationError } from "ckb-clearsign";

const inner = new ccc.SignerCkbPrivateKey(client, privateKey); // any ccc.Signer

const signer = new ClearSignSigner(inner, {
  // Your confirmation UI. Resolve true to sign, false to refuse.
  confirm: async (report) => showDialog(report.text),
  rejectUnrecognised: true,   // optional: refuse txs with type scripts ClearSign can't explain
  verifyClient: myOwnNode,    // optional: fetch origin txs from a node you trust more
});

try {
  const txHash = await signer.sendTransaction(tx); // signTransaction / signOnlyTransaction also covered
} catch (e) {
  if (e instanceof InputVerificationError) { /* lying RPC/indexer/dApp: e.inputIndex, e.reason */ }
  if (e instanceof ClearSignRejectedError) { /* "USER_REJECTED" | "UNRECOGNISED_TYPE_SCRIPT" | "SIGNER_MODIFIED_TRANSACTION" */ }
}
```

In `signOnlyTransaction` the wrapper runs, in order: `verifyInputs` →
`explainTransaction` → `rejectUnrecognised` check → `await confirm(report)` →
the wrapped signer, which receives a copy of the transaction whose inputs carry
the **verified** cell data. Afterwards it checks the signed transaction's hash
equals the confirmed one, so the wrapped signer can't change what was shown.
`signer.review(tx)` returns the report without signing.

### Use the pieces directly

```ts
import { verifyInputs, explainTransaction } from "ckb-clearsign";

const verified = await verifyInputs(tx, client);          // throws InputVerificationError
const report = await explainTransaction(tx, verified, client);

report.inputDataVerified;      // true
report.chainStateVerified;     // false (v0.1)
report.feeShannons;            // bigint
report.movements;              // [{ address, lock, ckbSentShannons, ckbReceivedShannons, ckbNetShannons, tokens: [...] }]
report.unrecognisedTypeScripts;// [{ location, index, script, knownName?, reason }]
report.tokenSupplyChanges;     // xUDT mint (+) / burn (−)
report.warnings;               // string[]
console.log(report.text);
```

`verifyInputs(tx, client, { cache })` accepts a `Map` shared across calls; only
transactions whose hash was recomputed and matched are ever written to it.

`InputVerificationError.reason` is one of `ORIGIN_TX_NOT_FOUND`,
`ORIGIN_TX_HASH_MISMATCH`, `OUTPUT_INDEX_OUT_OF_RANGE`, `OUTPUT_DATA_MISSING`,
`PREFILLED_CELL_OUTPUT_MISMATCH`, `PREFILLED_OUTPUT_DATA_MISMATCH`.

### Example report

```
CKB ClearSign — transaction explanation
  Input data verified: YES — all 2 input cell(s) were re-derived from origin transactions whose hashes were recomputed locally.
  Chain state verified: NO — ClearSign v0.1 does not prove the origin transactions are on chain or that the inputs are unspent.

ckt1qrejnmlar3…qqkq9auf
  CKB: sends 212.00004425 CKB (spends 288 CKB, gets 75.99995575 CKB)
  xUDT 0xde0e71d2…859af7: sends 133069825310741 units (spends 133069825310741, gets 0; raw units, decimals unknown)
ckt1qq32v2nx49…qqdfg5e4
  CKB: receives 212 CKB (spends 0 CKB, gets 212 CKB)
  xUDT 0xde0e71d2…859af7: receives 133069825310741 units (spends 0, gets 133069825310741; raw units, decimals unknown)

Fee: 0.00004425 CKB (inputs − outputs)

ClearSign describes asset movements. It does not predict what any contract will do with them.
```

## Demo: a lying RPC

`demo/fake-rpc.ts` subclasses `ccc.ClientPublicTestnet` so that
`getTransaction()` inflates the capacity of the cell spent by input #0 by
10,000 CKB, then shows:

1. plain CCC with the lying RPC reports the forged capacity and fee;
2. `ClearSignSigner` with an honest RPC verifies and explains;
3. `ClearSignSigner` with the lying RPC throws `ORIGIN_TX_HASH_MISMATCH` before the user is asked anything;
4. a dApp that pre-fills a forged `input.cellOutput` is caught with `PREFILLED_CELL_OUTPUT_MISMATCH` when the wallet verifies through its own node.

```sh
npm run demo -- <testnet tx hash>     # live public testnet
npm run demo -- 0x6c83a29b95ab3e18161f30e05b127900df9ca1b9e502e8df9f16d95e76e47a87
npm run demo -- --offline             # recorded fixture, no network
```

Excerpt:

```
1. Plain CCC + lying RPC
    inputs capacity reported: 10288 CKB  (truth: 288 CKB)
    fee reported:             10000.00004425 CKB
    ✗ CCC accepted the forged cell — a wallet would show the user the wrong amounts.
...
3. ClearSignSigner + lying RPC
    ✓ caught before the user was asked anything (confirm calls: 0)
    InputVerificationError inputIndex=0 reason=ORIGIN_TX_HASH_MISMATCH
...
Demo result: honest data passes, lies are caught.
```

Set `CKB_RPC_URL` to use your own node. Behind an HTTP(S) proxy on Node ≥ 22.21,
run with `NODE_USE_ENV_PROXY=1` so `fetch` honours `HTTPS_PROXY`.

## Development

```sh
npm install
npm run build        # tsc, strict, NodeNext → dist/
npm test             # typecheck (src+tests+demo+scripts) + vitest, fully offline
npm run test:live    # optional: one test against the live public testnet
npm run fixtures     # re-record 5 real testnet txs (≥2 xUDT) into test/fixtures
```

Tests run on recorded real testnet transactions (`test/fixtures/`, each stored
with every origin tx it spends) and cover: honest data; tampered capacity,
lock, type and data; a different tx served under the requested hash;
out-of-range output index; missing origin; pre-filled `cellOutput` /
`outputData` mismatches; cache hygiene; xUDT and fee math (cross-checked
against CCC's `getFee` on honest data); unrecognised/known-but-undecoded
scripts; and the signer's confirm / reject / tamper-after-confirm paths with a
real `SignerCkbPrivateKey`.

## Scope

v0.1 decodes **CKB capacity and xUDT only**. No Spore, iCKB, Nervos DAO, sUDT
or other decoding yet — those cells are flagged as unrecognised.

## Roadmap (6 weeks)

| Week | Milestone |
|---|---|
| 1–2 | **Verifier + explainer**: `verifyInputs`, `explainTransaction`, recorded-fixture test suite, threat model. *(this repo, v0.1)* |
| 3 | **Signer wrapper + demo video**: `ClearSignSigner`, lying-RPC demo, recorded walkthrough. *(wrapper + demo already in v0.1; video pending)* |
| 4–5 | **One-wallet pilot**: integrate into one CKB wallet's signing path, gather UX feedback on the report and the `rejectUnrecognised` policy. |
| 6 | **Docs + npm + Nervos Talk report**: API docs, publish `ckb-clearsign` to npm, write up results and next steps (chain-state proofs, more decoders) on Nervos Talk. |

## Security

See [docs/threat-model.md](docs/threat-model.md).

## License

[MIT](LICENSE)

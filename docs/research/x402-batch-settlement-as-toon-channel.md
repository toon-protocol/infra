# x402 `batch-settlement` as a TOON channel backend

Research question: **can the TOON connector accept x402 `batch-settlement` channels as a
settlement backend, with x402 vouchers serving as TOON claims and a standard x402 facilitator
serving as the Onboarder?** The question is answered for both chains TOON settles on: Base
(Sepolia now, mainnet later) and Solana (devnet now). This is option (b) from the triage of
[infra#23](https://github.com/toon-protocol/infra/issues/23). Option (a) is
`openChannelWithAuthorization` on TOON's own `TokenNetwork` plus an EIP-3009 mock USDC.

Researched 2026-09-24, from primary sources only:

- **x402**: `x402-foundation/x402` at main `0cb1a1f0f4c2163357e255c824d319674e1db43f`. Links below
  are pinned to that commit, and line numbers refer to it.
- **Solana program**: `solana-foundation/payment-channels` at `3ffa4d6728ad88e4a9667a76ad9ccd68a302c696`.
- **TOON repos**: the sibling checkouts on this machine. The connector is at `9d48ba26`.
- **Chain reads**: live `cast` and `getAccountInfo` calls against `sepolia.base.org`,
  `mainnet.base.org` and `api.devnet.solana.com` on the research date.

Evidence is tagged by how it was established:

- **[V]**: verified in source or on chain.
- **[I]**: inference from verified facts, stated as inference.

Link shorthands:

- `X/` = `https://github.com/x402-foundation/x402/blob/0cb1a1f0f4c2163357e255c824d319674e1db43f/`
- `BS` = `X/contracts/evm/src/x402BatchSettlement.sol`
- `EVM` = `X/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md`
- `SVM` = `X/specs/schemes/batch-settlement/scheme_batch_settlement_svm.md`
- `PC/` = `https://github.com/solana-foundation/payment-channels/blob/3ffa4d6728ad88e4a9667a76ad9ccd68a302c696/program/payment_channels/src/`
- `connector/` = `/home/allidoizcode/Work/TOON-Protocol/connector/`

---

## Verdict

**It fits only with named changes, and those changes are large enough to make it the wrong
tool for infra#23.** Nothing in x402 `batch-settlement` is broken or immature for its own
purpose. The mismatch comes from four TOON commitments that the x402 channel model does not share:

1. **Channels run one way only.** An x402 channel carries value from payer to receiver and
   nothing else (`BS#L15`). TOON's channel carries value both ways (`TokenNetwork.sol:59-64`,
   `:318-324`). TOON uses that two-way property in live features:
   - Client payout nets against the client's own deposit (connector ADR 0026, issue #700).
   - A peering pays and is paid on one channel (ADR 0042, issue #1146 update).
   - "At most one live channel per pair per token" is protocol law (ADR 0059).

   Adopting x402 means two channels per relationship and giving up payout netting.
2. **The voucher has no nonce.** An x402 voucher signs only `(channelId, maxClaimableAmount)`
   (`BS#L96`). TOON's claim, watermark and one vector case depend on a nonce that may advance
   while the amount holds (`connector-domain/src/claim.rs:52-73`). Without the nonce, a
   zero-value packet cannot carry a fresh claim.
3. **Channel identity is set by config, not by participants.**
   - **On EVM this can be reconciled.** Fix the salt, the delay and the authorizer by
     convention and the id becomes derivable again. The cost is that uniqueness becomes a
     convention: the chain no longer refuses a second channel.
   - **On Solana it cannot be reconciled.** The x402 SVM channel address includes the
     **facilitator's** key and the **opening slot** (`SVM#L277-L292`). It cannot be derived
     from the two participants, so ADR 0059 cannot hold.
4. **Onboarding only covers the deposit.** The facilitator runs the deposit, which is what
   infra#23 wants. It does so only as part of an x402 payment payload that is bound to an
   x402 channel (see §6). It cannot fund a TOON `TokenNetwork` channel. Using the facilitator
   therefore means adopting the whole backend, not just an Onboarder.

**What x402 would genuinely buy TOON:**

- Audited, ownerless contracts that are already deployed on Base Sepolia and Base mainnet at
  one CREATE2 address.
- A second payer key (`payerAuthorizer`) that signs vouchers separately from the key that
  holds funds.
- Claims batched across many channels in one relayable transaction, with one sweep per token.
- A facilitator ecosystem that sponsors gas.

**Recommendation [I]:** use none of this for infra#23. Option (a) is much smaller. It is
smaller still than the triage assumed, because the deployed `TokenNetwork` is already
ERC-2771-enabled with the gas-station forwarder as its trusted forwarder (§8). Keep x402
`batch-settlement` on file as a possible **second EVM backend** for the client edge only. That
use needs an ADR that amends 0059 and 0024 and states the payout-netting loss.

---

## 1. Voucher vs claim

### What a TOON EVM claim signs [V]

- **EIP-712 domain**: `EIP712("TokenNetwork", "1")` plus `chainId` and `verifyingContract` =
  the per-token `TokenNetwork` (`connector/packages/contracts/src/TokenNetwork.sol:192`). The
  connector treats that domain as configured per channel and cross-checks it against chain at
  boot (ADR 0024, `docs/adr/0024-…md:43-63`).
- **Type**: `BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256
  lockedAmount,bytes32 locksRoot)` (`TokenNetwork.sol:38-40`). `lockedAmount` and `locksRoot`
  are always zero (ADR 0024 `:73-76`, ADR 0004 `:76-78`).
- **Signer**: the channel counterparty, the participant whose deposit pays
  (`TokenNetwork.sol:323-346`). The connector checks the signer against its **own record** of
  the counterparty, never the claim's own `signerAddress` (ADR 0052 `:165-167`,
  `connector-signer/src/claim_signature.rs:182-186`).
- **Nonce and watermark**: the connector refuses a claim unless the nonce strictly advances.
  The amount may hold but may not fall (`connector-domain/src/claim.rs:52-73`). A nonce that
  advances at a flat amount is explicitly legal (`connector-runtime/src/claim.rs:3053-3058`).
  The chain enforces nonce advance too (`TokenNetwork.sol:349-350`).
- **Amount semantics**: `transferredAmount` is the **exact** cumulative amount owed.
  `claimFromChannel` pays the delta out immediately (`TokenNetwork.sol:352-372`).
- **Wire form**: `WireClaim { channel_id, nonce, cumulative_amount: u64, signature }`
  (`connector-runtime/src/claim.rs:45-50`). It rides as JSON with `chainId` and
  `tokenNetworkAddress` (`connector/vectors/wire-vectors.json`, `peer_carriage.claim_evm`).
- **Per-packet rule**: one claim per packet, never batched (ADR 0004 status line; ADR 0042
  `:121-126`). Every PREPARE a connector sends carries its covering claim (`CONTEXT.md:326-334`).
- **Solana claim**: 96 bytes, `"TOON-BALPROOF-V2" ‖ program_id ‖ channel_pda ‖ nonce u64 LE ‖
  transferred u64 LE`, signed with ed25519 (ADR 0053; `packages/solana-program/src/processor.rs:835`,
  `:923-935`; vector `peer_carriage.claim_solana.signed_message_hex`).

### What an x402 EVM voucher signs [V]

- **EIP-712 domain**: `EIP712("x402 Batch Settlement", "1")` with `verifyingContract` = the
  singleton `x402BatchSettlement` (`BS#L185`). That is one contract for all tokens, not one per token.
- **Type**: `Voucher(bytes32 channelId,uint128 maxClaimableAmount)` (`BS#L96`).
- **`channelId`**: the EIP-712 hash of the full `ChannelConfig`. The config binds `payer`,
  `payerAuthorizer`, `receiver`, `receiverAuthorizer`, `token`, `withdrawDelay` and `salt`
  (`BS#L36-L44`, `BS#L92-L94`, `BS#L442-L446`). The token and both authorizers are therefore
  bound **through the id**.
- **Signer**:
  - If `payerAuthorizer ≠ 0`, the signer must be `payerAuthorizer` and only ECDSA is accepted.
  - Otherwise the contract checks `payer` via `SignatureChecker`, which allows EIP-1271 smart
    wallets (`BS#L530-L538`).
- **No nonce.** "The cumulative model makes nonces unnecessary" (`EVM#L666`). Replay of an
  applied voucher is a no-op (`BS#L73-L74`, `BS#L522`).
- **Amount semantics**: `maxClaimableAmount` is a **ceiling**. The receiver-side party picks
  any `totalClaimed ≤ ceiling` (`BS#L523-L525`), and over-claiming is "a trust violation, not
  a protocol violation" (`EVM#L666`). In x402's HTTP flow the ceiling is
  `chargedCumulativeAmount + per-request max`, and the server charges the actual price within
  it (`EVM#L35`, `EVM#L249`, `EVM#L255`).
- **No expiry.** A voucher stays claimable while escrow remains (`EVM#L672`).
- **Redemption needs the full `ChannelConfig`**, not just the id (`BS#L66-L79`). The receiver
  must hold the config.

### Field by field

| TOON claim | x402 voucher | Fit |
|---|---|---|
| `channelId` = `keccak(p1,p2,epoch)` | `channelId` = EIP-712 hash of `ChannelConfig` | Different derivation. See §2. |
| `nonce` (u64, strictly increasing) | — | **Missing.** |
| `transferredAmount` (exact cumulative) | `maxClaimableAmount` (cumulative ceiling) | Expressible: set ceiling = exact cumulative. |
| `lockedAmount`, `locksRoot` (always 0) | — | TOON gives nothing up. |
| domain = per-token `TokenNetwork` | domain = singleton contract; token bound via `channelId` | Equivalent binding. |
| signer = participant's own key | signer = `payerAuthorizer` (session key) or `payer` (1271) | x402 adds a capability. |
| — | `receiverAuthorizer`, `withdrawDelay`, `salt` (through the id) | Extra. Must be fixed by convention (§2). |

### Can a voucher express everything a claim must?

**Almost, but not the nonce [I].** With the ceiling set equal to the exact cumulative amount,
a voucher is a cumulative, superseding, per-channel statement. That matches TOON's **Claim**
definition (`CONTEXT.md:320-324`). The problems are these:

- **No fresh claim at a flat amount.** TOON admits a claim whose nonce advances at an
  unchanged amount. A route priced `0` passes the value check (`connector-domain/src/claim.rs:75-82`),
  so a free packet still carries a *new* claim that cannot be replayed. Under x402 the only
  claim available at a flat amount is the **same** voucher digest, which anyone who has seen
  it can replay. Two things move with this: the watermark definition (`CONTEXT.md:336-341`,
  "the highest nonce") and the `claim_same_nonce_different_bytes` peer-carriage vector.
- **The claim wire and vectors need a new variant.** The claim JSON carries `nonce`,
  `lockedAmount`, `locksRoot` and `tokenNetworkAddress`. An x402 claim needs the contract
  address and `channelId`, and the receiver must know the full config out of band.
- **Two words collide.** TOON's glossary lists **voucher** under *Avoid* for Claim
  (`CONTEXT.md:324`). The word would come back as the name of a TOON claim on one backend.

---

## 2. Channel identity (ADR 0059, ADR 0060)

### What ADR 0059 requires [V]

- A channel id is computed from the two participants, the token and a public per-pair epoch.
- Anyone can compute it and ask the chain whether the channel exists.
- **At most one live channel per pair per token**, and the chain refuses a second
  (`docs/adr/0059-…md:7-10`, `:71-74`; `TokenNetwork.sol:236-243`).
- The requirement exists because a peering is established from a URL, with no id exchanged
  (ADR 0059 `:12-17`; ADR 0058).
- On Solana the rule holds by PDA seeds `["channel", min, max, mint]`
  (`packages/solana-program/src/processor.rs:61-72`).

### x402 on EVM: reconcilable, with a convention [I from V]

`channelId = EIP712Hash(ChannelConfig)` (`BS#L442-L446`). TOON could fix every non-participant
field by rule:

- `salt = 0`.
- `receiverAuthorizer = receiver`, the connector's own settlement key.
- `payerAuthorizer = 0` or the payer's key.
- `withdrawDelay` = a published constant.

The id is then derivable from `(payer, receiver, token)` plus public facts. The receiver's
`withdrawDelay` and `receiverAuthorizer` could ride in its self-description (ADR 0050). A URL
would then remain a complete answer, as ADR 0058 requires. The costs:

- **Uniqueness stops being enforced by the chain.** `deposit` creates any config on first
  funding and refuses none (`BS#L200-L232`). A payer can open parallel channels to the same
  receiver with other salts or delays. The connector must refuse to recognise non-conforming
  configs. ADR 0059 explicitly rejected a rule the chain does not enforce, in favour of
  `ChannelAlreadyExists` as "a real refusal" (`:71-74`).
- **The pair becomes ordered.** A→B and B→A are two configs and two ids (§3).
- **No epoch is needed.** x402 channels are reusable after refund or withdrawal ("Channels are
  long-lived", `EVM#L65`), and `ChannelCreated` can fire again on the same id
  (`X/contracts/evm/docs/x402-batch-settlement-implementers.md#L89`). This is simpler than
  TOON's epoch. **[I]**

### x402 on Solana: not reconcilable [V]

The SVM channel address is
`PDA["channel", payer, extra.feePayer, token, payerAuthorizer, salt u64, openSlot u64]`
(`SVM#L277-L292`; `PC/state/channel.rs#L238-L258`).

- **`feePayer` is the facilitator.** It sits in the channel's `payee` seat as a zero-share
  lifecycle authority (`SVM#L36-L39`). Channel identity is therefore bound to *which
  facilitator* opened it.
- **`openSlot` must be within about 1500 slots of opening** (`PC/instructions/open.rs#L282-L286`,
  `PC/constants.rs#L44`). It cannot be derived from participants.
- The receiver (`payTo`) is not in the seeds at all. It is committed through a
  `distribution_hash` (`SVM#L190-L206`).

> **Correction (triage, 2026-09-24):** this holds for **peering**, not for the client edge.
> ADR 0059 requires derivation for peering symmetry: "B must be able to add A the same way A
> added B and land on the same channel, without either telling the other an id"
> (`docs/adr/0059-…md:94-95`). At the client edge the client opens the channel and every
> voucher names its channel id, so the connector reads the id from the voucher and verifies
> the account on chain. See connector#1329.

ADR 0059's question, "do I already have a channel with this counterparty?", has no
chain-state answer here. You need an index or an exchanged id, and ADR 0059 rejects both
(`:85-107`).

### ADR 0060: a claim proves a peering [I from V]

- **What 0060 requires**: role `peer` iff the interaction carries a claim on a channel listed
  in that peer's `[[peer_channels]]` row, whose signature verifies against that row's
  counterparty key (`docs/adr/0060-…md:7-11`). The decision takes a verdict of `Verified`,
  `UnknownChannel` or `SignatureInvalid` (`:383-386`).
- **An x402 voucher works for this.** The row would name the x402 `channelId` (and hold its
  config), and the "counterparty key" becomes `payerAuthorizer`, or `payer` when that is zero.
- **With `payerAuthorizer ≠ 0` the key that proves the peering is not the key that holds the
  funds.** ADR 0060 deliberately concentrated identity in "the key the channel was actually
  opened against" (`:195-197`, `:355-358`). A separate session key is a design choice TOON
  would have to make on purpose. It is not a defect.

---

## 3. Direction

### x402 is one-way [V]

- Only the receiver side claims (`BS#L242`, `BS#L254-L256`).
- Only the payer side funds and withdraws (`BS#L324-L327`).
- Refund goes receiver → payer, of the payer's own escrow (`BS#L399-L404`).
- The SVM program is also one-way, from payer to payee (`SVM#L22-L39`).

### TOON's channel is two-way, and TOON uses that [V]

- **Contract**: each participant has its own `deposit`, `nonce` and `transferredAmount`
  (`TokenNetwork.sol:59-64`, `:80`). Either participant may `claimFromChannel` the other's
  signed proof (`:318-324`). Settlement returns each side its remainder (`:421-431`).
- **Port**: the settlement port models both sides, `counterparty_deposited` and
  `own_deposited` (`crates/connector-settlement/src/port.rs:45-70`). `fund` is a
  self-deposit into one's own side (`:216-242`).
- **Client payout (connector → client)**: `ClientPayoutLedger` signs claims from the connector
  to a client on **the client's own channel** (`crates/connector-client-edge/src/outbound_ledger.rs:1-6`).
  The client's spendable headroom is `deposit − owed + credited`, so a payout directly raises
  what the client can spend (ADR 0026 `:99-112`, "decision 9 of toon-meta#262").
  - Under x402 the connector would need its **own** funded channel to each client it pays.
  - A payout could no longer raise the client's spendable balance on the client's channel,
    because the chain settles each direction separately.
  - Netting would survive only as an off-chain credit, which is the kind of accumulation ADR
    0042 retired (`:281-283`). **[I]**
- **Peering (connector ↔ connector)**: under ADR 0042's issue #1146 update, "holding one
  channel in both roles with one hop is the deployed shape" (`docs/adr/0042-…md:434-441`). A
  peering both pays (`[[pay_channels]]`) and is paid (`[[peer_channels]]`) on one channel.
  Under x402 that is two channels, and the protocol sentence becomes "at most one per
  *ordered* pair". ADR 0059 would need amending, and so would the `CONTEXT.md` **Payment
  channel** entry (`:311-317`).
- **Swap and gas-station**: the gas-station sponsors `claimFromChannel` so that "a swap party
  cashes a counterparty's balance proof" (`gas-station/README.md:177-196`). That flow already
  assumes TOON's contract. **[V]** that it exists. Whether swap needs two-way value on one
  channel was not researched. **[I]** open.
- **Client → connector only**: the one TOON flow that is purely one-way. A client pays a
  connector at the client edge. Here x402 fits cleanly. **[I]**

---

## 4. Settlement, redemption and safety

| | TOON `TokenNetwork` | x402 `x402BatchSettlement` |
|---|---|---|
| Admin | `Ownable`, `Pausable`, owner `emergencyWithdraw` sweeps the contract when paused (`TokenNetwork.sol:22`, `:478-490`) | No owner, no pause. Inherits only `EIP712, Multicall, ReentrancyGuardTransient` (`BS#L24`) |
| Payer exit | Either side calls `closeChannel`. Challenge period `settlementTimeout ≥ 1 h`. Anyone may `settleChannel` afterwards (`:35`, `:383-450`). Also `forceCloseExpiredChannel` after `maxChannelLifetime` (`:455-472`) | Payer calls `initiateWithdraw(amount)`, may be partial, then `finalizeWithdraw` after `withdrawDelay` of 15 min to 30 days (`BS#L85-L86`, `BS#L324-L386`). The channel stays usable |
| Receiver redeem | `claimFromChannel`: one tx per channel, pays out immediately, allowed while Opened or Closed (`:307-376`) | `claim` or `claimWithSignature` records `totalClaimed` across **many channels in one tx**. `settle(receiver, token)` sweeps everything in one transfer (`BS#L247-L307`). `claimWithSignature` can be relayed by anyone (`BS#L270-L289`) |
| Who picks the delay | Channel opener (`openChannel(participant2, settlementTimeout)`) | **Receiver**. Advertised as `extra.withdrawDelay` and enforced by the facilitator (`EVM#L71`, `EVM#L500`) |
| Cooperative exit | Close, then settle | `refund` / `refundWithSignature` from the receiver side, immediately (`BS#L399-L429`) |

### Risk to the receiving connector [V from BS/EVM, I for TOON]

- **The same class of risk exists in both contracts.** Unclaimed vouchers are not reserved
  on chain. If `finalizeWithdraw` lands before `claim`, the claim reverts with
  `ClaimExceedsBalance` (`BS#L244-L246`, `BS#L320-L323`; implementers' notes `#L22-L38`;
  `EVM#L524`). TOON has the same shape: a closed channel settles after its window.
- **Three x402-specific differences:**
  1. **The x402 floor is 15 minutes.** TOON's floor is 1 hour. In x402, however, the
     *receiver* chooses the delay, so a connector could demand days.
  2. **An x402 withdrawal does not end the channel.** The payer can keep signing vouchers
     while a withdrawal is pending. The connector's admission check must subtract the pending
     amount, or claim immediately. **[I]**
  3. **Delegating `receiverAuthorizer` to a facilitator lets that facilitator refund the
     connector's unclaimed escrow to the payer.** The spec requires the facilitator to
     authenticate refund requests (`EVM#L674`). A connector should keep `receiverAuthorizer`
     for itself. **[I]**
- **Watchers**: I found no automated close-watcher in the connector. Redemption is an
  operator write (`POST /channels/:id/redeem`, `crates/connector-operator/src/lib.rs:913-925`;
  `crates/connector-runtime/src/connector.rs:3915-3927`). ADR 0006 keeps policy outside.
  **[V]** by search; absence is inferred from `grep`.
  - Under x402 a controller would have to watch `WithdrawInitiated` (`BS#L147`) and claim
    within `withdrawDelay`.
  - The facilitator returns `withdrawRequestedAt` in every response for exactly this reason
    (`EVM#L508`).
  - The obligation is the same kind TOON already has for `ChannelClosed`. It is not new.
    **[I]**
- **Gas**: x402's cross-channel batching is a real advantage for a connector with many client
  channels. TOON pays one `claimFromChannel` per channel. **[I]**

---

## 5. Server state, the x402 "server", ADR 0022 and the ILP path

### What an x402 server must keep [V]

Per channel it keeps `channelConfig`, `chargedCumulativeAmount`, `signedMaxClaimable`, the
latest `signature`, and mirrored on-chain fields. It must serialize per channel and must not
commit until the handler succeeds (`EVM#L225-L257`). Resync goes through a **corrective 402**
carrying the last signed voucher (`EVM#L557-L587`).

### What the connector already keeps [V]

- A per-channel watermark of `(nonce, cumulative)` in `ClaimBook`, advanced under a lock
  (`connector-runtime/src/claim.rs:1279-1347`).
- A durable journal of accepted claims (ADR 0005 `:96-99`).
- `POST /ilp/claim-state`, an owner-authenticated read of where a payer's claims stand
  (`docs/protocol/client-edge-spec.md:1133-1190`). A payer asks it on every covered packet
  (ADR 0042 `:207-210`).

### Comparison [I]

The two models are the same thing under different names:

| x402 | TOON |
|---|---|
| `chargedCumulativeAmount` + last signature | watermark + journal |
| corrective 402 | `/ilp/claim-state` |
| serialize per channel | the watermark lock |

**The connector would be the x402 "server" in role but not in transport.** The voucher would
ride inside an ILP PREPARE, in BTP protocolData or the `Payment-Channel-Claim` header
(`connector-runtime/src/claim.rs:64-70`), never in an HTTP `PAYMENT-SIGNATURE` header. Nothing
in the channel contract needs HTTP:

- The receiver can `claim` directly (`BS#L242`).
- The spec lets a server verify EOA vouchers locally when mirrored state is fresh (`EVM#L252`).

The facilitator would be touched only for deposits and, optionally, for relaying claims.

### ADR 0022 [V/I]

ADR 0022 defers "paying over HTTP": plain HTTP requests with an x402 one-shot payment
attached, which it calls "a second architecture" that inverts "claims are constant,
settlement is rare" (`docs/adr/0022-…md:104-110`).

- **Using an x402 channel as a settlement backend does not reopen that deferral.** Payment
  still rides ILP. The connector's greeting already borrows x402's body shape with its own
  scheme `"toon-channel"` (`crates/connector-domain/src/x402.rs:427`, `:548-551`).
- **The facilitator's deposit call is HTTP, but it happens once, at Onboarding, outside the
  packet path.** That is exactly the role the glossary edit gives the Onboarder
  (`toon-meta/context/glossary.md`, uncommitted diff).

---

## 6. Facilitator as Onboarder

### What `/settle` does with a `deposit` payload [V]

- **Contract call**: it calls `x402BatchSettlement.deposit(config, amount, collector,
  collectorData)` and nothing else (`X/typescript/packages/mechanisms/evm/src/batch-settlement/facilitator/deposit.ts#L595-L606`).
- **Collectors**: the deposit goes through the canonical ERC-3009 collector or the Permit2
  collector (`EVM#L357-L362`).
- **Target**: it can only fund an **x402 channel**. There is no path to a TOON
  `TokenNetwork`.

### Can a deposit be settled standalone? Yes, with conditions [V/I]

- **A voucher is mandatory.** A `deposit` payload must carry `channelConfig`, `voucher` and
  `deposit` (`EVM#L110`, `EVM#L114-L165`). The facilitator verifies the voucher's signature and
  checks `maxClaimableAmount ≤ balance + deposit` (`EVM#L496-L505`;
  `facilitator/deposit.ts`, `verifySharedDepositState`). It does **not** claim the voucher.
- **A zero voucher appears to pass.** For a fresh channel, a voucher of `0` passes the
  deposit-time "not strictly below `totalClaimed`" rule (`EVM#L605`). **[I]**
- **The facilitator checks the config against the payment requirements.** The config's
  `receiver`, `receiverAuthorizer`, `token` and `withdrawDelay` must equal the
  `PaymentRequirements` fields `payTo`, `extra.receiverAuthorizer`, `asset` and
  `extra.withdrawDelay` (`EVM#L496-L500`).
- **Nothing signed binds an HTTP URL.**
  - The ERC-3009 nonce is `keccak256(channelId, salt)`.
  - The Permit2 witness is `DepositWitness(bytes32 channelId)`.
  - `PaymentPayload.resource` is optional in core v2.
  - The `PaymentRequirements` fields that are checked carry no URL.

  A client, an app or an Onboarder can therefore post a deposit for a receiver that is an ILP
  connector, not an HTTP resource server. **[I]** The facilitator's deposit path does not read
  `resource`. That is verified by reading, not by running it.
- **The facilitator need not be the resource server or the `receiverAuthorizer`** (`EVM#L57`,
  `EVM#L468`; made optional in x402 PR #2700). Delegating `receiverAuthorizer` to it is unwise
  for a connector (§4).

### Gas, recovery and custody [V]

- **Gas**: the facilitator's signer sends and pays for deposit, claim, settle and refund.
  "Deposits are sponsored by the facilitator (gasless for the client)" (`EVM#L15`).
- **Recovery**: the protocol has **no fee-recovery mechanism**. There is no fee field in core
  `PaymentRequirements` and none in the batch spec or facilitator code. Recovery is a business
  arrangement outside the protocol. **[I]**
- **Custody**: the facilitator **never holds funds**.
  - Permit2 pulls from the payer straight into the batch contract.
  - EIP-3009 goes payer → collector → batch contract within one transaction, and the contract
    checks its own balance delta (`BS#L222-L225`).
  - Escrow leaves only to the addresses fixed in `ChannelConfig`: settle pays the `receiver`,
    refund and withdrawal pay the `payer`.

  This matches the glossary's **Onboarder** ("never holds the user's funds").

### Fit to the glossary edit [I]

- **Where it matches**: a stock facilitator is an Onboarder in every respect the glossary
  names. It submits the Funding Authorization, pays gas and holds nothing.
- **Where it does not**: the channel it funds is an x402 channel. Its **Funding
  Authorization** is an EIP-3009 `receiveWithAuthorization` whose `to` is the x402 collector,
  so it cannot be retargeted at `TokenNetwork`. infra#23's own caveat holds: "A standard
  facilitator only settles a USDC transfer" into *its* channel, not TOON's.
- **On Solana** the facilitator's key becomes part of the channel's identity (§2).

---

## 7. Solana

### Is there an x402 SVM channel program on devnet? [V]

Yes. x402 SVM `batch-settlement` runs on solana-foundation's **payment-channels** program,
`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` (`PC/lib.rs#L36`; `SVM#L16-L20`, `#L78-L88`).

- **Devnet**: executable, owned by the upgradeable loader, upgrade authority
  `4zTeC5mV…`, with successful transactions on the research date (devnet `getAccountInfo`).
- **Mainnet**: deployed, with upgrade authority `DXtFpbPj…`.
- **Audit**: audited by Cantina on 2026-07-27. The PDF is under `audits/` in that repo.
- **Spec status**: the SVM binding is **draft** and was merged in x402 PR #2698.
- **SDK status**: no `batch-settlement` directory exists under
  `typescript/packages/mechanisms/svm/src` on main. The implementation is **open PR #3164**
  (+27.8k lines, review required, updated on the research date).

### Gasless deposit under x402 SVM [V]

- **Rent and fees**: the facilitator (`extra.feePayer`) is fee payer and `rent_payer`, so the
  payer needs no SOL (`SVM#L989-L1006`, `#L1022-L1026`).
- **Token authority**: the payer must still **sign** as token authority. The deposit is a
  `TransferChecked` with authority `payer` (`PC/instructions/open.rs#L249-L257`, `#L374-L383`).
  There is no permit or delegate path (`SVM#L1012-L1013`).
- **Token account**: the payer's canonical ATA must already exist (`SVM#L1053-L1057`).

### TOON's own program already allows the same thing [V]

- **`InitializeChannel`**: needs only a rent-paying signer. The participants are non-signers
  (`packages/solana-program/src/processor.rs:136-155`, `:214-249`).
- **`Deposit`**: requires the `depositor` to sign and credits strictly by signer
  (`:309-311`, `:355-360`, `:381-391`). It never charges the fee payer, so a sponsor can be
  fee payer while the user signs only as depositor.
- **The connector already builds exactly that transaction shape** in a test fixture
  (`crates/connector-settlement-solana/src/lib.rs:639-679`, `:711-734`).

So on Solana, "credits strictly by signer" does **not** block gasless onboarding. It blocks
only a sponsor depositing *its own* tokens on the user's behalf, and x402 has the same rule.

### Gaps in TOON's program that x402's program closes [V code, I impact]

- **Rent is not refunded to the sponsor.** Settle and ForceClose send rent to an
  unconstrained, caller-chosen `rent_recipient` (`processor.rs:470`, `:486`, `:617-641`).
  payment-channels records `rent_payer` for this reason.
- **A channel can be squatted.** `InitializeChannel` is permissionless, with a caller-chosen
  duration, and each pair gets one PDA. A third party could pre-create a pair's channel with
  a bad duration (`:136-191`).
- **Possible replay across incarnations.** There is no incarnation in the seeds or the proof,
  and nonces restart at 0 after re-initialisation (`:276-277`, `:643-647`). Old proofs could
  plausibly replay. Not tested. payment-channels prevents it with its `openSlot` seed.

### Fit [I]

The payment-channels program is one-way, its voucher has no nonce and no program id (50
bytes: `0x56 0x01 ‖ channelId ‖ u64 cumulative ‖ i64 expiresAt`, `SVM#L316-L323`), and its
address is not derivable from participants (§2). As a TOON backend it fails ADR 0059 outright,
and it would need a new claim scheme alongside ADR 0053's.

---

## 8. Tokens

### x402 deposit paths [V]

- **`eip3009`** is the default. It uses `receiveWithAuthorization` only, not
  `transferWithAuthorization`. `to` is the collector, and the nonce is
  `keccak256(abi.encode(channelId, salt))`
  (`X/contracts/evm/src/periphery/ERC3009DepositCollector.sol#L29-L43`).
- **`permit2`** uses `permitWitnessTransferFrom` with witness `DepositWitness(bytes32 channelId)`.
  It needs a prior `approve(Permit2)`, or an optional EIP-2612 `permit` carried in
  `collectorData` (`X/contracts/evm/src/periphery/Permit2DepositCollector.sol#L73-L114`).
- **Sponsoring the approve**: two extensions can do it. Both extension specs mention only
  `exact`, but the batch-settlement facilitator implements both (`EVM#L611-L623`;
  `facilitator/deposit-permit2.ts`).
  - `eip2612GasSponsoring` needs a token with EIP-2612
    (`X/specs/extensions/eip2612_gas_sponsoring.md`).
  - `erc20ApprovalGasSponsoring` has the user sign a raw `approve(Permit2)` transaction. The
    facilitator funds its gas and broadcasts it together with the deposit
    (`X/specs/extensions/erc20_gas_sponsoring.md#L5-L16`, `#L222-L230`).
- **No allowlist.** The contract checks only `token ≠ 0` and an exact balance delta, so
  fee-on-transfer tokens revert (`BS#L209`, `BS#L221-L225`, NatSpec `BS#L21`).
- **Blacklist risk**: the Cantina audit's acknowledged Low 3.2.1 is that a USDC blacklist of
  the payer or receiver permanently traps escrow, because there is no admin rescue
  (`X/contracts/evm/audits/cantina_x402_may2026.pdf`).

### TOON's devnet mock USDC [V]

`0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` is `MockERC20("USD Coin (mock)", "USDC", 6)`, a
bare ERC-20 with an ungated `mint`.

- **Source**: `connector/packages/contracts/test/mocks/MockERC20.sol:7-57`.
- **Deployment**: `script/DeployTestnet.s.sol:5,50`; `deployments/base-sepolia.md:23,36`.
- **No EIP-3009 and no EIP-2612.** These calls revert on Base Sepolia: `DOMAIN_SEPARATOR()`,
  `authorizationState(address,bytes32)`, `nonces()`, `version()` and `eip712Domain()`. The
  bytecode has no `receiveWithAuthorization`, `transferWithAuthorization` or `permit` selector.

What that leaves under x402:

- **Permit2 path**: the user needs either one gas-paid `approve(Permit2)` or a facilitator
  that offers `erc20ApprovalGasSponsoring` for batch-settlement on Base Sepolia (not checked).
  Permit2 itself is deployed on Base Sepolia (`cast code`).
- **EIP-3009 path**: needs a new mock that implements it, or Circle's Base Sepolia USDC
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Circle's token answers `version()="2"` and has
  both 3009 typehashes and `permit`. It cannot be minted on demand.

### Relevance to option (a) [V/I]

The deployed `TokenNetwork` `0xe9E05dfe…` already names the gas-station's forwarder as its
trusted forwarder:

- `trustedForwarder()` returns `0x350fCd26…`, and `isTrustedForwarder(0x350fCd26…)` returns
  `true` (live `cast`).
- That is the forwarder the gas-station relays through (`gas-station/README.md:13`, `:382`).
- Every authorization check reads `_msgSender()` (`TokenNetwork.sol:17-21`).

`openChannel` and `setTotalDeposit` can therefore already be relayed gaslessly. What blocks
gasless Onboarding today is:

- **The token approve** that `setTotalDeposit`'s `transferFrom(_msgSender())` needs
  (`TokenNetwork.sol:283-284`). The mock has no permit, so the approve costs gas.
- **Gas-station policy**, which refuses `openChannel` (`gas-station/README.md:177-180`).

Option (a) therefore needs the following, and nothing from x402:

- a token with EIP-3009 or EIP-2612;
- a deposit path that consumes that authorization;
- a sponsor policy that admits the open.

**[I]**

---

## 9. Cost of adoption for TOON

### ADRs to supersede or amend [I from V]

| ADR | Change |
|---|---|
| **0059** (channel derived from participants) | Amend. Identity becomes an ordered pair plus a config convention. Uniqueness is enforced by convention, not refused by the chain. **Cannot be satisfied on Solana** under x402 SVM (§2). |
| **0024** (claim signs the EIP-712 balance proof) and **0053** (Solana claim binds its domain) | Amend. A second claim scheme per chain: `Voucher(channelId, maxClaimableAmount)` on EVM, the 50-byte `0x5601` voucher on SVM. |
| **0005** and `CONTEXT.md` **Nonce** and **Watermark** | Amend. The watermark becomes amount-only on this backend. Decide what a zero-value packet carries (§1). |
| **0026** (client payout netting, #700) | Amend or accept a loss. Payout needs a connector-funded reverse channel, and headroom netting no longer holds on chain (§3). |
| **0042** (issue #1146: one channel in both roles) | Amend. A peering needs two channels. |
| **0060** (claim proves a peering) | Clarify. The proving key may be a `payerAuthorizer` session key, not the funding key. |
| **0021** (vectors are normative) | Consequence. A cross-repo vector change (below). |
| **0022** (paying over HTTP deferred) | **No change.** Vouchers ride ILP (§5). |
| `CONTEXT.md` **Claim** | Revisit "_Avoid_: voucher". |

### New code [I]

- **Settlement backend.** Either a new `connector-settlement-x402` crate or a mode of
  `connector-settlement-evm`. Either way it implements `SettlementBackend`.
  - The port assumes two sides and an open/close/settle lifecycle (`port.rs:18-70`, `:203-316`).
    x402 has no `open` (a channel is created on first deposit), no close state, and
    claim-then-sweep redemption. Expect port changes, not just a new impl.
  - For scale, the existing EVM backend is about 3k lines including its index
    (`crates/connector-settlement-evm/src/*.rs`).
- **Claim handling.** In `ClaimBook` and `connector-signer`: a new `ClaimSignature` variant, a
  voucher digest, an amount-only watermark path, and config rows that carry the full
  `ChannelConfig`.
- **Watching withdrawals.** A controller-side watcher for `WithdrawInitiated`, which could be
  an operator job.
- **Self-description and greeting.** Publish the x402 contract, `receiverAuthorizer` and
  `withdrawDelay`.
- **Solana.** A second Solana backend on payment-channels, which still fails 0059. Or nothing
  on Solana, leaving the two chains asymmetric again. That is the very asymmetry 0059 was
  written to remove (`:170-172`).

### Vectors [I]

New cases are needed:

- `claim` (a voucher digest),
- `peer_carriage.claim_x402`,
- a channel-id derivation case,
- a replacement for `claim_same_nonce_different_bytes` semantics.

`schema_version` bumps, and toon-client, rig and swap replay the change
(`toon-meta/context/glossary.md`, "Vectors").

### Client (`@toon-protocol/client`) [I from V]

Today the client:

- signs `BalanceProof` (`toon-client/packages/client/src/signing/evm-signer.ts:121-148`);
- opens and funds with `openChannel` + `approve` + `setTotalDeposit`
  (`src/channel/evm/TokenNetworkClient.ts:403-463`, `:565`).

It would need a voucher signer, `ChannelConfig` derivation, a facilitator deposit client
(the `@x402/evm` batch-settlement client could be reused), and per-backend channel
discovery.

### Rough size [I]

Weeks, not days. As an order of magnitude only:

- **Connector**: 3–5k lines of Rust, including tests.
- **Client**: 1–2k lines of TypeScript.
- **Records**: 2–4 ADRs.
- **Deploy**: a cross-repo vector release and a breaking config change.

Option (a) is about one contract function, one token deploy, one gas-station policy change
and a client call path. It is at least an order of magnitude smaller.

---

## 10. Maturity and governance [V]

- **Governance**: x402 is "x402 a Series of LF Projects, LLC", a Linux Foundation project.
  - Its technical charter was adopted 2026-03-31 (`X/foundation/`).
  - The TSC has three seats: Coinbase (Erik Reppel), Cloudflare (Rohin Lohe) and Stripe
    (Steve Kaliski) (`X/TSC.md`).
  - The GitHub org was created 2026-04-01 and has one public member.
  - The contract names `@author Coinbase` (`BS#L23`).
- **EVM spec status**: `v1.0 | 2025-04-28 | Initial draft` (`EVM#L691-L695`). The date is
  probably a typo for 2026, since the file's first commit is 2026-05-05.
  - The EVM spec has 9 commits from 2026-04-15 to 2026-09-07.
  - Recent changes are additive: an optional `minDeposit` (#3372), a `settlement_pending`
    state (#3083), and an optional facilitator `receiverAuthorizer` (#2700).
- **SVM spec status**: **draft**, and its implementation is still an open PR (§7).
- **Contract audit and churn**: Cantina reviewed commits of 2026-04-27 to -29
  ("Coinbase: x402 Batch Settlement Security Review", May 2026). It found 0 Critical and
  0 High, and 1 Medium that is fixed.
  - `x402BatchSettlement.sol` has **one commit** (x402 PR #1950, 2026-05-15). It has not
    changed since the audit fixes merged.
  - It is immutable, with no owner and no proxy.
- **Deployment**: identical code sizes on Base Sepolia and Base mainnet for all three
  contracts (live `cast code`). On Base Sepolia, `eip712Domain()` returns
  `"x402 Batch Settlement","1",84532,0x4020074e…`.
  - Base Sepolia is missing from the README's deployment table, but the code is on chain.
- **SDK**: `@x402/evm` has shipped batch-settlement since 2.12.0 (2026-05-13). The latest is
  2.27.0 (2026-09-22). The TS mechanism has had 20 commits, including storage hardening and
  ERC-6492 support.

**Assessment [I]:** the EVM contract is more mature than TOON's own `TokenNetwork`: audited,
ownerless, stable since May. The spec around it is still moving, but additively. The SVM half
is not production-ready as an x402 binding, though the underlying program is audited and
deployed.

---

## Open questions

1. **Does `swap` need two-way value on one channel?** If it does, x402 is excluded for swap
   regardless. Not researched.
2. **Would a hosted facilitator accept `batch-settlement` deposits on Base Sepolia for an
   arbitrary `payTo`, and does it offer `erc20ApprovalGasSponsoring` there?** Examples include
   CDP. Neither was checked, and CDP's terms (API key, fees) are unverified.
3. **Is a zero-`maxClaimableAmount` voucher accepted by the reference facilitator on a
   deposit-only payload?** It passes by reading (§6). It was not run.
4. **Should TOON adopt `payerAuthorizer`-style session keys independently of x402?** It is the
   one x402 feature TOON lacks and could add to its own claim.
5. **TOON's Solana program has three gaps** (§7): the rent recipient is unconstrained, a pair's
   channel can be squatted, and proofs may replay across incarnations. These are worth their
   own issues whatever happens with x402.
6. **A hybrid**: x402 on the EVM client edge only (client → connector, one-way), with peering
   and payout staying on `TokenNetwork`. That is coherent, but it reintroduces a per-edge
   backend split. Whether it is worth it depends on (2) and on how much claim batching
   saves.

## Sources

**x402** (commit `0cb1a1f0f4c2163357e255c824d319674e1db43f`)

- `contracts/evm/src/x402BatchSettlement.sol`
- `contracts/evm/src/periphery/{ERC3009DepositCollector,Permit2DepositCollector,DepositCollector}.sol`
- `contracts/evm/docs/x402-batch-settlement-implementers.md`
- `contracts/evm/README.md`
- `contracts/evm/audits/cantina_x402_may2026.pdf`
- `specs/schemes/batch-settlement/scheme_batch_settlement{,_evm,_svm}.md`
- `specs/extensions/{eip2612_gas_sponsoring,erc20_gas_sponsoring}.md`
- `specs/x402-specification-v2.md`
- `typescript/packages/mechanisms/evm/src/batch-settlement/**`
- `TSC.md`, `foundation/`
- PRs #1950, #2051, #2698, #2700, #3083, #3164 (open), #3372
- npm `@x402/evm` 2.12.0–2.27.0

**solana-foundation/payment-channels** (commit `3ffa4d6728ad88e4a9667a76ad9ccd68a302c696`)

- `program/payment_channels/src/{lib.rs,constants.rs,state/channel.rs,instructions/open.rs,instructions/helpers/voucher.rs}`

**TOON connector** (`9d48ba26`)

- `CONTEXT.md`
- `docs/adr/` 0004, 0005, 0022, 0024, 0026, 0042, 0052, 0053, 0059, 0060
- `docs/protocol/client-edge-spec.md`
- `packages/contracts/src/TokenNetwork.sol`
- `packages/contracts/test/mocks/MockERC20.sol`
- `packages/solana-program/src/processor.rs`
- `crates/connector-settlement/src/port.rs`
- `crates/connector-runtime/src/claim.rs`
- `crates/connector-domain/src/{claim.rs,x402.rs}`
- `crates/connector-signer/src/claim_signature.rs`
- `crates/connector-client-edge/src/outbound_ledger.rs`
- `crates/connector-settlement-solana/src/lib.rs`
- `crates/connector-operator/src/lib.rs`
- `crates/connector-runtime/src/connector.rs`
- `vectors/wire-vectors.json`

**Other TOON repos**

- toon-client (`e493f33`): `packages/client/src/signing/evm-signer.ts`,
  `packages/client/src/channel/evm/TokenNetworkClient.ts`
- gas-station: `README.md`
- toon-meta: `context/glossary.md` (uncommitted Onboarding, Funding Authorization and
  Onboarder entries)
- infra: [issue #23](https://github.com/toon-protocol/infra/issues/23)

**Chain reads (2026-09-24)**

- **Base Sepolia**: `cast` calls against `TokenNetwork` `0xe9E05dfe…`
  (`trustedForwarder`, `token`, `isTrustedForwarder`), mock USDC `0x49beE1Bc…` (reverting
  EIP-3009 and EIP-2612 probes), `x402BatchSettlement` (`eip712Domain`, code),
  collectors, Permit2, and Circle USDC.
- **Base mainnet**: the same x402 addresses.
- **Solana devnet and mainnet**: `getAccountInfo` on
  `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`.

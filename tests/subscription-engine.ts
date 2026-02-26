import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SubscriptionEngine } from "../target/types/subscription_engine";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("subscription-engine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SubscriptionEngine as Program<SubscriptionEngine>;

  const merchant = Keypair.generate();
  const subscriber = Keypair.generate();
  const planId = 1;
  const amountLamports = new anchor.BN(10_000_000); // 0.01 SOL
  const intervalSecs = new anchor.BN(60); // 1 min for testing

  let planPda: PublicKey;
  let subscriptionPda: PublicKey;
  let merchantPk: PublicKey;

  before(async () => {
    const airdrop = await provider.connection.requestAirdrop(
      merchant.publicKey,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop);
    const airdrop2 = await provider.connection.requestAirdrop(
      subscriber.publicKey,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop2);
    merchantPk = merchant.publicKey;
    [planPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("plan"),
        merchant.publicKey.toBuffer(),
        Buffer.from(new Uint16Array([planId]).buffer),
      ],
      program.programId
    );
    [subscriptionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("subscription"),
        subscriber.publicKey.toBuffer(),
        planPda.toBuffer(),
      ],
      program.programId
    );
  });

  it("creates a plan", async () => {
    const tx = await program.methods
      .createPlan(planId, amountLamports, intervalSecs, "Test Plan")
      .accounts({
        plan: planPda,
        merchant: merchant.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([merchant])
      .rpc();
    expect(tx).to.be.a("string");
    const plan = await program.account.plan.fetch(planPda);
    expect(plan.name).to.equal("Test Plan");
    expect(plan.amountLamports.toString()).to.equal(amountLamports.toString());
    expect(plan.intervalSecs.toString()).to.equal(intervalSecs.toString());
    expect(plan.active).to.be.true;
  });

  it("creates a subscription and pays first period", async () => {
    const balBefore = await provider.connection.getBalance(merchant.publicKey);
    const tx = await program.methods
      .createSubscription()
      .accounts({
        subscription: subscriptionPda,
        subscriber: subscriber.publicKey,
        plan: planPda,
        merchant: merchant.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([subscriber])
      .rpc();
    expect(tx).to.be.a("string");
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.status).to.equal(0); // Active
    const balAfter = await provider.connection.getBalance(merchant.publicKey);
    expect(balAfter - balBefore).to.equal(amountLamports.toNumber());
  });

  it("check_access grants access when subscription is active and not expired", async () => {
    const tx = await program.methods
      .checkAccess()
      .accounts({ subscription: subscriptionPda })
      .rpc();
    expect(tx).to.be.a("string");
  });

  it("renew fails before next_billing_at", async () => {
    try {
      await program.methods
        .renew()
        .accounts({
          subscription: subscriptionPda,
          subscriber: subscriber.publicKey,
          plan: planPda,
          merchant: merchant.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([subscriber])
        .rpc();
      expect.fail("renew should fail");
    } catch (e: unknown) {
      const err = e as { message?: string };
      const msg = (err.message || "").toLowerCase();
      expect(msg).to.satisfy((m: string) => m.includes("renewal") && m.includes("early"), "expected RenewalTooEarly error");
    }
  });

  it("cancels subscription", async () => {
    const tx = await program.methods
      .cancel()
      .accounts({
        subscription: subscriptionPda,
        subscriber: subscriber.publicKey,
        plan: planPda,
      })
      .signers([subscriber])
      .rpc();
    expect(tx).to.be.a("string");
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.status).to.equal(1); // Cancelled
  });

  it("check_access fails when subscription is cancelled", async () => {
    try {
      await program.methods
        .checkAccess()
        .accounts({ subscription: subscriptionPda })
        .rpc();
      expect.fail("check_access should fail when cancelled");
    } catch (e: unknown) {
      const err = e as { message?: string };
      const msg = (err.message || "").toLowerCase();
      expect(msg).to.satisfy(
        (m: string) => m.includes("expired") || m.includes("inactive") || m.includes("notactive") || m.includes("subscription"),
        "expected subscription expired or inactive error"
      );
    }
  });
});

import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import idl from '../idl/subscription_engine.json';

const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export function getPlanPda(merchant: PublicKey, planId: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('plan'),
      merchant.toBuffer(),
      Buffer.from(new Uint16Array([planId]).buffer),
    ],
    PROGRAM_ID
  );
  return pda;
}

export function getSubscriptionPda(subscriber: PublicKey, plan: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('subscription'), subscriber.toBuffer(), plan.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProgram(provider: AnchorProvider): Program<any> {
  return new Program(idl as any, provider);
}

export { PROGRAM_ID };

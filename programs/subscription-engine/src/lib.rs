use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("CA9TkuW8WjA7q53piQgG7tYGw3DkZG7tMXoK8aDPxtRM");

#[program]
pub mod subscription_engine {
    use super::*;

    /// Create a billing plan (merchant only).
    pub fn create_plan(
        ctx: Context<CreatePlan>,
        plan_id: u16,
        amount_lamports: u64,
        interval_secs: i64,
        name: String,
    ) -> Result<()> {
        require!(interval_secs > 0, SubscriptionError::InvalidInterval);
        require!(name.len() <= 64, SubscriptionError::NameTooLong);
        let plan = &mut ctx.accounts.plan;
        plan.merchant = ctx.accounts.merchant.key();
        plan.plan_id = plan_id;
        plan.amount_lamports = amount_lamports;
        plan.interval_secs = interval_secs;
        plan.name = name;
        plan.active = true;
        plan.bump = ctx.bumps.plan;
        Ok(())
    }

    /// Subscribe to a plan (first period paid at creation).
    pub fn create_subscription(ctx: Context<CreateSubscription>) -> Result<()> {
        let plan = &ctx.accounts.plan;
        require!(plan.active, SubscriptionError::PlanInactive);

        let clock = Clock::get()?;
        let next_billing_at = clock.unix_timestamp + plan.interval_secs;

        let subscription = &mut ctx.accounts.subscription;
        subscription.subscriber = ctx.accounts.subscriber.key();
        subscription.plan = ctx.accounts.plan.key();
        subscription.amount_lamports = plan.amount_lamports;
        subscription.interval_secs = plan.interval_secs;
        subscription.next_billing_at = next_billing_at;
        subscription.started_at = clock.unix_timestamp;
        subscription.status = 0; // Active
        subscription.auto_renew = true;
        subscription.bump = ctx.bumps.subscription;

        // First period: transfer from subscriber to merchant
        let transfer_ix = system_program::Transfer {
            from: ctx.accounts.subscriber.to_account_info(),
            to: ctx.accounts.merchant.to_account_info(),
        };
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                transfer_ix,
            ),
            plan.amount_lamports,
        )?;

        Ok(())
    }

    /// Renew subscription when current time >= next_billing_at.
    pub fn renew(ctx: Context<Renew>) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;
        require!(subscription.status == 0, SubscriptionError::NotActive); // 0 = Active

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= subscription.next_billing_at,
            SubscriptionError::RenewalTooEarly
        );

        let plan = &ctx.accounts.plan;
        require!(plan.active, SubscriptionError::PlanInactive);

        // Transfer from subscriber to merchant
        let transfer_ix = system_program::Transfer {
            from: ctx.accounts.subscriber.to_account_info(),
            to: ctx.accounts.merchant.to_account_info(),
        };
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                transfer_ix,
            ),
            plan.amount_lamports,
        )?;

        subscription.next_billing_at = subscription
            .next_billing_at
            .checked_add(subscription.interval_secs)
            .ok_or(SubscriptionError::Overflow)?;

        Ok(())
    }

    /// Cancel subscription (no refund).
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;
        require!(subscription.status == 0, SubscriptionError::NotActive); // 0 = Active
        subscription.status = 1; // Cancelled
        Ok(())
    }

    /// Deactivate a plan (merchant only). No new subscriptions; existing can renew until closed.
    pub fn deactivate_plan(ctx: Context<DeactivatePlan>) -> Result<()> {
        ctx.accounts.plan.active = false;
        Ok(())
    }

    /// Close a plan (merchant only). Reclaims rent to merchant. Plan must be inactive.
    pub fn close_plan(ctx: Context<ClosePlan>, _plan_id: u16) -> Result<()> {
        let plan = &ctx.accounts.plan;
        require!(!plan.active, SubscriptionError::PlanStillActive);
        Ok(())
    }

    /// Close a cancelled subscription. Reclaims rent to subscriber.
    pub fn close_subscription(ctx: Context<CloseSubscription>) -> Result<()> {
        let subscription = &ctx.accounts.subscription;
        require!(subscription.status == 1, SubscriptionError::NotActive);
        Ok(())
    }

    /// Trustless access check: anyone can call to verify a subscription is active and not expired.
    /// Fails with SubscriptionExpired if status != Active or current time >= next_billing_at (period end).
    pub fn check_access(ctx: Context<CheckAccess>) -> Result<()> {
        let subscription = &ctx.accounts.subscription;
        require!(subscription.status == 0, SubscriptionError::SubscriptionExpired); // 0 = Active
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < subscription.next_billing_at,
            SubscriptionError::SubscriptionExpired
        );
        msg!("Access granted");
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionStatus {
    Active,
    Cancelled,
}

impl Default for SubscriptionStatus {
    fn default() -> Self {
        SubscriptionStatus::Active
    }
}

#[derive(Accounts)]
#[instruction(plan_id: u16)]
pub struct CreatePlan<'info> {
    #[account(
        init,
        payer = merchant,
        space = 8 + Plan::INIT_SPACE,
        seeds = [b"plan", merchant.key().as_ref(), &plan_id.to_le_bytes()],
        bump
    )]
    pub plan: Account<'info, Plan>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSubscription<'info> {
    #[account(
        init,
        payer = subscriber,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [b"subscription", subscriber.key().as_ref(), plan.key().as_ref()],
        bump
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    #[account(constraint = plan.merchant == merchant.key())]
    pub plan: Account<'info, Plan>,

    /// CHECK: validated by plan.merchant
    #[account(mut)]
    pub merchant: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Renew<'info> {
    #[account(
        mut,
        seeds = [b"subscription", subscriber.key().as_ref(), plan.key().as_ref()],
        bump = subscription.bump,
        constraint = subscription.subscriber == subscriber.key()
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    #[account(constraint = plan.merchant == merchant.key())]
    pub plan: Account<'info, Plan>,

    /// CHECK: validated by plan.merchant
    #[account(mut)]
    pub merchant: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckAccess<'info> {
    #[account(
        seeds = [b"subscription", subscription.subscriber.as_ref(), subscription.plan.as_ref()],
        bump = subscription.bump
    )]
    pub subscription: Account<'info, Subscription>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(
        mut,
        seeds = [b"subscription", subscriber.key().as_ref(), plan.key().as_ref()],
        bump = subscription.bump,
        constraint = subscription.subscriber == subscriber.key()
    )]
    pub subscription: Account<'info, Subscription>,

    pub subscriber: Signer<'info>,

    pub plan: Account<'info, Plan>,
}

#[derive(Accounts)]
#[instruction(plan_id: u16)]
pub struct DeactivatePlan<'info> {
    #[account(
        mut,
        seeds = [b"plan", merchant.key().as_ref(), &plan_id.to_le_bytes()],
        bump = plan.bump,
        constraint = plan.merchant == merchant.key()
    )]
    pub plan: Account<'info, Plan>,

    pub merchant: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(plan_id: u16)]
pub struct ClosePlan<'info> {
    #[account(
        mut,
        close = merchant,
        seeds = [b"plan", merchant.key().as_ref(), &plan_id.to_le_bytes()],
        bump = plan.bump,
        constraint = plan.merchant == merchant.key()
    )]
    pub plan: Account<'info, Plan>,

    #[account(mut)]
    pub merchant: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseSubscription<'info> {
    #[account(
        mut,
        close = subscriber,
        seeds = [b"subscription", subscriber.key().as_ref(), plan.key().as_ref()],
        bump = subscription.bump,
        constraint = subscription.subscriber == subscriber.key()
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    pub plan: Account<'info, Plan>,
}

#[account]
#[derive(InitSpace)]
pub struct Plan {
    pub merchant: Pubkey,
    pub plan_id: u16,
    pub amount_lamports: u64,
    pub interval_secs: i64,
    #[max_len(64)]
    pub name: String,
    pub active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Subscription {
    pub subscriber: Pubkey,
    pub plan: Pubkey,
    pub amount_lamports: u64,
    pub interval_secs: i64,
    pub next_billing_at: i64, // period end (expires_at semantics for access check)
    pub started_at: i64,
    pub status: u8, // 0 = Active, 1 = Cancelled
    pub auto_renew: bool,
    pub bump: u8,
}

#[error_code]
pub enum SubscriptionError {
    #[msg("Billing interval must be greater than zero")]
    InvalidInterval,
    #[msg("This plan is no longer accepting subscriptions")]
    PlanInactive,
    #[msg("Deactivate the plan first, then close it to reclaim rent")]
    PlanStillActive,
    #[msg("This subscription is not active (cancelled or closed)")]
    NotActive,
    #[msg("Wait until your next billing date to renew. Check My Subscriptions for the date.")]
    RenewalTooEarly,
    #[msg("An overflow occurred. Please try again.")]
    Overflow,
    #[msg("Subscription has expired or is inactive")]
    SubscriptionExpired,
    #[msg("Plan name must be 64 characters or less")]
    NameTooLong,
}

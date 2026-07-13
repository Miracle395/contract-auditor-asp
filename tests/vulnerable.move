module vulnerable_addr::vulnerable_vault {
    use sui::object::{Self, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;

    struct AdminCap has key, store {
        id: UID,
    }

    struct Vault has key {
        id: UID,
        balance: u64,
    }

    // Bug: capability leaked to caller instead of kept with deployer
    public fun init(ctx: &mut TxContext) {
        let admin_cap = AdminCap { id: object::new(ctx) };
        transfer::public_transfer(admin_cap, tx_context::sender(ctx));
    }

    // Bug: should be `entry fun`, marked `public fun` instead,
    // allowing composition that bypasses intended call flow
    public fun withdraw(vault: &mut Vault, amount: u64, ctx: &mut TxContext) {
        vault.balance = vault.balance - amount;
    }

    // Bug: positional argument order mismatch vs how off-chain client
    // constructs the call (amount and recipient swapped relative to docs)
    public fun transfer_funds(vault: &mut Vault, recipient: address, amount: u64, ctx: &mut TxContext) {
        vault.balance = vault.balance - amount;
    }

    // Bug: no verification the caller actually holds AdminCap
    public fun admin_set_balance(vault: &mut Vault, new_balance: u64) {
        vault.balance = new_balance;
    }
}
